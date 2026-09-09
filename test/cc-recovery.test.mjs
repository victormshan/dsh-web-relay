/**
 * s2v5_1: CLI recover 瀛愬懡浠わ紙watchdog 宕╂簝/閲嶅惎鎭㈠锛塭2e 娴嬭瘯銆? * 浣跨敤鐪熷疄涓存椂鐩綍妯℃嫙 runner 琚潃鍚庣殑鎮寕浠诲姟鐩綍锛岄獙璇佹仮澶嶅姩浣滐細
 *   - done.flag 鏍瑰湪 + 鏃?result.json 鈫?琛ュ啓 result.json {status:done}
 *   - 鏃?done.flag 鏃?result.json锛堟墽琛屼腑琚潃锛夆啋 鍒?re-run 涓嶈鎶? *   - misplaced / 闈炴硶 鈫?鍘熸牱淇濈暀锛坕nspect锛? */

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "scripts", "task-schema-cli.mjs");

function makeTask(taskId) {
  return {
    taskId,
    kind: "review",
    title: `浠诲姟 ${taskId}`,
    prompt: "鎵ц骞朵骇鍑?out/review.md + 鏍?done.flag",
    acceptance: "review.md 瀛樺湪",
    outputDir: "out",
    expectArtifacts: ["review.md"],
  };
}

async function runRecover(parentDir) {
  const { stdout } = await execFileP(process.execPath, [CLI, "recover", parentDir], { encoding: "utf8" });
  return JSON.parse(stdout);
}

test("s2v5_1 CLI recover: 鐪熷疄鐩綍鎭㈠鍦烘櫙", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-recover-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  // a) done.flag 鏍瑰湪 + 鏃?result.json锛坮unner 鍐?result 鍓嶈鏉€锛夆啋 琛ュ啓 done
  const dirA = path.join(root, "task-killed-after-flag");
  await fsp.mkdir(path.join(dirA, "out"), { recursive: true });
  await fsp.writeFile(path.join(dirA, "task.json"), JSON.stringify(makeTask("task-killed-after-flag")));
  await fsp.writeFile(path.join(dirA, "done.flag"), "");
  await fsp.writeFile(path.join(dirA, "out", "review.md"), "VERDICT: APPROVED");

  // b) 鏃?done.flag 鏃?result.json锛坮unner 鎵ц涓鏉€锛夆啋 re-run
  const dirB = path.join(root, "task-killed-midrun");
  await fsp.mkdir(path.join(dirB, "out"), { recursive: true });
  await fsp.writeFile(path.join(dirB, "task.json"), JSON.stringify(makeTask("task-killed-midrun")));
  await fsp.writeFile(path.join(dirB, "out", "review.md"), "VERDICT: APPROVED");

  // c) misplaced锛坉one.flag 鏀?out/锛夆啋 鍘熸牱淇濈暀 inspect
  const dirC = path.join(root, "task-misplaced");
  await fsp.mkdir(path.join(dirC, "out"), { recursive: true });
  await fsp.writeFile(path.join(dirC, "task.json"), JSON.stringify(makeTask("task-misplaced")));
  await fsp.writeFile(path.join(dirC, "out", "done.flag"), "");
  await fsp.writeFile(path.join(dirC, "result.json"), JSON.stringify({ status: "done", exit: 0 }));

  const out = await runRecover(root);
  assert.equal(out.summary.recovered, 1);
  assert.equal(out.summary.rerun, 1);
  assert.equal(out.summary.untouched, 1);

  // a) result.json 宸茶ˉ鍐?done + recovered 鏍囪
  const ra = JSON.parse(await fsp.readFile(path.join(dirA, "result.json"), "utf8"));
  assert.equal(ra.status, "done");
  assert.equal(ra.recovered, true);
  assert.ok(out.recovered.some((x) => x.taskDir === dirA && x.action === "write-result"));

  // b) 鍦?rerun 鍒楄〃涓旀湭鍐?result.json
  assert.ok(out.rerun.some((x) => x.taskDir === dirB && x.action === "re-run"));
  await assert.rejects(() => fsp.access(path.join(dirB, "result.json")));

  // c) 鍘熸牱淇濈暀锛堟湭琛ュ啓銆佹湭鍒犻櫎锛?  assert.ok(out.untouched.some((x) => x.taskDir === dirC && x.action === "inspect"));
  const rc = JSON.parse(await fsp.readFile(path.join(dirC, "result.json"), "utf8"));
  assert.equal(rc.status, "done");
  assert.equal(rc.recovered, undefined);
});

