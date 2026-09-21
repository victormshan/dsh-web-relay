// ④ 链条运行审计：把「25 次重派循环」那类问题从"靠运气在例行核对中撞见"变成**每周期自动发现**。
//
// 背景（2026-09-16 实测事故）：verify-rejected 在可重派列表里 + 每 20 分钟触发 = 持久性失败无限重派，
//   共 25 次、约 87 分钟 cc 执行时间，且**没有任何一处告警**。当时是主 agent 在例行状态核对时偶然发现的。
//
// 本审计做两件事：
//   ① **不变量断言**（状态必须自洽）——判据抽成纯函数 auditChainRun 以便两侧自检；
//   ② **每周期统计**——每项派发次数、验收结果、配额暂停、护栏触发；其中「单项派发次数 > 上限」正是循环签名。
//
// 用法: node verify-chain-run.mjs [--json] [--max-attempts 3]
//       node verify-chain-run.mjs --selftest      # 两侧自检（[POS] 合法状态放行 / [NEG] 各类违约必须被抓）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CC = 'D:\\cc-tasks';
const WORK = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '));

const ALLOWED_STATUS = new Set([
  'accepted-awaiting-review', 'approved-and-closed', 'already-approved',
  'quota-paused', 'waiting', 'verify-rejected', 'dispatch-failed', 'spec-broken',
  'closure-blocked', 'closure-failed', 'closure-timeout', 'review-rejected',
  'self-review-rejected', 'reviewer-too-weak', 'probe-broken', 'paused-too-many-attempts',
  'awaiting-gate', 'gate-check-failed',
]);

/** 纯函数：审计一次链条运行。返回 { ok, violations[], stats }。
 *  currentTaskIds：**当前装填链条**的 taskId 列表——只有它们的派发次数算违约；
 *  其它 taskId 属历史链条，单独记入 stats.historicalLoops（信息项），避免历史事故永远把审计染红。 */
export function auditChainRun({ state, itemCount = null, logText = '', maxAttempts = 3, currentTaskIds = [] }) {
  const violations = [];
  const stats = { chainId: state?.chainId ?? null, index: state?.index ?? null, itemCount, completedAt: state?.completedAt ?? null, statuses: {}, dispatchesPerTask: {}, maxDispatches: 0, quotaPauses: 0, guardTrips: 0, historicalLoops: {} };

  if (!state || typeof state !== 'object') return { ok: false, violations: ['状态对象缺失或不可解析'], stats };
  if (!state.chainId) violations.push('chainId 缺失（状态归属不明——曾导致换链条时状态被继承、新链条永不派发）');

  const n = Number.isFinite(itemCount) ? itemCount : null;
  const idx = state.index;
  if (!Number.isInteger(idx) || idx < 0) violations.push(`index 非法：${JSON.stringify(idx)}`);
  if (n !== null && Number.isInteger(idx) && idx > n) violations.push(`index(${idx}) > 项数(${n})`);

  const done = !!state.completedAt;
  if (done && n !== null && idx !== n) violations.push(`已置 completedAt 但 index(${idx}) ≠ 项数(${n})——"已完成"与事实不符`);
  if (!done && n !== null && idx === n && n > 0) violations.push(`index 已达项数但未置 completedAt——完成标记漏写`);

  if (state.quotaResetsAt && !Number.isFinite(Date.parse(state.quotaResetsAt))) {
    violations.push(`quotaResetsAt 不可解析：${JSON.stringify(state.quotaResetsAt)}`);
  }

  for (const [label, v] of Object.entries(state.items || {})) {
    const st = v && v.status;
    stats.statuses[st || '(未设)'] = (stats.statuses[st || '(未设)'] || 0) + 1;
    if (st && !ALLOWED_STATUS.has(st)) violations.push(`项「${label}」状态不在白名单：${st}`);
    if (typeof v?.failCount === 'number' && v.failCount > maxAttempts) {
      violations.push(`项「${label}」failCount(${v.failCount}) 超过上限 ${maxAttempts}——护栏未生效`);
    }
    if (st === 'paused-too-many-attempts') stats.guardTrips++;
    if (st === 'probe-broken') violations.push(`项「${label}」为 probe-broken（验收工具自身出错，需人修工具而非重派）`);
  }

  // 派发次数统计（**只吃一份日志**：chain.log 与 chain-sched.log 内容重叠，同时读会把次数翻倍——
  // 本文件初版正是这样把 26 次报成 52 次）
  const cur = new Set(currentTaskIds);
  for (const m of logText.matchAll(/派发: \[spec\] taskId=([A-Za-z0-9_.-]+)/g)) {
    stats.dispatchesPerTask[m[1]] = (stats.dispatchesPerTask[m[1]] || 0) + 1;
  }
  stats.quotaPauses = (logText.match(/额度不可用，暂停链条/g) || []).length;
  const curCounts = currentTaskIds.map((id) => stats.dispatchesPerTask[id] || 0);
  stats.maxDispatches = Math.max(0, ...curCounts);
  for (const [id, c] of Object.entries(stats.dispatchesPerTask)) {
    if (c > maxAttempts) {
      if (cur.has(id)) violations.push(`taskId ${id} 被派发 ${c} 次（上限 ${maxAttempts}）——**当前链条的重派循环签名**`);
      else stats.historicalLoops[id] = c;
    }
  }

  return { ok: violations.length === 0, violations, stats };
}

