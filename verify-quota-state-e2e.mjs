// 端到端验收：runner 写下的配额状态能否驱动 relay 的「已知耗尽不盲等」
import fs from 'node:fs';
const m = await import('file:///D:/dsh-web-relay/lib/cc-channel.js');
const P = 'D:/cc-tasks/cc-quota-state.json';
if (!fs.existsSync(P)) { console.error('  ❌ 状态文件不存在（先跑 quota-state-write.mjs）'); process.exit(2); }
const st = JSON.parse(fs.readFileSync(P, 'utf8'));
const nowMs = Date.now();
const skipNow = m.shouldSkipForKnownQuotaExhaustion({ quotaState: st, now: nowMs });
const skipAfter = m.shouldSkipForKnownQuotaExhaustion({ quotaState: st, now: Date.parse(st.resetsAt) + 1000 });
const local = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
console.log('  quotaState = ' + JSON.stringify(st));
console.log('  当前本地时间 = ' + local(nowMs));
console.log('  恢复时刻(本地) = ' + local(Date.parse(st.resetsAt)));
console.log(`  [${skipNow === true ? 'PASS' : 'FAIL'}] 恢复前应短路跳过派发 → ${skipNow}`);
console.log(`  [${skipAfter === false ? 'PASS' : 'FAIL'}] 恢复后不应短路 → ${skipAfter}`);
const ok = skipNow === true && skipAfter === false;
console.log(`\n  RESULT: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