test("s2v5_1 CLI recover: 宸叉甯稿畬鎴愮殑浠诲姟涓嶈Е纰帮紙done + result 榻愶級", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-recover2-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dirD = path.join(root, "task-finished");
  await fsp.mkdir(path.join(dirD, "out"), { recursive: true });
  await fsp.writeFile(path.join(dirD, "task.json"), JSON.stringify(makeTask("task-finished")));
  await fsp.writeFile(path.join(dirD, "done.flag"), "");
  await fsp.writeFile(path.join(dirD, "out", "review.md"), "VERDICT: APPROVED");
  const before = JSON.stringify({ status: "done", exit: 0 });
  await fsp.writeFile(path.join(dirD, "result.json"), before);

  const out = await runRecover(root);
  assert.equal(out.summary.recovered, 0);
  assert.equal(out.summary.rerun, 0);
  assert.equal(out.summary.untouched, 1);
  const after = await fsp.readFile(path.join(dirD, "result.json"), "utf8");
  assert.equal(after, before); // 鍐呭鏈鏀瑰啓
});

// ---- s2v5_2: CLI report mixed 批次分组汇总 ----
async function runReport(parentDir, extra = []) {
  try {
    const { stdout } = await execFileP(process.execPath, [CLI, "report", parentDir, ...extra], { encoding: "utf8" });
    return JSON.parse(stdout);
  } catch (err) {
    // report 存在 failed 任务时 exit code 1（属预期）——stdout 仍是完整 JSON
    return JSON.parse(err.stdout);
  }
}

test("s2v5_2 CLI report: mixed 批次按状态分组汇总（done/pending/failed + 计数 + 首条问题）", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-report-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  // done：完整通过
  const dirA = path.join(root, "mix-done");
  await fsp.mkdir(path.join(dirA, "out"), { recursive: true });
  await fsp.writeFile(path.join(dirA, "task.json"), JSON.stringify(makeTask("mix-done")));
  await fsp.writeFile(path.join(dirA, "done.flag"), "");
  await fsp.writeFile(path.join(dirA, "out", "review.md"), "VERDICT: APPROVED");
  await fsp.writeFile(path.join(dirA, "result.json"), JSON.stringify({ status: "done", exit: 0 }));

  // pending：无 result.json（执行中）
  const dirB = path.join(root, "mix-pending");
  await fsp.mkdir(path.join(dirB, "out"), { recursive: true });
  await fsp.writeFile(path.join(dirB, "task.json"), JSON.stringify(makeTask("mix-pending")));
  await fsp.writeFile(path.join(dirB, "out", "review.md"), "VERDICT: APPROVED");

  // failed：done.flag 放 out/（misplaced）
  const dirC = path.join(root, "mix-failed");
  await fsp.mkdir(path.join(dirC, "out"), { recursive: true });
  await fsp.writeFile(path.join(dirC, "task.json"), JSON.stringify(makeTask("mix-failed")));
  await fsp.writeFile(path.join(dirC, "out", "done.flag"), "");
  await fsp.writeFile(path.join(dirC, "result.json"), JSON.stringify({ status: "done", exit: 0 }));

  const out = await runReport(root);
  assert.equal(out.ok, false);
  assert.equal(out.count, 3);
  assert.equal(out.summary.total, 3);
  assert.equal(out.summary.done, 1);
  assert.equal(out.summary.pending, 1);
  assert.equal(out.summary.failed, 1);
  assert.equal(out.summary.okAll, false);
  assert.equal(out.summary.firstPending.task, "mix-pending");
  assert.equal(out.summary.firstFailed.task, "mix-failed");
  assert.equal(out.summary.firstFailed.doneFlagErrorCode, "done-flag-misplaced");
  // 默认不携带完整 results（防刷屏）；--verbose 才带
  assert.equal(out.results, undefined);
});

test("s2v5_2 CLI report: --verbose 保留完整明细", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-report2-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dirA = path.join(root, "v-done");
  await fsp.mkdir(path.join(dirA, "out"), { recursive: true });
  await fsp.writeFile(path.join(dirA, "task.json"), JSON.stringify(makeTask("v-done")));
  await fsp.writeFile(path.join(dirA, "done.flag"), "");
  await fsp.writeFile(path.join(dirA, "out", "review.md"), "VERDICT: APPROVED");
  await fsp.writeFile(path.join(dirA, "result.json"), JSON.stringify({ status: "done", exit: 0 }));

  const out = await runReport(root, ["--verbose"]);
  assert.equal(out.summary.done, 1);
  assert.ok(Array.isArray(out.results));
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].doneFlagAtRoot, true);
});

// ---- s2v5_3: cc-watchdog REJECT 隔离（queue/.invalid/）人工复检闭环 ----
function makeInvalidTask(taskId) {
  // 绝对 outputDir 违例（真实 .invalid 13 例根因——buildReviewTask 旧版硬编码绝对路径）
  return {
    taskId,
    kind: "review",
    title: `非法任务 ${taskId}`,
    prompt: "执行并产出 out/review.md + 根 done.flag",
    outputDir: `/mnt/d/cc-tasks/tasks/${taskId}/out`,
    expectArtifacts: ["review.md"],
  };
}

