/**
 * task-schema-v2.mjs 的单元测试。
 * 全部使用 fake fsImpl / exec，不触碰真实文件系统或子进程。
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import {
  TASK_SCHEMA_V2,
  validateTask,
  validateResultText,
  validateResult,
  runAcceptanceScript,
  buildInvocation,
  classifyTaskRecovery,
  recoveryAction,
  summarizeValidation,
} from "../lib/task-schema-v2.mjs";

/** 构造一个基于内存 Map 的 fake fsImpl：files 的 key 是路径，value 是文件内容。 */
function makeFakeFs(files) {
  const map = new Map(Object.entries(files));
  return {
    async exists(p) {
      return map.has(p);
    },
    async readFile(p) {
      if (!map.has(p)) {
        const err = new Error(`ENOENT: no such file, open '${p}'`);
        err.code = "ENOENT";
        throw err;
      }
      return map.get(p);
    },
  };
}

const TASK_DIR = "/mnt/d/cc-tasks/tasks/fake-task";

function validTask(overrides = {}) {
  return {
    taskId: "fake-task",
    kind: "implement",
    title: "示例任务",
    prompt: "做点什么",
    ...overrides,
  };
}

// ---------- TASK_SCHEMA_V2 ----------

test("TASK_SCHEMA_V2 导出齐全且字段描述完整", () => {
  const keys = Object.keys(TASK_SCHEMA_V2);
  for (const k of [
    "taskId",
    "kind",
    "title",
    "prompt",
    "refs",
    "acceptance",
    "outputDir",
    "expectArtifacts",
    "doneFlag",
  ]) {
    assert.ok(keys.includes(k), `缺少字段 ${k}`);
    assert.equal(typeof TASK_SCHEMA_V2[k].description, "string");
  }
});

// ---------- validateTask ----------

test("validateTask: 合法完整 task 通过", () => {
  const { ok, errors } = validateTask(
    validTask({
      refs: ["a.md"],
      acceptance: "跑通即可",
      outputDir: "out",
      expectArtifacts: ["result.txt"],
      doneFlag: "done.flag",
    })
  );
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test("validateTask: 非法 taskId（含空格）报错", () => {
  const { ok, errors } = validateTask(validTask({ taskId: "bad id!" }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("taskId")));
});

test("validateTask: taskId 缺失报错", () => {
  const task = validTask();
  delete task.taskId;
  const { ok, errors } = validateTask(task);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("taskId")));
});

test("validateTask: kind 缺失按 v1 语义容错，不报错", () => {
  const task = validTask();
  delete task.kind;
  const { ok, errors } = validateTask(task);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test("validateTask: kind 非法值报错", () => {
  const { ok, errors } = validateTask(validTask({ kind: "not-a-kind" }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("kind")));
});

test("validateTask: prompt 为空字符串报错", () => {
  const { ok, errors } = validateTask(validTask({ prompt: "   " }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("prompt")));
});

test("validateTask: title 缺失报错", () => {
  const task = validTask();
  delete task.title;
  const { ok, errors } = validateTask(task);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("title")));
});

test("validateTask: outputDir 绝对路径越界报错", () => {
  const { ok, errors } = validateTask(
    validTask({ outputDir: "/mnt/d/cc-tasks/tasks/other/out" })
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("outputDir")));
});

test("validateTask: outputDir 含 .. 越界报错", () => {
  const { ok, errors } = validateTask(validTask({ outputDir: "../escape" }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("outputDir")));
});

test("validateTask: expectArtifacts 含空字符串元素报错", () => {
  const { ok, errors } = validateTask(
    validTask({ expectArtifacts: ["ok.txt", "  "] })
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("expectArtifacts[1]")));
});

test("validateTask: doneFlag 含路径分隔符报错（禁止指向 out/ 子目录）", () => {
  const { ok, errors } = validateTask(validTask({ doneFlag: "out/done.flag" }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("doneFlag")));
});

test("validateTask: 接受 JSON 文本作为输入", () => {
  const { ok } = validateTask(JSON.stringify(validTask()));
  assert.equal(ok, true);
});

test("validateTask: 非法 JSON 文本报错", () => {
  const { ok, errors } = validateTask("{ not json");
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("JSON")));
});

// ---------- validateResultText ----------

