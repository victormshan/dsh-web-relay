// 补上"事件驱动路径"的行为验证 —— 用**生产代码路径**合成两个真实事件（不是复刻实现）。
//
// 背景：v20 交付了「熔断登记 needs-human」与「版间门落盘 iterationGates」，但两者只在真实事件时产生，
// 一直停在"未验证"。本脚本把事件**造出来**：
//   · 事件一（熔断）：造一个测试 expr（步骤处于 review）→ 经 POST /steps/update action=reject 连续打回 3 次
//     → 生产代码路径 registerCircuitBreakerSignal 应登记信号（chainId=autoir-circuit，taskId=expr:<id>）。
//   · 事件二（版间门）：造一个 iterations=2 + autoDecision=true 的测试 expr → 经 approve 触发 wakeAfterApproved
//     → 生产代码路径应把门决策落盘为 iterationGates[]（advance 或 blocked 都算落盘成功）。
//
// 零污染设计：所有 expr 状态写进**临时 base 目录**（路由按 payload.workspacePath 派生 <base>/web-relay/…），
// 因此真实 experiments/ 目录**一个文件都不动**。唯一落在真实位置的是信号文件（CC_TASKS_ROOT 派生，与 base 无关）
// —— 那正是我们要验证的产物，脚本结尾会销账清理。
//
// 用法: node verify-autoir-events.mjs
// 退出码：0 两个事件都验证成功 / 1 判定失败 / 3 工具错误
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHumanSignal, readQueue, acknowledgeHumanSignal, writeHumanSignal, buildHumanSignal, writeHumanSignalIfNew, queuePathOf, SIGNAL_PATH } from './chain-human-signal.mjs';

/** 从队列中移除自己的条目 —— **两种路径都清**（规范 `<基础名>.queue.json` + 历史 `<全名>.queue.json`），
 *  否则 readQueue 的合并读取会让"已清掉"的条目从另一条路径又冒出来。规范路径写裸数组（= 约定形态）。 */
function removeFromQueue(id) {
  let removed = 0;
  const writeCanonical = (arr) => fs.writeFileSync(queuePathOf(SIGNAL_PATH), JSON.stringify(arr, null, 2), 'utf8');
  const legacy = `${SIGNAL_PATH}.queue.json`;
  const canonicalKept = readQueue(SIGNAL_PATH).filter((e) => e && e.id !== id);
  writeCanonical(canonicalKept);
  try { fs.writeFileSync(legacy, JSON.stringify([], null, 2), 'utf8'); } catch { /* 无该文件 */ }
  removed = 1;
  return removed;
}

const API = 'http://127.0.0.1:3080/dsh-web-relay/steps/update';
const post = async (body) => {
  const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
};

