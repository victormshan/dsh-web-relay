// 事件路径**演练**（dryRun）—— 让"熔断会登记成什么"能进**周期审计**且零副作用。
//
// 与 verify-autoir-events.mjs 的分工：
//   · events 版：真写一次真实信号（验证"确实落盘"），需销账清理 → 只在按需/回归时跑。
//   · drill 版（本文件）：走**同一段生产代码**但只构造不落盘 → 可进 30 分钟周期审计。
//   · wiring 版：静态断言接线还在（防被重构摘掉）。
// 三者互补：wiring 证明"线还在"，drill 证明"每周期都能构造出正确对象"，events 证明"真写也成功"。
//
// 覆盖：
//   D1 演练必须回传将写入的信号对象（chainId=autoir-circuit / reason=too-many-attempts / taskId=规范 ref）
//   D2 演练**不得**改动真实信号文件（零副作用——这是它能进周期审计的前提）
//   D3 版间门记录的产出走 base 相对写入：用临时 workspacePath 触发即可零污染地验证（无需 dryRun）
//   D4 --selftest 负控：非演练模式（drill 省略）**必须**真的写一次信号 → 证明 D2 的"没写"是 dryRun 起的作用，
//      而不是"这条路径压根不写"（否则 D2 是永真断言）
//
// 用法: node verify-autoir-drill.mjs            # 演练（零副作用，可进周期审计）
//       node verify-autoir-drill.mjs --selftest # 含 D4 负控（会写一次真实信号并销账清理）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHumanSignal, readQueue, acknowledgeHumanSignal, removeQueueEntry, SIGNAL_PATH } from './chain-human-signal.mjs';

const API = 'http://127.0.0.1:3080/dsh-web-relay/steps/update';
const post = async (body) => {
  const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
};