test("validateResultText: 合法 done 结果通过", () => {
  const { ok, errors } = validateResultText(
    JSON.stringify({ status: "done", exit: 0 })
  );
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test("validateResultText: failed 缺 reason 报错", () => {
  const { ok, errors } = validateResultText(
    JSON.stringify({ status: "failed", exit: 1 })
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("reason")));
});

test("validateResultText: status 非法值报错", () => {
  const { ok, errors } = validateResultText(JSON.stringify({ status: "oops" }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("status")));
});

test("validateResultText: exit 非整数报错", () => {
  const { ok, errors } = validateResultText(
    JSON.stringify({ status: "done", exit: "0" })
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("exit")));
});

// ---------- validateResult ----------

test("validateResult: done.flag 在任务根目录 → doneFlagAtRoot=true", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, 'done.flag')]: "",
    [path.join(TASK_DIR, 'result.json')]: JSON.stringify({ status: "done", exit: 0 }),
  });
  const { ok, errors, details } = await validateResult({
    taskDir: TASK_DIR,
    task: validTask(),
    fsImpl,
  });
  assert.equal(details.doneFlagAtRoot, true);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test("validateResult: done.flag 误放 out/ 目录 → 报 misplaced（核心回归）", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, 'out', 'done.flag')]: "",
    [path.join(TASK_DIR, 'result.json')]: JSON.stringify({ status: "done", exit: 0 }),
  });
  const { ok, errors, details } = await validateResult({
    taskDir: TASK_DIR,
    task: validTask(),
    fsImpl,
  });
  assert.equal(details.doneFlagAtRoot, false);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("misplaced") && e.includes("out/")));
});

test("validateResult: done.flag 两处都不存在 → 报 missing", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, 'result.json')]: JSON.stringify({ status: "done", exit: 0 }),
  });
  const { ok, errors, details } = await validateResult({
    taskDir: TASK_DIR,
    task: validTask(),
    fsImpl,
  });
  assert.equal(details.doneFlagAtRoot, false);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("done.flag missing")));
});

test("validateResult: result.json 缺失 → ok=false 且 resultPending=true", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, 'done.flag')]: "",
  });
  const { ok, errors, details } = await validateResult({
    taskDir: TASK_DIR,
    task: validTask(),
    fsImpl,
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("result.json missing")));
  assert.equal(details.resultPending, true);
});

test("validateResult: result.json 结构非法 → 报错并带 result.json: 前缀", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, 'done.flag')]: "",
    [path.join(TASK_DIR, 'result.json')]: JSON.stringify({ status: "failed" }),
  });
  const { ok, errors } = await validateResult({
    taskDir: TASK_DIR,
    task: validTask(),
    fsImpl,
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.startsWith("result.json:") && e.includes("reason")));
});

test("validateResult: expectArtifacts 全部存在 → ok true 且 details.artifacts 标注存在", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, 'done.flag')]: "",
    [path.join(TASK_DIR, 'result.json')]: JSON.stringify({ status: "done", exit: 0 }),
    [path.join(TASK_DIR, 'out', 'report.txt')]: "hi",
  });
  const { ok, errors, details } = await validateResult({
    taskDir: TASK_DIR,
    task: validTask({ expectArtifacts: ["report.txt"] }),
    fsImpl,
  });
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(details.artifacts, [{ name: "report.txt", exists: true }]);
});

test("validateResult: expectArtifacts 缺失 → 报 missing artifact", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, 'done.flag')]: "",
    [path.join(TASK_DIR, 'result.json')]: JSON.stringify({ status: "done", exit: 0 }),
  });
  const { ok, errors, details } = await validateResult({
    taskDir: TASK_DIR,
    task: validTask({ expectArtifacts: ["report.txt"] }),
    fsImpl,
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("missing artifact: report.txt")));
  assert.deepEqual(details.artifacts, [{ name: "report.txt", exists: false }]);
});

test("validateResult: 自定义 outputDir 时 expectArtifacts 相对该目录解析", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, 'done.flag')]: "",
    [path.join(TASK_DIR, 'result.json')]: JSON.stringify({ status: "done", exit: 0 }),
    [path.join(TASK_DIR, 'custom', 'report.txt')]: "hi",
  });
  const { ok, details } = await validateResult({
    taskDir: TASK_DIR,
    task: validTask({ outputDir: "custom", expectArtifacts: ["report.txt"] }),
    fsImpl,
  });
  assert.equal(ok, true);
  assert.deepEqual(details.artifacts, [{ name: "report.txt", exists: true }]);
});

