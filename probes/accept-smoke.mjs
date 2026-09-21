// 可复用的**验收探针**示例：检查任务产物存在且有实质内容。
// 契约（verify-cc-task 会按此调用）：
//   node accept-smoke.mjs <taskId>   → exit 0 通过 / exit 1 判定不合格 / 其它 = 工具错误
//   node accept-smoke.mjs --selftest → 必须证明它**在坏输入上会失败**（负控），通过则 exit 0
// verify-cc-task 另外会注入 DSH_TASK_ID / DSH_TASK_DIR / DSH_REPO 三个环境变量。
import fs from 'node:fs';
import path from 'node:path';

const TASKS = 'D:\\cc-tasks\\tasks';

function checkReport(taskId) {
  const rp = path.join(TASKS, taskId, 'out', 'report.md');
  if (!fs.existsSync(rp)) return { ok: false, why: 'report.md 不存在' };
  const bytes = Buffer.byteLength(fs.readFileSync(rp, 'utf8'), 'utf8');
  if (bytes < 200) return { ok: false, why: `报告过短（${bytes} 字节）` };
  return { ok: true, why: `${bytes} 字节` };
}

const args = process.argv.slice(2);

if (args.includes('--selftest')) {
  // 负控：对**不存在的任务**必须判失败。若这里通过（即"坏输入也判通过"），说明门禁是永真的，拒绝使用。
  const missing = checkReport('__definitely_no_such_task__');
  const negOk = missing.ok === false;
  // 正控：对当前存在的一个真实任务应当判通过（若环境里没有则跳过，不据此判失败）
  let posOk = null; let posNote = '跳过（无可用的真实任务样本）';
  try {
    const some = fs.readdirSync(TASKS).find((d) => fs.existsSync(path.join(TASKS, d, 'out', 'report.md')));
    if (some) { const p = checkReport(some); posOk = p.ok; posNote = `${some} → ${p.ok ? '通过' : '未通过'}（${p.why}）`; }
  } catch { /* 目录不可读则跳过 */ }
  console.log(`  [${negOk ? 'PASS' : 'FAIL'}] [NEG] 负控：不存在的任务必须判失败（${missing.why}）`);
  console.log(`  [${posOk === null ? 'INFO' : posOk ? 'PASS' : 'FAIL'}] [POS] 正控：真实任务应判通过 — ${posNote}`);
  const allOk = negOk && posOk !== false;   // 正控有样本时必须成立（否则门禁可能"对什么都判失败"）
  console.log(`\nRESULT: ${allOk ? 'PASS' : 'FAIL'}`);
  process.exit(allOk ? 0 : 1);
}

const taskId = args[0];
if (!taskId) { console.error('usage: node accept-smoke.mjs <taskId> | --selftest'); process.exit(2); }
const r = checkReport(taskId);
console.log(`  ${r.ok ? 'PASS' : 'FAIL'} 报告检查 — ${r.why}`);
process.exit(r.ok ? 0 : 1);