const results = [];
const ck = (label, cond, detail = '') => { results.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };
const stamp = (o = 0) => {
  const d = new Date(Date.now() + o * 1000), p = (n) => String(n).padStart(2, '0');
  return `expr-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
const fixture = (exprId, extra = {}) => ({
  exprId, status: 'open', phase: 'executing',
  steps: [{ id: 's1', status: 'review', title: 't', detail: 'd', acceptance: 'a' }],
  currentStep: 's1', activeSteps: ['s1'], iterations: 1, currentIteration: 1, rejectStreak: 0, incrementalStreak: 0, bootId: 'drill-fixture',
  ...extra,
});

// 真实信号文件的"指纹"（主槽 + **两条**队列路径全文），用于 D2 的零副作用断言。
// ⚠ 2026-09-20 修正：初版只读 `${SIGNAL_PATH}.queue.json`（历史路径）—— v21.2 收敛后插件改写信封规范的
// 规范路径 `<基础名>.queue.json`，于是队列变化**不进指纹** → D4 负控假失败（指纹变化=false 但队列命中=true）。
// 两条路径都放进来，指纹才真正代表"信号通道有没有被动过"。
const signalFingerprint = () => {
  const one = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  return [one(SIGNAL_PATH), one(`${SIGNAL_PATH}.queue.json`), one(SIGNAL_PATH.replace(/\.json$/i, '.queue.json'))].join('||');
};

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autoir-drill-'));
fs.mkdirSync(path.join(base, 'web-relay', 'experiments'), { recursive: true });
const statePath = (id) => path.join(base, 'web-relay', 'experiments', `${id}.steps.json`);
const readState = (id) => JSON.parse(fs.readFileSync(statePath(id), 'utf8'));

console.log('=== 事件路径演练（dryRun，零副作用）===');

// ---- D1/D2：熔断登记演练 ----
const id1 = stamp(0);
fs.writeFileSync(statePath(id1), JSON.stringify(fixture(id1), null, 2), 'utf8');
const before = signalFingerprint();
let drillSig = null;
for (let i = 1; i <= 3; i++) {
  const st = readState(id1);
  const step = st.steps.find((s) => String(s.id) === 's1');
  if (step.status !== 'review') { step.status = 'review'; fs.writeFileSync(statePath(id1), JSON.stringify(st, null, 2), 'utf8'); }
  const r = await post({ workspacePath: base, exprId: id1, stepId: 's1', action: 'reject', comment: `演练第 ${i} 次打回`, role: 'mainagent', drill: true });
  if (r.body && r.body.drillSignal) drillSig = r.body.drillSignal;
  if (i === 3) console.log(`    第 3 次 reject → HTTP ${r.status} ｜ rejectStreak=${readState(id1).rejectStreak} ｜ status=${readState(id1).status} ｜ drillSignal=${drillSig ? 'yes' : 'no'}`);
}
// 能力自检（关键安全设计）：若插件**尚未**支持 drill（未交付/未重启），上面那三次 reject 会**真的写信号**。
// 此时必须：① 立刻按 taskId 认领并清理自己造的信号（只清自己的，绝不碰别人的）；② 报"未验证(4)"而不是失败。
// 这样本脚本在**任何插件状态下都安全**，才配得上"进周期审计"。
// ⚠ 顺序要求：能力判定必须在 D1/D2 断言**之前**——否则不支持时 D1 会先报一个无意义的 FAIL（本文件初版如此）。
if (!drillSig) {
  const cur = readHumanSignal(SIGNAL_PATH);
  const mineMain = cur.ok && cur.entry && String(cur.entry.taskId || '') === `expr:${id1}`;
  let cleaned = false;
  if (mineMain) { acknowledgeHumanSignal('演练能力自检：插件未支持 drill，清理本次误写信号'); cleaned = true; }
  try {
    const q = readQueue(SIGNAL_PATH) || [];
    const kept = q.filter((e) => !(e && String(e.taskId || '') === `expr:${id1}`));
    if (kept.length !== q.length) { fs.writeFileSync(`${SIGNAL_PATH}.queue.json`, JSON.stringify({ queue: kept }, null, 2), 'utf8'); cleaned = true; }
  } catch { /* 无队列 */ }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.log(`  [UNVERIFIED] 插件当前**不支持 drill**（未交付/未重启该改动）→ 本次已清理自己造成的信号（cleaned=${cleaned}）`);
  console.log('\n  RESULT: UNVERIFIED（证据不足，不得读成通过）');
  process.exit(4);
}

ck('[POS] D1 演练回传将写入的信号对象，字段正确（chainId/reason/taskId 规范 ref）',
  !!drillSig && !!drillSig.entry && drillSig.entry.chainId === 'autoir-circuit' && drillSig.entry.reason === 'too-many-attempts' && drillSig.entry.taskId === `expr:${id1}`,
  drillSig && drillSig.entry ? `id=${drillSig.entry.id} taskId=${drillSig.entry.taskId} dryRun=${drillSig.dryRun}` : '(未回传)');
const after = signalFingerprint();
ck('[POS] D2 演练**未改动**真实信号文件（零副作用）', before === after, before === after ? '主槽+队列指纹未变' : '⚠ 真实信号被改动了');

// ---- D3：版间门（base 相对写入 → 临时 base 即零污染，不需 dryRun）----
const id2 = stamp(1);
fs.writeFileSync(statePath(id2), JSON.stringify(fixture(id2, {
  iterations: 2, currentIteration: 1, autoDecision: true, finalAcceptance: 'x',
  steps: [{ id: 's1', status: 'executing', review: false, title: 't', detail: 'd', acceptance: 'a' }], activeSteps: ['s1'],
}), null, 2), 'utf8');
const r2 = await post({ workspacePath: base, exprId: id2, stepId: 's1', action: 'complete', comment: '演练：版间门', role: 'mainagent' });
const st2 = readState(id2);
const gates = Array.isArray(st2.iterationGates) ? st2.iterationGates : [];
ck('[POS] D3 版间门在临时 base 上落盘门记录（零污染）',
  gates.length >= 1 && gates.some((g) => g.decision === 'advance' && g.from === 1 && g.to === 2) && st2.currentIteration === 2,
  `HTTP=${r2.status} currentIteration=${st2.currentIteration}/${st2.iterations} gates=${JSON.stringify(gates.map((g) => g.decision))}`);
const after3 = signalFingerprint();
ck('[POS] D3b 版间门演练同样未改动真实信号文件', after3 === after, after3 === after ? '指纹未变' : '⚠ 被动改');

// ---- D4：负控（仅 --selftest）——非演练模式必须真的写一次，证明 D2 非永真 ----
if (process.argv.includes('--selftest')) {
  const id3 = stamp(2);
  fs.writeFileSync(statePath(id3), JSON.stringify(fixture(id3), null, 2), 'utf8');
  for (let i = 1; i <= 3; i++) {
    const st = readState(id3);
    const step = st.steps.find((s) => String(s.id) === 's1');
    if (step.status !== 'review') { step.status = 'review'; fs.writeFileSync(statePath(id3), JSON.stringify(st, null, 2), 'utf8'); }
    await post({ workspacePath: base, exprId: id3, stepId: 's1', action: 'reject', comment: `负控第 ${i} 次`, role: 'mainagent' });   // 不带 drill
  }
  const afterReal = signalFingerprint();
  const main = readHumanSignal(SIGNAL_PATH);
  // 2026-09-20 修正：判据**不得**要求信号落在主槽 —— 主槽可能被真实告警占着（实测被 post-restart-verify#g2
  // 占着），此时真实信号按设计**入队**。只要"文件确实变了 + 能在主槽或队列里找到它"就证明非演练模式
  // 真的写了（这正是 D4 要证的事），与落点无关。清理只清自己的条目、绝不动主槽。
  const inMain = !!(main.ok && main.entry && String(main.entry.taskId || '') === `expr:${id3}`);
  const hitQ = readQueue(SIGNAL_PATH).find((e) => String(e.taskId || '') === `expr:${id3}`);
  ck('[NEG] D4 非演练模式**确实写入**真实信号（证明 D2 的"没写"是 dryRun 起的作用，而非路径不写）',
    afterReal !== after && (inMain || !!hitQ),
    `指纹变化=${afterReal !== after} 主槽=${main.ok && main.entry ? main.entry.id : '(空)'} 队列命中=${!!hitQ}`);
  if (inMain) { acknowledgeHumanSignal('D4 负控产物：真实熔断信号，核对后清理'); console.log('    （已销账清理该信号）'); }
  else if (hitQ) { removeQueueEntry(hitQ.id); console.log('    （已从队列移除自己的条目；主槽是真实信号，未动）'); }
}

try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ }
const bad = results.filter((r) => !r.cond).length;
console.log(`\nRESULT: ${results.length - bad}/${results.length} ${bad ? 'FAIL' : 'PASS'}`);
process.exit(bad ? 1 : 0);
