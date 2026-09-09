/**
 * task-schema-v2.mjs 的单元测试。
 * 全部使用 fake fsImpl / exec，不触碰真实文件系统或子进程。
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  TASK_SCHEMA_V2,
  validateTask,
  validateResultText,
  validateResult,
  runAcceptanceScript,
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
  assert.ok(errors.includes("result.json missing"));
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

test("runAcceptanceScript: exec 成功（exit 0）→ ok true", () => {
  const calls = [];
  const exec = (script, cwd) => {
    calls.push([script, cwd]);
    // 不抛错即视为 exit 0
  };
  const { ok, error } = runAcceptanceScript({
    script: "echo hi",
    cwd: "/tmp",
    exec,
  });
  assert.equal(ok, true);
  assert.equal(error, undefined);
  assert.deepEqual(calls, [["echo hi", "/tmp"]]);
});

test("runAcceptanceScript: exec 抛错（非 0 退出）→ ok false 带 error", () => {
  const exec = () => {
    throw new Error("Command failed with exit code 1");
  };
  const { ok, error } = runAcceptanceScript({ script: "exit 1", exec });
  assert.equal(ok, false);
  assert.equal(error, "Command failed with exit code 1");
});

test("runAcceptanceScript: script 为空字符串直接报错，不调用 exec", () => {
  let called = false;
  const exec = () => {
    called = true;
  };
  const { ok, error } = runAcceptanceScript({ script: "  ", exec });
  assert.equal(ok, false);
  assert.equal(called, false);
  assert.ok(error.includes("script"));
});
