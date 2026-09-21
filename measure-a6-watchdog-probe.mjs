// A6 实测：在 cc 任务执行期间调用真实的 ccWatchdogAlive，看「派发前探活」到底怎么判
// 只读：import 仓库模块 + 读 cc-tasks 目录，不写任何文件、不改任何脚本。
import fs from 'node:fs';

let mod;
try {
  mod = await import('file:///D:/dsh-web-relay/lib/cc-channel.js');
} catch (e) {
  console.error('  import 失败：' + String(e && e.message).slice(0, 140));
  process.exit(2);
}
const { ccWatchdogAlive, nodeFsImpl } = mod;
if (typeof ccWatchdogAlive !== 'function') { console.error('  ❌ ccWatchdogAlive 未导出'); process.exit(2); }

const ROOT = 'D:\\cc-tasks';
const hb = `${ROOT}\\watchdog.heartbeat`;
const ageMs = fs.existsSync(hb) ? Date.now() - fs.statSync(hb).mtimeMs : null;

// 是否有在飞任务（runner.sh 进程无法从上文读，这里用 result.json 是否已结算判断「疑似在飞」）
let inFlight = 0;
try {
  for (const d of fs.readdirSync(`${ROOT}\\tasks`)) {
    const rj = `${ROOT}\\tasks\\${d}\\result.json`;
    if (!fs.existsSync(rj)) inFlight += 1;
  }
} catch { /* ignore */ }

const r = await ccWatchdogAlive({ fsImpl: nodeFsImpl, root: ROOT, env: process.env, now: Date.now() });
console.log('  === 真实 ccWatchdogAlive 判定（当前时刻）===');
console.log('  心跳 age      = ' + (ageMs === null ? '(缺失)' : Math.round(ageMs / 1000) + 's') + '  （阈值 120s）');
console.log('  无 result.json 的任务目录数 = ' + inFlight + '（含历史未结算者，仅作参考）');
console.log('  → ok=' + r.ok + ' | reason=' + r.reason + ' | stale=' + r.stale);
console.log('  → details=' + JSON.stringify(r.details));

const strictR = await ccWatchdogAlive({ fsImpl: nodeFsImpl, root: ROOT, env: { ...process.env, DSH_CC_WATCHDOG_STRICT: '1' }, now: Date.now() });
console.log('  === 若开启 STRICT=1 ===');
console.log('  → ok=' + strictR.ok + ' | reason=' + strictR.reason + (strictR.ok ? '' : '  ← **会阻断派发**'));

console.log('\n  === 结论 ===');
if (r.stale && !r.ok) console.log('  当前心跳陈旧且被判定不可用（strict 下会阻断）');
else if (r.stale) console.log('  当前心跳陈旧 → reason=' + r.reason + '（非 strict 故不阻断，但 relay 会记 ccWatchdogWarning → /health-check 出现误导性告警）');
else console.log('  当前判定为存活（心跳新鲜）——说明此刻无任务在跑或恰在轮询间隙');