// ---------- runAcceptanceScript ----------
//
// 两种形态：
//   ① 脚本 token（单 token、无空白/无 shell 元字符、以 .mjs/.cjs/.js 结尾）→ node 执行，
//      相对路径按 仓库根 → 任务目录 顺序解析，taskId 作为第一个参数传入。
//   ② 命令形态（其余情况）→ 保持 /bin/sh -c 语义，不得回归。
// 三类结局：exit 0 → kind "ok"；exit 1..126 → kind "fail"（错误带 [FAIL] 标记）；
//   ENOENT/127/超时/无法启动 → kind "instrument"（错误带 [INSTRUMENT] 标记）。

/** 建一个临时目录夹具：{ repoRoot, taskDir }（各自独立子目录，模拟仓库根与任务目录）。 */
function makeFixtureDirs() {
  const root = mkdtempSync(path.join(os.tmpdir(), "tsv2-fixture-"));
  const repoRoot = path.join(root, "repo");
  const taskDir = path.join(root, "task");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  return { root, repoRoot, taskDir };
}

test("runAcceptanceScript: 命令形态（其余情况）走 /bin/sh -c，不回归", () => {
  const calls = [];
  const exec = (invocation) => {
    calls.push(invocation);
    return { status: 0, signal: null };
  };
  const { ok, kind, error } = runAcceptanceScript({
    script: "echo hi",
    cwd: "/tmp",
    taskId: "tid-cmd",
    repoRoot: "/repo",
    exec,
  });
  assert.equal(ok, true);
  assert.equal(kind, "ok");
  assert.equal(error, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/bin/sh");
  assert.deepEqual(calls[0].args, ["-c", "echo hi"]);
  assert.equal(calls[0].cwd, path.resolve("/tmp"));
});

test("runAcceptanceScript: 命令形态 exit 1..126（探针跑完给出否定）→ kind fail 带 [FAIL] 标记", () => {
  const exec = () => ({ status: 1, signal: null, stderr: "assertion failed" });
  const { ok, kind, error } = runAcceptanceScript({ script: "exit 1", cwd: "/tmp", exec });
  assert.equal(ok, false);
  assert.equal(kind, "fail");
  assert.ok(error.startsWith("[acceptance-script][FAIL]"));
  assert.ok(error.includes("assertion failed"));
});

test("runAcceptanceScript: script 为空字符串 → kind instrument，不调用 exec", () => {
  let called = false;
  const exec = () => {
    called = true;
    return { status: 0 };
  };
  const { ok, kind, error } = runAcceptanceScript({ script: "  ", exec });
  assert.equal(ok, false);
  assert.equal(kind, "instrument");
  assert.equal(called, false);
  assert.ok(error.startsWith("[acceptance-script][INSTRUMENT]"));
  assert.ok(error.includes("script"));
});

test("runAcceptanceScript: 两种形态都向子进程注入 DSH_TASK_ID/DSH_TASK_DIR/DSH_REPO", () => {
  const calls = [];
  const exec = (invocation) => {
    calls.push(invocation);
    return { status: 0 };
  };
  runAcceptanceScript({ script: "echo hi", cwd: "/tmp/taskdir", taskId: "tid-env", repoRoot: "/tmp/repo", exec });
  assert.equal(calls[0].env.DSH_TASK_ID, "tid-env");
  assert.equal(calls[0].env.DSH_TASK_DIR, path.resolve("/tmp/taskdir"));
  assert.equal(calls[0].env.DSH_REPO, path.resolve("/tmp/repo"));
});

test("runAcceptanceScript: 脚本 token 形态真实执行 node，exit 0 → ok true，探针能读到 taskId 参数与 DSH_TASK_ID", () => {
  const { root, repoRoot, taskDir } = makeFixtureDirs();
  try {
    const probePath = path.join(taskDir, "probe.mjs");
    writeFileSync(
      probePath,
      "const okArg = process.argv[2] === 'tid-real-1';\n" +
        "const okEnv = process.env.DSH_TASK_ID === 'tid-real-1';\n" +
        "process.exit(okArg && okEnv ? 0 : 1);\n",
      "utf8"
    );
    const { ok, kind, error } = runAcceptanceScript({
      script: "probe.mjs",
      cwd: taskDir,
      taskId: "tid-real-1",
      repoRoot,
    });
    assert.equal(ok, true);
    assert.equal(kind, "ok");
    assert.equal(error, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runAcceptanceScript: 脚本 token 相对路径优先命中仓库根", () => {
  const { root, repoRoot, taskDir } = makeFixtureDirs();
  try {
    mkdirSync(path.join(repoRoot, "probes"), { recursive: true });
    writeFileSync(path.join(repoRoot, "probes", "p.mjs"), "process.exit(0);\n", "utf8");
    const { ok, kind } = runAcceptanceScript({ script: "probes/p.mjs", cwd: taskDir, taskId: "t1", repoRoot });
    assert.equal(ok, true);
    assert.equal(kind, "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runAcceptanceScript: 脚本 token 相对路径回退命中任务目录（仓库根没有）", () => {
  const { root, repoRoot, taskDir } = makeFixtureDirs();
  try {
    mkdirSync(path.join(taskDir, "probes"), { recursive: true });
    writeFileSync(path.join(taskDir, "probes", "p.mjs"), "process.exit(0);\n", "utf8");
    const { ok, kind } = runAcceptanceScript({ script: "probes/p.mjs", cwd: taskDir, taskId: "t1", repoRoot });
    assert.equal(ok, true);
    assert.equal(kind, "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runAcceptanceScript: 脚本 token 真实执行非 0 退出（1..126）→ kind fail", () => {
  const { root, repoRoot, taskDir } = makeFixtureDirs();
  try {
    writeFileSync(path.join(taskDir, "fail.mjs"), "process.exit(3);\n", "utf8");
    const { ok, kind, error } = runAcceptanceScript({ script: "fail.mjs", cwd: taskDir, taskId: "t1", repoRoot });
    assert.equal(ok, false);
    assert.equal(kind, "fail");
    assert.ok(error.startsWith("[acceptance-script][FAIL]"));
    assert.ok(error.includes("3"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runAcceptanceScript: 脚本 token 指向不存在文件 → kind instrument 且错误列出尝试过的绝对路径", () => {
  const { root, repoRoot, taskDir } = makeFixtureDirs();
  try {
    const { ok, kind, error } = runAcceptanceScript({ script: "no-such-probe.mjs", cwd: taskDir, taskId: "t1", repoRoot });
    assert.equal(ok, false);
    assert.equal(kind, "instrument");
    assert.ok(error.startsWith("[acceptance-script][INSTRUMENT]"));
    assert.ok(error.includes(path.join(repoRoot, "no-such-probe.mjs")));
    assert.ok(error.includes(path.join(taskDir, "no-such-probe.mjs")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "runAcceptanceScript: 命令形态命令不存在（真实 shell exit 127）→ kind instrument",
  { skip: process.platform === "win32" ? "仅 POSIX 有 /bin/sh，win32 下命令形态被 buildInvocation 明确拒绝，不会走到真实 spawn" : false },
  () => {
    const { ok, kind, error } = runAcceptanceScript({
      script: "definitely-not-a-real-command-xyz123",
      cwd: "/tmp",
      taskId: "t1",
    });
    assert.equal(ok, false);
    assert.equal(kind, "instrument");
    assert.ok(error.startsWith("[acceptance-script][INSTRUMENT]"));
    assert.ok(error.includes("127"));
  }
);

// ---------- buildInvocation（纯函数：命令形态平台分派，platform 为注入参数）----------

test("buildInvocation: posix（非 win32）→ { ok:true, command:'/bin/sh', args:['-c', script] }", () => {
  for (const platform of ["linux", "darwin", "freebsd"]) {
    const invocation = buildInvocation({ script: "echo hi", platform });
    assert.equal(invocation.ok, true);
    assert.equal(invocation.command, "/bin/sh");
    assert.deepEqual(invocation.args, ["-c", "echo hi"]);
  }
});

test("buildInvocation: win32 → { ok:false, kind:'instrument' }，错误信息含不受支持 + 脚本 token 提示", () => {
  const invocation = buildInvocation({ script: "echo hi", platform: "win32" });
  assert.equal(invocation.ok, false);
  assert.equal(invocation.kind, "instrument");
  assert.ok(invocation.error.startsWith("[acceptance-script][INSTRUMENT]"));
  assert.ok(invocation.error.includes("win32"));
  assert.ok(invocation.error.includes("不受支持"));
  assert.ok(invocation.error.includes("脚本 token"));
});

// ---------- runAcceptanceScript × 注入 platform（跨平台确定性覆盖，不依赖真实运行平台）----------

test("runAcceptanceScript: 注入 platform='win32' + 命令形态 → kind instrument，不调用 exec（不 spawn /bin/sh）", () => {
  let called = false;
  const exec = () => {
    called = true;
    return { status: 0 };
  };
  const { ok, kind, error } = runAcceptanceScript({
    script: "echo hi",
    cwd: "/tmp",
    taskId: "t1",
    platform: "win32",
    exec,
  });
  assert.equal(ok, false);
  assert.equal(kind, "instrument");
  assert.equal(called, false);
  assert.ok(error.startsWith("[acceptance-script][INSTRUMENT]"));
  assert.ok(error.includes("不受支持"));
  assert.ok(error.includes("脚本 token"));
});

test("runAcceptanceScript: 注入 platform='linux' + 命令形态 → invocation 为 { command:'/bin/sh', args:['-c', script] }", () => {
  const calls = [];
  const exec = (invocation) => {
    calls.push(invocation);
    return { status: 0, signal: null };
  };
  const { ok, kind } = runAcceptanceScript({
    script: "echo from-linux",
    cwd: "/tmp",
    taskId: "t1",
    platform: "linux",
    exec,
  });
  assert.equal(ok, true);
  assert.equal(kind, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/bin/sh");
  assert.deepEqual(calls[0].args, ["-c", "echo from-linux"]);
});

test("runAcceptanceScript: 注入 platform='win32' 时脚本 token 形态不受影响（两平台都可用）", () => {
  const { root, repoRoot, taskDir } = makeFixtureDirs();
  try {
    writeFileSync(path.join(taskDir, "probe.mjs"), "process.exit(0);\n", "utf8");
    const { ok, kind } = runAcceptanceScript({ script: "probe.mjs", cwd: taskDir, taskId: "t1", repoRoot, platform: "win32" });
    assert.equal(ok, true);
    assert.equal(kind, "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- s2v2_1: ErrorCode 分类 ----
test("导出常量 RESULT_ERROR_CODES / DONE_FLAG_ERROR_CODES", async () => {
  const m = await import("../lib/task-schema-v2.mjs");
  assert.deepEqual(m.RESULT_ERROR_CODES, ["result-missing", "result-corrupt", "result-invalid"]);
  assert.deepEqual(m.DONE_FLAG_ERROR_CODES, ["done-flag-misplaced", "done-flag-missing"]);
});

test("errorCode: result.json 缺失 → result-missing（details + 前缀）", async () => {
  const fsImpl = makeFakeFs({ [path.join(TASK_DIR, "done.flag")]: "" });
  const { ok, errors, details } = await validateResult({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(ok, false);
  assert.equal(details.resultErrorCode, "result-missing");
  assert.ok(errors.some((e) => e.startsWith("[result-missing]")));
});

test("errorCode: result.json 坏 JSON → result-corrupt", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: "{bad json",
  });
  const { ok, errors, details } = await validateResult({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(ok, false);
  assert.equal(details.resultErrorCode, "result-corrupt");
  assert.ok(errors.some((e) => e.includes("[result-corrupt]")));
});

test("errorCode: result.json 结构非法 → result-invalid", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "bogus" }),
  });
  const { ok, errors, details } = await validateResult({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(ok, false);
  assert.equal(details.resultErrorCode, "result-invalid");
});

test("errorCode: done.flag 误放 out/ → done-flag-misplaced；双缺 → done-flag-missing", async () => {
  const outOnly = makeFakeFs({ [path.join(TASK_DIR, "out", "done.flag")]: "", [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }) });
  const r1 = await validateResult({ taskDir: TASK_DIR, task: validTask(), fsImpl: outOnly });
  assert.equal(r1.details.doneFlagErrorCode, "done-flag-misplaced");
  const none = makeFakeFs({ [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }) });
  const r2 = await validateResult({ taskDir: TASK_DIR, task: validTask(), fsImpl: none });
  assert.equal(r2.details.doneFlagErrorCode, "done-flag-missing");
});

test("errorCode: 合法 result → resultErrorCode/doneFlagErrorCode null", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }),
  });
  const { ok, details } = await validateResult({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(ok, true);
  assert.equal(details.resultErrorCode, null);
  assert.equal(details.doneFlagErrorCode, null);
});

// ---- s2v3_1: review 任务 expectArtifacts 自动兜底 ----
test("s2v3_1: kind=review 无 expectArtifacts → 默认校验 out/review.md（缺 → missing artifact）", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }),
    // 无 out/review.md
  });
  const { ok, errors, details } = await validateResult({ taskDir: TASK_DIR, task: validTask({ kind: "review" }), fsImpl });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("missing artifact: review.md")));
  assert.ok(details.artifacts.some((a) => a.name === "review.md" && a.exists === false));
});

test("s2v3_1: review 任务 out/review.md 存在 → 通过；非 review 不受默认产物影响", async () => {
  const withReview = makeFakeFs({
    [path.join(TASK_DIR, "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }),
    [path.join(TASK_DIR, "out", "review.md")]: "VERDICT: APPROVED",
  });
  const r1 = await validateResult({ taskDir: TASK_DIR, task: validTask({ kind: "review" }), fsImpl: withReview });
  assert.equal(r1.ok, true);
  const noReview = makeFakeFs({
    [path.join(TASK_DIR, "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }),
  });
  const r2 = await validateResult({ taskDir: TASK_DIR, task: validTask({ kind: "implement" }), fsImpl: noReview });
  assert.equal(r2.ok, true);
});

// ---- s2v3_2: PENDING 消误报 ----
test("s2v3_2: 无 result.json（执行中）且无 done.flag → 不报 done-flag-missing（pending 语义）", async () => {
  const fsImpl = makeFakeFs({}); // 空任务目录 = 执行中
  const { errors, details } = await validateResult({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(details.doneFlagErrorCode, null);
  assert.ok(!errors.some((e) => e.includes("done-flag-missing")));
  assert.ok(errors.some((e) => e.includes("result-missing"))); // result 缺失仍提示
});

test("s2v3_2: 有 result.json 但 done.flag 双缺 → 仍报 done-flag-missing（任务已结束）", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }),
  });
  const { errors, details } = await validateResult({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(details.doneFlagErrorCode, "done-flag-missing");
});

test("s2v3_2: 执行中 done.flag 误放 out/ → 仍报 misplaced（契约违例不因 pending 豁免）", async () => {
  const fsImpl = makeFakeFs({ [path.join(TASK_DIR, "out", "done.flag")]: "" });
  const { errors, details } = await validateResult({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(details.doneFlagErrorCode, "done-flag-misplaced");
  assert.ok(errors.some((e) => e.includes("misplaced")));
});

// s2v3_1 补强（Refactor 意见：未定义 vs 显式 [] 语义区分）
test("s2v3_1: kind=review 显式 expectArtifacts:[] → 不自动注入（尊重显式空）", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }),
  });
  const r = await validateResult({ taskDir: TASK_DIR, task: validTask({ kind: "review", expectArtifacts: [] }), fsImpl });
  assert.equal(r.ok, true); // 显式 [] = 用户明确不要产物校验
  assert.equal(r.details.artifacts.length, 0);
});

test("s2v3_1: kind=review 未定义 expectArtifacts 与显式 [] 语义不同（未定义 → 注入 review.md）", async () => {
  const undef = makeFakeFs({
    [path.join(TASK_DIR, "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }),
  });
  const r1 = await validateResult({ taskDir: TASK_DIR, task: validTask({ kind: "review" }), fsImpl: undef });
  assert.equal(r1.ok, false); // 未定义 → 注入 review.md → 缺产物失败
  assert.ok(r1.details.artifacts.some((a) => a.name === "review.md" && a.exists === false));
  const empty = makeFakeFs({
    [path.join(TASK_DIR, "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }),
  });
  const r2 = await validateResult({ taskDir: TASK_DIR, task: validTask({ kind: "review", expectArtifacts: [] }), fsImpl: empty });
  assert.equal(r2.ok, true);
});

test("s2v3_1: 跨平台路径（path.join 构造 out/review.md key）下 review 默认产物校验一致", async () => {
  // 用 path.join 构造（Windows 反斜杠 / POSIX 正斜杠均正确解析——validateResult 内部同 path.join）
  const winStyle = path.join(TASK_DIR, "out", "review.md");
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }),
    [winStyle]: "VERDICT: APPROVED",
  });
  const r = await validateResult({ taskDir: TASK_DIR, task: validTask({ kind: "review" }), fsImpl });
  assert.equal(r.ok, true);
  assert.ok(r.details.artifacts.some((a) => a.name === "review.md" && a.exists === true));
});

// ---- s2v4_2: 空产物边缘 + 重启恢复 errorCode 稳定 ----
test("s2v4_2: 实现类（无 expectArtifacts）无 out/ 目录但 done.flag 根在 → 通过（不要求产物）", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }),
    // 无 out/ 目录、无产物
  });
  const r = await validateResult({ taskDir: TASK_DIR, task: validTask({ kind: "implement" }), fsImpl });
  assert.equal(r.ok, true);
  assert.equal(r.details.artifacts.length, 0);
});

test("s2v4_2: 跨重启 in-progress（无 done.flag 无 result.json）errorCode 稳定 null（不误报 missing）", async () => {
  const fsImpl = makeFakeFs({}); // 任务执行中（watchdog 重启扫描场景）
  const r = await validateResult({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(r.details.doneFlagErrorCode, null);
  assert.equal(r.details.resultErrorCode, "result-missing"); // result 缺失提示（pending），done.flag 不误报
  assert.ok(!r.errors.some((e) => e.includes("done-flag-missing")));
});

// ---- s2v5_1: watchdog 崩溃/重启恢复分类（classifyTaskRecovery / recoveryAction）----
test("s2v5_1: done.flag 根在 + result.json 缺失（runner 写 result 前被杀）→ done + needsResultWrite", async () => {
  const fsImpl = makeFakeFs({ [path.join(TASK_DIR, "done.flag")]: "" });
  const c = await classifyTaskRecovery({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(c.state, "done");
  assert.equal(c.needsResultWrite, true);
  assert.equal(c.doneFlagErrorCode, null);
  assert.equal(recoveryAction(c), "write-result");
});

test("s2v5_1: done.flag 根在 + result.json done → done，无需补写", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }),
  });
  const c = await classifyTaskRecovery({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(c.state, "done");
  assert.equal(c.needsResultWrite, false);
  assert.equal(recoveryAction(c), "none");
});

test("s2v5_1: done.flag 在 out/（misplaced）→ failed（契约违例恒报）", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, "out", "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }),
  });
  const c = await classifyTaskRecovery({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(c.state, "failed");
  assert.equal(c.doneFlagErrorCode, "done-flag-misplaced");
  assert.equal(recoveryAction(c), "inspect");
});

test("s2v5_1: 无 done.flag 无 result.json（runner 被杀执行中）→ in-progress + re-run，不误报 done/failed", async () => {
  const fsImpl = makeFakeFs({});
  const c = await classifyTaskRecovery({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(c.state, "in-progress");
  assert.equal(c.doneFlagErrorCode, null);
  assert.equal(recoveryAction(c), "re-run");
});

test("s2v5_1: result.json 非法 + 无根 done.flag → failed + inspect", async () => {
  const fsImpl = makeFakeFs({ [path.join(TASK_DIR, "result.json")]: "{ not json" });
  const c = await classifyTaskRecovery({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(c.state, "failed");
  assert.equal(c.resultErrorCode, "result-corrupt");
  assert.equal(recoveryAction(c), "inspect");
});

// ---- s2v5_4: summarizeValidation（v2 校验结果可视化单行摘要）----
test("s2v5_4: summarizeValidation 通过 → v2 OK 摘要", async () => {
  const fsImpl = makeFakeFs({
    [path.join(TASK_DIR, "done.flag")]: "",
    [path.join(TASK_DIR, "result.json")]: JSON.stringify({ status: "done", exit: 0 }),
  });
  const r = await validateResult({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(r.ok, true);
  const s = summarizeValidation(r);
  assert.ok(s.includes("v2 OK"));
});

test("s2v5_4: summarizeValidation 失败 → v2 FAIL[errorCode] + 首错", async () => {
  const fsImpl = makeFakeFs({ [path.join(TASK_DIR, "result.json")]: "{ bad" });
  const r = await validateResult({ taskDir: TASK_DIR, task: validTask(), fsImpl });
  assert.equal(r.ok, false);
  const s = summarizeValidation(r);
  assert.ok(s.startsWith("v2 FAIL[result-corrupt]"), s);
  assert.ok(s.includes("result.json"));
});

test("s2v5_4: summarizeValidation null/空输入容错", () => {
  assert.ok(summarizeValidation(null).includes("未执行"));
  assert.ok(summarizeValidation({ ok: true }).includes("v2 OK"));
});
