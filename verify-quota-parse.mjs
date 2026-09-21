// 配额恢复时间解析修复验收（只 import relay 侧 lib 模块——安全；**不 import cc-chain.mjs**，它 import 即执行主逻辑）
import { parseResetsAt, shouldSkipForKnownQuotaExhaustion } from 'file:///D:/dsh-web-relay/lib/cc-channel.js';

const NOW = Date.parse('2026-09-15T19:02:00Z');   // 固定 now（本地 03:02），便于断言
const fmt = (iso) => (iso ? `${iso}（本地 ${new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}）` : 'null');

const cases = [
  ["You've hit your session limit · resets 7am (Asia/Shanghai)", '真实文案（仅小时，60 字节全文）'],
  ['resets 7am', '仅小时·无时区（回退默认 Asia/Shanghai）'],
  ['resets 3:20am (Asia/Shanghai)', 'H:MM 形态（既有用例，必须仍通过）'],
  ['resets 12am (Asia/Shanghai)', '12am 边界（应 00:00）'],
  ['resets 12pm (Asia/Shanghai)', '12pm 边界（应 12:00）'],
  ['resets 11:05pm', 'H:MM pm·无时区'],
  ["You've hit your session limit", '无 resets 段 → null'],
  ['', '空串 → null'],
];

let pass = 0; const fails = [];
console.log('  === parseResetsAt（修复后）===');
for (const [text, label] of cases) {
  let iso = null, err = null;
  try { iso = parseResetsAt(text, { now: NOW }); } catch (e) { err = e; }
  const expectNull = label.includes('→ null');
  const ok = !err && (expectNull ? iso === null : typeof iso === 'string' && Number.isFinite(Date.parse(iso)));
  if (ok) pass++; else fails.push(label);
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label.padEnd(30)} → ${err ? 'ERR ' + err.message : fmt(iso)}`);
}

// 关键：resetsAt 能被 shouldSkipForKnownQuotaExhaustion 用起来（这才是这条能力的实际用途）
console.log('\n  === 端到端：解析出的 resetsAt 能否驱动「已知耗尽不盲等」 ===');
const iso = parseResetsAt("You've hit your session limit · resets 7am (Asia/Shanghai)", { now: NOW });
const state = { kind: 'quota-exhausted', resetsAt: iso, at: new Date(NOW).toISOString() };
const skipNow = shouldSkipForKnownQuotaExhaustion({ quotaState: state, now: NOW });
const skipAfter = shouldSkipForKnownQuotaExhaustion({ quotaState: state, now: Date.parse('2026-09-16T00:00:00Z') }); // 7am 本地之后
const e2e = skipNow === true && skipAfter === false;
if (e2e) pass++; else fails.push('端到端：解析结果驱动短路');
console.log(`  [${skipNow === true ? 'PASS' : 'FAIL'}] 恢复前（本地 03:02）应短路跳过派发 → ${skipNow}`);
console.log(`  [${skipAfter === false ? 'PASS' : 'FAIL'}] 恢复后（本地 08:00）不应短路 → ${skipAfter}`);

// 反向：修复前形态必须是 null（证明这条用例确实在测新能力）
const before = /resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^)]+)\)/i.test("resets 7am (Asia/Shanghai)");
if (before === false) pass++; else fails.push('反向：旧正则应匹配不到仅小时形态');
console.log(`  [${before === false ? 'PASS' : 'FAIL'}] 反向核对：旧正则（要求 H:MM）匹配不到「resets 7am」 → ${before}`);

console.log(`\n  RESULT: ${pass}/${pass + fails.length} ${fails.length ? 'FAIL' : 'PASS'}`);
for (const f of fails) console.log('    FAIL: ' + f);
process.exit(fails.length ? 1 : 0);
