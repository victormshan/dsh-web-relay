// A1 → A3 → A5' 整链端到端证明（真实数据 + 真实配额状态）
// 目的：证明「链条任务撞配额」这一真实场景下，A3 的抑制**确实生效**；并给出反事实对照
// （若无 A5' 写的配额状态，则抑制不生效、误报会照常发生）——用真实组件，不用手写中间值。
import fs from 'node:fs';

const STEPS = 'D:/dsh relay test/web-relay/experiments/expr-2026-09-13_17-36-07.steps.json';
const QC = 'D:/cc-tasks/cc-quota-state.json';

const hb = await import('file:///D:/dsh-web-relay/lib/heartbeat-scan.js');
const ch = await import('file:///D:/dsh-web-relay/lib/cc-channel.js');
const { scanExprSignals, shouldSuppressWake } = hb;
const { shouldSkipForKnownQuotaExhaustion } = ch;

let pass = 0; const fails = [];
const T = (n, c, x = '') => { if (c) pass++; else fails.push(n + (x ? ` → ${x}` : '')); };

// ① 真实配额状态（由 runner 的写入器在 WSL 侧写下）
const hasState = fs.existsSync(QC);
const state = hasState ? JSON.parse(fs.readFileSync(QC, 'utf8')) : null;
console.log('  ① 真实配额状态 = ' + (state ? JSON.stringify(state) : '(不存在)'));

const quotaWaiting_real = shouldSkipForKnownQuotaExhaustion({ quotaState: state, now: Date.now() });
console.log('      → quotaWaiting(真实状态) = ' + quotaWaiting_real);
T('① 真实配额状态能驱动 quotaWaiting=true（A5\' 生效）', quotaWaiting_real === true, 'state=' + JSON.stringify(state));

// ② 真实 expr 形状 → 真实 scanExprSignals → 事故形状的 pending（A1 产出）
const real = JSON.parse(fs.readFileSync(STEPS, 'utf8'));
const acc = JSON.parse(JSON.stringify(real));
acc.status = 'executing'; acc.finalized = false;
acc.steps.find((s) => String(s.id) === '7').status = 'pending';
acc.updatedAt = new Date(Date.now() - 40 * 60000).toISOString();
const p = scanExprSignals(acc, { now: Date.now() });
const pending = p.signals.length ? [p] : [];
console.log('  ② 真实 scanExprSignals 产出 signals = ' + JSON.stringify(p.signals));
T('② A1 产出的 pending 只含 unclaimed-pending', p.signals.length === 1 && p.signals[0] === 'unclaimed-pending', JSON.stringify(p.signals));

// ③ A3 判定：真实 pending + 真实 quotaWaiting → 应抑制
const suppressed_real = shouldSuppressWake({ pending, quotaWaiting: quotaWaiting_real });
console.log('  ③ shouldSuppressWake(真实 pending, 真实 quotaWaiting) = ' + suppressed_real);
T('③ 真实链路上抑制生效（不再假唤醒主 agent）', suppressed_real === true);

// ④ 反事实：若没有 A5' 写的状态（quotaWaiting=false），抑制**不会**生效 → 误报会照常发生
const quotaWaiting_counter = shouldSkipForKnownQuotaExhaustion({ quotaState: null, now: Date.now() });
const suppressed_counter = shouldSuppressWake({ pending, quotaWaiting: quotaWaiting_counter });
console.log('  ④ 反事实（无配额状态）quotaWaiting=' + quotaWaiting_counter + ' → suppressed=' + suppressed_counter);
T('④ 反事实：无配额状态时不抑制（证明 A5\' 是必要的）', quotaWaiting_counter === false && suppressed_counter === false);

console.log(`\n  RESULT: ${pass}/${pass + fails.length} ${fails.length ? 'FAIL' : 'PASS'}`);
for (const f of fails) console.log('    FAIL: ' + f);
process.exit(fails.length ? 1 : 0);
