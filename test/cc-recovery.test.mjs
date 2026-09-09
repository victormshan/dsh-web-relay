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
