// A3 真实数据集成验证（只读仓库）：真实 scanExprSignals 产出的 pending → shouldSuppressWake 是否正确
// 动机：A3 的 11 个单测全部用手写的 pending 对象（{signals:['unclaimed-pending']}）。但**没人验证过**
// A1 的真实产出能否正确喂进 A3 的判定——两任务间靠「信号名字符串」隐性耦合，一旦拼写或结构不一致，
// 单测仍会全绿而集成失效（与 §16 selfcheck 那次「18 个单测全绿、集成必坏」同类风险）。
import fs from 'node:fs';

const STEPS = 'D:/dsh relay test/web-relay/experiments/expr-2026-09-13_17-36-07.steps.json';
const QC = 'D:/dsh relay test/web-relay/experiments/cc-quota-state.json';
let mod;
try {
  mod = await import('file:///D:/dsh-web-relay/lib/heartbeat-scan.js');
} catch (e) {
  console.error('  import 失败（A4 可能正在改文件）：' + String(e && e.message).slice(0, 120));
  process.exit(2);
}
const { scanExprSignals, shouldSuppressWake } = mod;
if (typeof shouldSuppressWake !== 'function') { console.error('  ❌ shouldSuppressWake 未导出'); process.exit(2); }

const real = JSON.parse(fs.readFileSync(STEPS, 'utf8'));
const now = Date.now();
const MIN = 60000;
const clone = () => JSON.parse(JSON.stringify(real));
let pass = 0; const fails = [];
const T = (n, c, x = '') => { if (c) pass++; else fails.push(n + (x ? ` → ${x}` : '')); };

// 造出「事故形状」的真实 pending（经真实 scanExprSignals，而非手写）
const accident = clone();
accident.status = 'executing'; accident.finalized = false;
accident.steps.find((s) => String(s.id) === '7').status = 'pending';
accident.updatedAt = new Date(now - 40 * MIN).toISOString();
const pendingReal = scanExprSignals(accident, { now });
const allPending = pendingReal.signals.length ? [pendingReal] : [];

console.log('  真实 scanExprSignals 产出 signals = ' + JSON.stringify(pendingReal.signals));

// ① 集成：真实产出 → 真实消费者
T('① 真实 pending（仅 unclaimed-pending）+ 配额等待 → 抑制',
  shouldSuppressWake({ pending: allPending, quotaWaiting: true }) === true,
  'signals=' + JSON.stringify(pendingReal.signals));

// ② 配额不等待 → 绝不抑制（哪怕信号单一）
T('② 同一真实 pending + quotaWaiting=false → 不抑制',
  shouldSuppressWake({ pending: allPending, quotaWaiting: false }) === false);

// ③ 真实产出 + 混入另一个真实信号 → 不抑制（用全 approved 造出 finalize-pending）
{
  const mixed = clone();
  mixed.status = 'executing'; mixed.finalized = false;
  mixed.updatedAt = new Date(now - 40 * MIN).toISOString();
  const p = scanExprSignals(mixed, { now });   // 全 approved → finalize-pending
  const combined = [{ exprId: p.exprId, signals: [...p.signals, ...pendingReal.signals], detail: [] }];
  T('③ 真实 finalize-pending 与 unclaimed-pending 并存 + 配额等待 → **不抑制**（必须照常唤醒）',
    shouldSuppressWake({ pending: combined, quotaWaiting: true }) === false,
    'signals=' + JSON.stringify(combined[0].signals));
  // 同时确认：真实全 approved 形状确实产出 finalize-pending（否则这条用例是空转）
  T('③ 前置：真实全 approved 形状确实产出 finalize-pending', p.signals.includes('finalize-pending'), JSON.stringify(p.signals));
}

// ④ 真实终态（finalized）→ 无任何信号 → 不抑制
{
  const p = scanExprSignals(clone(), { now });
  T('④ 真实 finalized expr → 0 信号且不抑制',
    p.signals.length === 0 && shouldSuppressWake({ pending: [p], quotaWaiting: true }) === false);
}

// ⑤ 信号名拼写一致性（两任务间的隐性契约）——若哪天改名，此条会红
T('⑤ 信号名与 shouldSuppressWake 认得的名字完全一致（无拼写漂移）',
  pendingReal.signals.includes('unclaimed-pending') && shouldSuppressWake({ pending: allPending, quotaWaiting: true }) === true);

// ⑥ 真实配额状态文件（若有）：报告运行时会怎样判定，并核对 resetsAt 是否已过期
if (fs.existsSync(QC)) {
  let q = null; try { q = JSON.parse(fs.readFileSync(QC, 'utf8')); } catch { /* ignore */ }
  const resets = q && q.resetsAt ? Date.parse(q.resetsAt) : NaN;
  const waiting = !!(q && q.kind === 'quota-exhausted' && Number.isFinite(resets) && now < resets);
  console.log(`  真实配额状态: kind=${q && q.kind} resetsAt=${q && q.resetsAt} → 当前是否处于等待=${waiting}`);
  T('⑥ 真实配额状态可解析（不被静默当成「未等待」）', q !== null, '文件损坏或不可读');
} else {
  console.log('  真实配额状态文件不存在（首次运行时正常；此时不会抑制，属既定 fail-open）');
}

console.log(`\n  RESULT: ${pass}/${pass + fails.length} ${fails.length ? 'FAIL' : 'PASS'}`);
for (const f of fails) console.log('    FAIL: ' + f);
process.exit(fails.length ? 1 : 0);