if (process.argv.includes('--selftest')) {
  const base = { chainId: 'c1', index: 2, completedAt: null, items: { a: { status: 'accepted-awaiting-review' }, b: { status: 'quota-paused' } } };
  const cases = [
    ['[POS] 自洽状态（index 2/2 未完成项）→ 放行', { state: { ...base, index: 1 }, itemCount: 2, logText: '派发: [spec] taskId=t1' }, true],
    ['[POS] 已完成且 index == 项数 → 放行', { state: { chainId: 'c', index: 2, completedAt: '2026-01-01T00:00:00Z', items: {} }, itemCount: 2, logText: '' }, true],
    ['[NEG] 缺 chainId → 抓', { state: { index: 0, items: {} }, itemCount: 1, logText: '' }, false],
    ['[NEG] index > 项数 → 抓', { state: { chainId: 'c', index: 5, items: {} }, itemCount: 2, logText: '' }, false],
    ['[NEG] completedAt 已置但 index ≠ 项数 → 抓', { state: { chainId: 'c', index: 1, completedAt: 'x', items: {} }, itemCount: 2, logText: '' }, false],
    ['[NEG] index 达项数却漏写 completedAt → 抓', { state: { chainId: 'c', index: 2, items: {} }, itemCount: 2, logText: '' }, false],
    ['[NEG] 未知项状态 → 抓', { state: { chainId: 'c', index: 0, items: { a: { status: 'weird-status' } } }, itemCount: 1, logText: '' }, false],
    ['[NEG] failCount 超上限 → 抓', { state: { chainId: 'c', index: 0, items: { a: { status: 'verify-rejected', failCount: 9 } } }, itemCount: 1, logText: '' }, false],
    ['[NEG] 重派循环签名（**当前链条**同一 taskId 派发 25 次）→ 抓', { state: { chainId: 'c', index: 0, items: {} }, itemCount: 1, logText: Array(25).fill('派发: [spec] taskId=tX kind=understand').join('\n'), currentTaskIds: ['tX'] }, false],
    ['[POS] 历史链条曾有循环，但当前链条干净 → 放行（历史记入 historicalLoops）', { state: { chainId: 'c', index: 0, items: {} }, itemCount: 1, logText: Array(25).fill('派发: [spec] taskId=oldLoop kind=understand').join('\n'), currentTaskIds: ['tNew'] }, true],
    ['[NEG] probe-broken → 抓（工具错误需人修，不是重派）', { state: { chainId: 'c', index: 0, items: { a: { status: 'probe-broken' } } }, itemCount: 1, logText: '' }, false],
    ['[NEG] quotaResetsAt 不可解析 → 抓', { state: { chainId: 'c', index: 0, items: {}, quotaResetsAt: 'not-a-date' }, itemCount: 1, logText: '' }, false],
  ];
  let bad = 0;
  for (const [name, input, expectOk] of cases) {
    const r = auditChainRun(input);
    const ok = r.ok === expectOk;
    if (!ok) bad++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : `（期望 ok=${expectOk}，实际 ${r.ok}：${r.violations.join('；')}）`}`);
  }
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

// ---- CLI：审计真实运行 ----
const maxAttempts = Number((() => { const i = process.argv.indexOf('--max-attempts'); return i >= 0 ? process.argv[i + 1] : 3; })());
const stateFile = path.join(CC, 'chain-state.json');
let state = null; let parseErr = null;
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { parseErr = String(e.message); }

// 关键：审计要拿**状态自己所属链条**（state.chainId）的项数，而不是当前指针所指链条的项数。
// （初版用指针项数比旧状态 → 在"已换指针、新链条尚未首次运行"的过渡窗口误报假违约；
//   二版用正则数 `{ label:` → 对多行写法（label 与 { 不同行）会数成 0。故改为**直接 import 链条模块**取 items。）
const chainDir = path.join(WORK, 'cc-chains');
const chainDefs = [];
try {
  for (const f of fs.readdirSync(chainDir)) {
    if (!f.endsWith('.mjs') || f.startsWith('_')) continue;
    try {
      const m = await import(pathToFileURL(path.join(chainDir, f)).href);
      const c = m.chain ?? m.default;
      if (c && c.id) chainDefs.push({ file: f, id: c.id, items: Array.isArray(c.items) ? c.items : [] });
    } catch { /* 个别链条定义不可解析则跳过 */ }
  }
} catch { /* 目录不可读 */ }

const stateChainDef = state ? chainDefs.find((c) => c.id === state.chainId) : null;
const stateChainFile = stateChainDef ? stateChainDef.file : null;
const stateItemCount = stateChainDef ? stateChainDef.items.length : null;
const stateTaskIds = stateChainDef ? stateChainDef.items.map((it) => it.taskId).filter(Boolean) : [];

let pointerChain = null; let pointerItemCount = null; let pointerChainId = null;
try {
  pointerChain = fs.readFileSync(path.join(CC, 'current-chain.txt'), 'utf8').trim().split(/\s+/)[0];
  const def = chainDefs.find((c) => pointerChain.endsWith(c.file));
  pointerChainId = def ? def.id : null;
  pointerItemCount = def ? def.items.length : null;
} catch { /* 指针不可读 */ }

// **只读一份日志**：chain.log 是链条自身日志，chain-sched.log 是其 stdout 重定向副本，
// 同时读会把派发次数翻倍（初版把 26 次报成 52 次）。优先 chain.log，缺失才退回 sched 日志。
let logText = '';
let logSource = '(无)';
try { logText = fs.readFileSync(path.join(CC, 'chain.log'), 'utf8'); logSource = 'chain.log'; }
catch { try { logText = fs.readFileSync(path.join(CC, 'chain-sched.log'), 'utf8'); logSource = 'chain-sched.log（退回）'; } catch { /* 无日志 */ } }

console.log('=== ④ 链条运行审计 ===');
console.log(`  状态归属链条 = ${state ? state.chainId : '(不可解析)'}${stateChainFile ? `（${stateChainFile}，项数 ${stateItemCount}）` : '（**找不到对应链条定义**，项数相关断言跳过）'}`);
console.log(`  当前装填指针 = ${pointerChain || '(读不到)'}${pointerItemCount !== null ? `（项数 ${pointerItemCount}）` : ''} ｜ 日志源 = ${logSource}`);
// 过渡窗口检测：指针所指链条的 id 与状态归属不同 → 属"已换链条、尚未首次运行"，非违约
if (state && pointerChainId && state.chainId && pointerChainId !== state.chainId) {
  console.log(`  ℹ 指针(${pointerChainId}) 与状态归属(${state.chainId}) 不一致：属"已换链条、尚未首次运行"的过渡窗口，非违约`);
}
if (!state) { console.log('\n  RESULT: FAIL（状态文件不可解析 → 不变量无法断言）'); process.exit(1); }
const r = auditChainRun({ state, itemCount: stateItemCount, logText, maxAttempts, currentTaskIds: stateTaskIds });
console.log(`  chainId=${r.stats.chainId} ｜ index=${r.stats.index}${stateItemCount !== null ? '/' + stateItemCount : ''} ｜ completedAt=${r.stats.completedAt || '(未设)'}`);
console.log(`  项状态分布 = ${JSON.stringify(r.stats.statuses)}`);
console.log(`  当前链条单项最大派发 = ${r.stats.maxDispatches}（上限 ${maxAttempts}）｜ 配额暂停 ${r.stats.quotaPauses} 次 ｜ 护栏触发 ${r.stats.guardTrips} 次`);
const hist = Object.entries(r.stats.historicalLoops);
if (hist.length) console.log(`  历史链条的超限派发（信息项，非本次违约）= ${hist.map(([k, v]) => `${k}×${v}`).join(', ')}`);
for (const v of r.violations) console.log(`  ✗ ${v}`);
console.log(`\n  RESULT: ${r.ok ? 'PASS（不变量全部成立）' : `FAIL（${r.violations.length} 项违约）`}`);
if (process.argv.includes('--json')) fs.writeFileSync(path.join(CC, 'chain-run-audit.json'), JSON.stringify({ at: new Date().toISOString(), ...r }, null, 2), 'utf8');
process.exit(r.ok ? 0 : 1);
