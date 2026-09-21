// 检查 D:\dsh relay test 下是否存在「未闭合」的 relay expr（relay 启动续跑扫描的候选：
// status=executing/review 或 phase=executing 且未 finalized/未归档，或 activeSteps 非空）。
// 用法：node check-unresolved-exprs.mjs [experimentsDir]
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'D:/dsh relay test/web-relay/experiments';
let scanned = 0;
let unresolved = 0;
let parseFail = 0;

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.steps.json'))) {
  scanned++;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const active = (j.activeSteps ?? []).length;
    const isOpen =
      !j.archivedAt &&
      !j.finalized &&
      (active > 0 || ['executing', 'review'].includes(j.status) || j.phase === 'executing');
    if (isOpen) {
      unresolved++;
      console.log(
        `UNRESOLVED ${f} status=${j.status} phase=${j.phase} active=${active} sessionId=${j.sessionId} bootId=${j.bootId}`
      );
    }
  } catch (error) {
    parseFail++;
    console.log(`PARSE-FAIL ${f} :: ${String(error.message).slice(0, 60)}`);
  }
}

const archived = scanned - unresolved - parseFail;
console.log(`scanned=${scanned} unresolved=${unresolved} closed_or_archived=${archived} parseFail=${parseFail}`);