const results = [];
const ck = (label, cond, detail = '') => { results.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autoir-events-'));
const expDir = path.join(base, 'web-relay', 'experiments');
fs.mkdirSync(expDir, { recursive: true });

// exprId 必须匹配插件的 TRACE_ID_RE = /^expr-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/
const stamp = (offsetSec = 0) => {
  const d = new Date(Date.now() + offsetSec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `expr-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

const mkState = (exprId, extra) => ({
  exprId, status: 'open', phase: 'executing',
  steps: [{ id: 's1', status: 'review', title: '验证用步骤', detail: 'd', acceptance: 'a' }],
  currentStep: 's1', activeSteps: ['s1'],
  iterations: 1, currentIteration: 1, rejectStreak: 0, incrementalStreak: 0, bootId: 'verify-fixture',
  ...extra,
});
const statePath = (exprId) => path.join(expDir, `${exprId}.steps.json`);
const readState = (exprId) => JSON.parse(fs.readFileSync(statePath(exprId), 'utf8'));

// 可用信号 = 主槽 + 队列（主槽被别的来源占着时新信号会入队，不能只看主槽）
const allSignals = () => {
  const out = [];
  const cur = readHumanSignal(SIGNAL_PATH);
  if (cur.ok && cur.entry) out.push(cur.entry);
  try { for (const e of readQueue(SIGNAL_PATH) || []) out.push(e); } catch { /* 无队列 */ }
  return out;
};

console.log('=== 事件一：熔断 → needs-human 登记（生产路径）===');
const id1 = stamp(0);
fs.writeFileSync(statePath(id1), JSON.stringify(mkState(id1), null, 2), 'utf8');
let rejects = 0;
for (let i = 1; i <= 3; i++) {
  // 每次打回前把步骤复位为 review（打回后生产代码会改步骤状态；复位夹具不等于复刻被测逻辑）
  const st = readState(id1);
  const step = st.steps.find((s) => String(s.id) === 's1');
  if (step.status !== 'review') { step.status = 'review'; fs.writeFileSync(statePath(id1), JSON.stringify(st, null, 2), 'utf8'); }
  const r = await post({ workspacePath: base, exprId: id1, stepId: 's1', action: 'reject', comment: `验证：第 ${i} 次打回`, role: 'mainagent' });
  const after = readState(id1);
  rejects = after.rejectStreak || 0;
  console.log(`    第 ${i} 次 reject → HTTP ${r.status} ｜ rejectStreak=${rejects} ｜ status=${after.status}`);
  if (r.status !== 200) { console.log(`    ⚠ 响应：${JSON.stringify(r.body).slice(0, 200)}`); }
}
const sig1 = allSignals().find((e) => String(e.taskId || '') === `expr:${id1}` || String(e.stableKey || '') === `autoir-circuit-${id1}`);
ck('[POS] 熔断后确有信号登记（chainId=autoir-circuit）', !!sig1 && sig1.chainId === 'autoir-circuit', sig1 ? `id=${sig1.id} chainId=${sig1.chainId} taskId=${sig1.taskId} reason=${sig1.reason}` : `未找到；现有信号=${JSON.stringify(allSignals().map((e) => e.id))}`);
ck('[POS] 信号携带**规范 ref**（统一身份，供 ⑩ 精确匹配）', !!sig1 && String(sig1.taskId) === `expr:${id1}`, sig1 ? `taskId=${sig1.taskId}` : '');
ck('[POS] 熔断确实发生（rejectStreak 达 3 且 expr 置 paused）', rejects >= 3 && readState(id1).status === 'paused', `rejectStreak=${rejects} status=${readState(id1).status}`);
if (sig1) {
  // 安全护栏：只有**主槽条目确实是自己**时才销账 —— acknowledgeHumanSignal 作用于主槽，
  // 若我的信号入了队、主槽是**别人的**未销账告警，直接 ack 会把真实告警误清（比漏测严重得多）。
  const main = readHumanSignal(SIGNAL_PATH);
  const isMine = main.ok && main.entry && main.entry.id === sig1.id;
  if (isMine) { acknowledgeHumanSignal('事件一验证产物：合成熔断信号，已核对内容后清理'); console.log('    （已销账清理该信号）'); }
  else console.log(`    ℹ 我的信号在队列中（主槽是 ${main.ok && main.entry ? main.entry.id : '(空)'}）→ **不动主槽**，仅清理队列条目`);
  try { removeFromQueue(sig1.id); console.log('    （已从队列移除自己的条目，两种路径都清）'); } catch { /* 无队列 */ }
}

// ---- 事件一附：队列路径/格式**收敛**的契约验证（**完全无副作用**；2026-09-21 重写）----
// 缺陷回顾：插件曾写 `<全名>.queue.json` + {queue:[…]}，而主 agent 侧读 `<基础名>.queue.json` + 裸数组
// → 路径与格式双双不一致 ⇒ 插件入队的告警在主 agent 侧不可见、永不提升（告警永久卡住）。
//
// ⚠ 为什么要重写（本会话最严重事故）：初版靠**占住真实主槽**来制造条件，而它每轮（审计 30 分钟 + 每次回归）
//   都会往真实信号通道里漏一条 dryRun 占位夹具 —— dryRun 按设计**永不唤醒也永不销账** ⇒ 主槽被永久占住 ⇒
//   真实告警只能排队且无人消费，**通道静默失效数小时**（清点：主槽循环销账 42 条、队列残留 19 条）。
//   更糟的是它**靠自己漏出的夹具满足自己的前提**，所以一直"通过"。教训：验证**共享状态**的用例绝不能用
//   "占用共享状态"的办法制造条件 —— 用**临时文件 + 静态写方契约**，零副作用。
console.log('\n=== 事件一附：队列路径/格式收敛（临时文件 + 静态契约，零副作用）===');
{
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-shape-'));
  const base = path.join(tmp, 'sig.json');
  const canonQ = base.replace(/\.json$/i, '.queue.json');
  const legacyQ = `${base}.queue.json`;
  const entry = (id) => JSON.stringify({ id, chainId: 'c', reason: 'review-needed', at: '2026-09-21T00:00:00.000Z' });

  // ① 规范形态：规范路径 + **裸数组**
  fs.writeFileSync(canonQ, `[${entry('a#g1')}]`, 'utf8');
  ck('[POS] 读得懂规范形态（<基础名>.queue.json + 裸数组）', readQueue(base).some((e) => e.id === 'a#g1'), JSON.stringify(readQueue(base).map((e) => e.id)));

  // ② 旧形态：规范路径 + {queue:[…]}（插件曾写这个；读方必须容忍，否则存量搁浅丢失）
  fs.writeFileSync(canonQ, JSON.stringify({ queue: [JSON.parse(entry('b#g1'))] }), 'utf8');
  ck('[POS] 读得懂旧**形态**（{queue:[…]}，迁移期兼容）', readQueue(base).some((e) => e.id === 'b#g1'), JSON.stringify(readQueue(base).map((e) => e.id)));

  // ③ 旧**路径**：<全名>.queue.json（也必须读，否则搁浅条目永远不可见）
  fs.writeFileSync(canonQ, '[]', 'utf8');
  fs.writeFileSync(legacyQ, `[${entry('c#g1')}]`, 'utf8');
  ck('[POS] 读得懂旧**路径**（<全名>.queue.json）', readQueue(base).some((e) => e.id === 'c#g1'), JSON.stringify(readQueue(base).map((e) => e.id)));

  // ④ 两路径合并 + 按 id 去重（否则重复提升/重复唤醒）
  //    规范：[d#g1, dup#g1]；旧路径：[dup#g1, e#g1] → 共 4 条、去重后 **3** 个不同 id（d/dup/e）。
  //    （初版期望写成 4 —— 是我把"4 条"误当"4 个不同 id"；实现正确，期望错了。）
  fs.writeFileSync(canonQ, `[${entry('d#g1')},${entry('dup#g1')}]`, 'utf8');
  fs.writeFileSync(legacyQ, `[${entry('dup#g1')},${entry('e#g1')}]`, 'utf8');
  const merged = readQueue(base).map((x) => x.id);
  ck('[POS] 两路径**合并去重**（4 条 → 3 个不同 id，dup 只留 1 次）',
    merged.length === 3 && merged.filter((x) => x === 'dup#g1').length === 1 && ['d#g1', 'dup#g1', 'e#g1'].every((x) => merged.includes(x)),
    JSON.stringify(merged));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }

  // ⑤ 静态写方契约：插件必须写**规范路径 + 裸数组**（读方容忍两种 ≠ 写方可以随便写）
  const pluginSrc = fs.readFileSync('D:/dsh-web-relay/lib/index.js', 'utf8');
  const canonicalPath = /PENDING_HUMAN_PATH\.replace\(\/\\\.json\$\/i,\s*'\.queue\.json'\)/.test(pluginSrc);
  const bareArrayWrite = /writeFile\(queueFile,\s*JSON\.stringify\(q,\s*null,\s*2\)\)/.test(pluginSrc);
  ck('[POS] 插件写方：规范路径（replace 推导）', canonicalPath, canonicalPath ? 'ok' : '未用 <基础名>.queue.json 约定');
  ck('[POS] 插件写方：**裸数组**（非 {queue:[…]}）', bareArrayWrite, bareArrayWrite ? 'ok' : '写的是对象形态 → 与主 agent 侧不一致的旧缺陷会复发');
}

console.log('\n=== 事件二：版间门 → iterationGates 落盘（生产路径）===');
// ⚠ 关键（2026-09-20 实测）：版间门在 wakeAfterApproved 里，而它**只被 `action==='complete' && autoPass` 调用**
//   （以及批量/自动评审两处）。**手动 `approve` 收口不经过版间门** —— 直接用 approve 验不到它（首版就这么错过了）。
//   autoPass 判据：step.review === false（或 importance=low 且未显式指定 review）；且 complete 要求步骤为 executing/pending。
const id2 = stamp(1);
fs.writeFileSync(statePath(id2), JSON.stringify(mkState(id2, {
  iterations: 2, currentIteration: 1, autoDecision: true, finalAcceptance: '验证用最终验收标准',
  steps: [{ id: 's1', status: 'executing', review: false, title: '验证用步骤', detail: 'd', acceptance: 'a' }],
  activeSteps: ['s1'],
}), null, 2), 'utf8');
const r2 = await post({ workspacePath: base, exprId: id2, stepId: 's1', action: 'complete', comment: '验证：complete 自动豁免触发版间门', role: 'mainagent' });
const st2 = readState(id2);
const gates = Array.isArray(st2.iterationGates) ? st2.iterationGates : null;
console.log(`    complete(autoPass) → HTTP ${r2.status} ｜ currentIteration=${st2.currentIteration}/${st2.iterations} ｜ status=${st2.status}`);
console.log(`    iterationGates = ${gates && gates.length ? JSON.stringify(gates) : '(空)'}`);
ck('[POS] 版间门落盘了 iterationGates 记录（advance 或 blocked 都算）', !!gates && gates.length >= 1, gates && gates.length ? `decision=${gates.map((g) => g.decision).join(',')}` : '无该字段');
ck('[POS] 门记录自洽（advance 时 from/to 与迭代计数一致）',
  !!gates && gates.some((g) => g.decision === 'advance' && g.from === 1 && g.to === 2 && st2.currentIteration === 2),
  gates && gates.length ? JSON.stringify(gates[0]).slice(0, 200) : '(无记录)');
ck('[POS] 门记录携带规范 ref（统一身份）', !!gates && gates.length > 0 && String(gates[0].ref || '') === `expr:${id2}`, gates && gates.length ? `ref=${gates[0].ref}` : '(无记录)');

// ---- 附：把"手动 approve 不经过版间门"这一路径不对称记成**实测事实**（信息项，不作为失败判定）----
const id3 = stamp(2);
fs.writeFileSync(statePath(id3), JSON.stringify(mkState(id3, {
  iterations: 2, currentIteration: 1, autoDecision: true, finalAcceptance: 'x',
  steps: [{ id: 's1', status: 'review', title: 't', detail: 'd', acceptance: 'a' }],
}), null, 2), 'utf8');
await post({ workspacePath: base, exprId: id3, stepId: 's1', action: 'approve', comment: '手动批准', role: 'mainagent' });
const st3 = readState(id3);
console.log(`  ℹ 路径不对称实测：手动 approve → status=${st3.status} currentIteration=${st3.currentIteration}/${st3.iterations} iterationGates=${JSON.stringify(st3.iterationGates || [])}（版间门未被咨询；全部步骤 approved 即置 done）`);

// ---- 负控：未达上限（只打回 2 次）**不得**登记信号 ----
// 没有这条，本脚本就是"永真门禁"：它只证明"打回 3 次后有信号"，却没证明"信号是 trip 驱动的"
// （被 verify-gates 规则 A 抓到：缺少 [NEG] 负控 → 可能是永真门禁）。
const id4 = stamp(3);
fs.writeFileSync(statePath(id4), JSON.stringify(mkState(id4), null, 2), 'utf8');
for (let i = 1; i <= 2; i++) {
  const st = readState(id4);
  const step = st.steps.find((s) => String(s.id) === 's1');
  if (step.status !== 'review') { step.status = 'review'; fs.writeFileSync(statePath(id4), JSON.stringify(st, null, 2), 'utf8'); }
  await post({ workspacePath: base, exprId: id4, stepId: 's1', action: 'reject', comment: `负控第 ${i} 次（不达上限）`, role: 'mainagent' });
}
const sig4 = allSignals().find((e) => String(e.taskId || '') === `expr:${id4}`);
ck('[NEG] 只打回 2 次（未达上限 3）→ **不得**登记熔断信号（证明登记是 trip 驱动的，不是永真）',
  !sig4 && readState(id4).status !== 'paused', `rejectStreak=${readState(id4).rejectStreak} status=${readState(id4).status} 信号=${sig4 ? sig4.id : '(无)'}`);

// 清理临时 base
try { fs.rmSync(base, { recursive: true, force: true }); console.log('\n（临时 base 已删除，真实 experiments/ 未改动）'); } catch { /* 忽略 */ }

// ---- FINAL-SWEEP（2026-09-20 补）：本脚本会往**真实信号通道**写占位夹具（队列收敛用例），
// 初版只清自己那一条、不清 blocker → 每次跑门禁都在真实通道留残渣，实测把 5 条 verify-blocker 堆进队列，
// 还把我自己的 v22 清单**埋在队列里**（boot 扫描只读主槽 → 清单永不被消费 → ⑨ 一直"未验证"）。
// 故收尾统一清扫自己造的所有合成条目；真实告警一律保留。
{
  const SYNTH2 = ['verify-blocker-', 'wake-path-probe-', 'post-restart-verify-probe-'];
  const isS = (e) => e && SYNTH2.some((x) => String(e.id || '').startsWith(x));
  try {
    const qq = readQueue(SIGNAL_PATH) || [];
    const mine = qq.filter(isS);
    for (const e of mine) removeQueueEntry(e.id);
    const mm = readHumanSignal(SIGNAL_PATH);
    // 主槽若被我造的夹具占着 → 销账（会提升队列中的真实条目）；**绝不**动非合成条目
    if (mm.ok && mm.entry && isS(mm.entry) && !mm.entry.acknowledgedAt) acknowledgeHumanSignal('本探针收尾：清理合成占位夹具');
    if (mine.length) console.log(`  （收尾清扫：从队列移除 ${mine.length} 条合成夹具）`);
  } catch { /* 收尾失败不影响判定 */ }
}

const bad = results.filter((r) => !r.cond).length;
console.log(`\nRESULT: ${results.length - bad}/${results.length} ${bad ? 'FAIL' : 'PASS'}`);
process.exit(bad ? 1 : 0);