function fixTask(task) {
  return { ...task, outputDir: "out" }; // 人工修复：绝对路径 → 相对子路径
}

async function runInvalid(args, opts = {}) {
  try {
    const { stdout } = await execFileP(process.execPath, [CLI, "invalid", ...args], { encoding: "utf8" });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.code || 1, out: JSON.parse(err.stdout) };
  }
}

test("s2v5_3 invalid 复检闭环: list 原因可查 / revalidate / recover 重入队", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-invalid-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const invalidDir = path.join(root, "queue", ".invalid");
  await fsp.mkdir(invalidDir, { recursive: true });

  // 两个 REJECT 隔离任务（绝对 outputDir 违例——真实 13 例根因）
  const f1 = "rev-bad01.1789000000.task.json";
  const f2 = "rev-bad02.1789000001.task.json";
  await fsp.writeFile(path.join(invalidDir, f1), JSON.stringify(makeInvalidTask("rev-bad01")));
  await fsp.writeFile(path.join(invalidDir, f2), JSON.stringify(makeInvalidTask("rev-bad02")));

  // list：原因可查（outputDir 越界）
  const list = await runInvalid(["list", root]);
  assert.equal(list.code, 0);
  assert.equal(list.out.count, 2);
  assert.ok(list.out.rows.every((r) => r.validNow === false));
  assert.ok(list.out.rows[0].rejectReason.some((e) => e.includes("outputDir 越界")));

  // revalidate：未修复 → 失败
  const rv1 = await runInvalid(["revalidate", root, f1]);
  assert.equal(rv1.code, 1);
  assert.equal(rv1.out.ok, false);

  // 人工修复 f1（绝对 → 相对）→ revalidate 通过
  const fixed = fixTask(makeInvalidTask("rev-bad01"));
  await fsp.writeFile(path.join(invalidDir, f1), JSON.stringify(fixed));
  const rv2 = await runInvalid(["revalidate", root, f1]);
  assert.equal(rv2.code, 0);
  assert.equal(rv2.out.ok, true);

  // recover：修复后的 f1 移回 queue/（重入待处理区）
  const rec = await runInvalid(["recover", root, f1]);
  assert.equal(rec.code, 0);
  assert.equal(rec.out.ok, true);
  assert.equal(rec.out.restoredTo, path.join(root, "queue", "rev-bad01.task.json"));
  await fsp.access(path.join(root, "queue", "rev-bad01.task.json")); // 已重入队
  await assert.rejects(() => fsp.access(path.join(invalidDir, f1))); // .invalid 已移除

  // recover 未修复的 f2 → 拒绝（留在 .invalid）
  const rec2 = await runInvalid(["recover", root, f2]);
  assert.equal(rec2.code, 1);
  assert.equal(rec2.out.ok, false);
  await fsp.access(path.join(invalidDir, f2));
});

test("s2v5_3 invalid clean: 未 approved 拒删；approve 后 clean 才回收", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-invalid2-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const invalidDir = path.join(root, "queue", ".invalid");
  await fsp.mkdir(invalidDir, { recursive: true });
  const fA = "rev-discard01.1789000100.task.json";
  const fB = "rev-discard02.1789000101.task.json";
  await fsp.writeFile(path.join(invalidDir, fA), JSON.stringify(makeInvalidTask("rev-discard01")));
  await fsp.writeFile(path.join(invalidDir, fB), JSON.stringify(makeInvalidTask("rev-discard02")));

  // 未 approved → clean 拒删（exit 1，refused 列出）
  const c1 = await runInvalid(["clean", root]);
  assert.equal(c1.code, 1);
  assert.deepEqual(c1.out.deleted, []);
  assert.equal(c1.out.refused.length, 2);
  await fsp.access(path.join(invalidDir, fA));
  await fsp.access(path.join(invalidDir, fB));

  // 只 approve fA → clean fA 成功、fB 仍拒
  const ap = await runInvalid(["approve", root, fA]);
  assert.equal(ap.code, 0);
  const c2 = await runInvalid(["clean", root, fA]);
  assert.equal(c2.code, 0);
  assert.deepEqual(c2.out.deleted, [fA]);
  await assert.rejects(() => fsp.access(path.join(invalidDir, fA)));
  await fsp.access(path.join(invalidDir, fB)); // fB 未 approved 仍在

  // 全量 clean：fB 仍无标记 → refused
  const c3 = await runInvalid(["clean", root]);
  assert.equal(c3.code, 1);
  assert.equal(c3.out.refused.length, 1);
});
