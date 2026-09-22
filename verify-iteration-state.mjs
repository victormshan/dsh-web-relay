// ⑩ 迭代状态机审计 —— 覆盖四类任务载体里**唯一没有审计层**的那一个（三方协议 step list）。
//
// 为什么需要（2026-09-20 分析得出）：链条有 ④、唤醒通路有 ⑨，而"版本迭代卡住了没有"无人管。
// step list 恰恰是「人工缺席下的自动版本演化」的**实际载体**（iterations / autoDecision / 版间门 /
// 熔断），它卡住时是**静默**的 —— 与影子沙盒死掉数月、信号唤醒零痕迹同型。
//
// ── 判据（先定，后写实现；不得事后调整）────────────────────────────────────────
//  ★ 范围由**权威实现**决定，不由本文件重写：直接只读导入仓库 `lib/resume-scan.js` 的
//    `isScanEligible` / `isExprInterrupted`。理由＝"唯一收敛原语"：若我另写一套"什么算中断"，
//    就会出现两个判定源，二者不一致时无人能裁决。导入失败 → fail-open 且**显式未验证**（不是静默通过）。
//
//  J1 停滞：`isExprInterrupted(st, 当前bootId)` 为真（有 busy 步骤 + 跨 boot 未完成）且
//      `updatedAt` 距今 > STALL_MS → **1 失败**。语义：跨重启续跑本该救活它，长时间无进展＝
//      无人值守下的静默停摆（这正是"自动演化"最该被发现的状态）。
//  J2 熔断未登记：`status==='paused'` 或 `stopReason` 含「熔断」→ 盘上必须已有 needs-human 对象
//      （信号文件里出现该 exprId）→ 否则 **1 失败**。附注：插件当前**只** console.warn + webhook +
//      写 stopReason，**从不**写 chain-needs-human.json —— 故一旦发生熔断，本判据必然报失败：这是
//      设计上的 backstop（"停下了但没人知道"必须响）。
//  J3 终态自洽：`status==='stopped'` 必须有 `stopReason`；`finalized===true` 必须有 `finalizedAt`。
//      违反 → **1 失败**（状态标记与事实不符：恢复扫描与心跳都按 status 决策）。
//  J4 声明自洽（仅 autoDecision=true）：`iterations` ∈ 1..10 整数；`currentIteration` ∈ [1, iterations]（若存在）；
//      `rejectStreak` ≤ 2（≥3 本应已 paused）。违反 → **1 失败**。
//  J5 版间门：若存在「autoDecision=true 且未 finalized 且 currentIteration ≥ 2」的在办 expr →
//      必须有版间门落盘证据；**当前协议无此对象** → 有对象时判 **4 未验证**（诚实：协议声明了版间门，
//      但没有可审计的落盘物）；无此对象时 PASS（"无对象"不等于"未验证"，与 ⑨ 的 B 判据同一模式）。
//  信息项（**不判失败**）：实质已收口（status=done 且步骤全 approved）但缺 `finalized` 标记的历史 expr
//      —— 实测 10 条皆为 2026-08 的 legacy 记录，字段本就缺失；报计数，不当违约（防假告警）。
//
// 退出码：0 通过 / 1 判定失败 / 3 工具错误 / 4 未验证。**未验证不得读成通过。**
//
// 用法: node verify-iteration-state.mjs [--json] [--stall-ms N]
//       node verify-iteration-state.mjs --selftest           # 判定两侧自检
//       node verify-iteration-state.mjs --selftest-parsers   # 解析器与写方契约自检（lesson L-089）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const REPO = 'D:\\dsh-web-relay';
export const WORKSPACE = 'D:\\dsh relay test';
export const EXP_DIR = 'D:\\dsh relay test\\web-relay\\experiments';
export const SIGNAL_PATH = 'D:\\cc-tasks\\chain-needs-human.json';
const HEALTH_URL = 'http://127.0.0.1:3080/dsh-web-relay/health-check';
const CONTEXT_URL = 'http://127.0.0.1:3080/dsh-web-relay/context';
const VERSIONS_URL = 'http://127.0.0.1:3080/dsh-web-relay/protocol/versions';
const AUDIT_ALL_SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' ')), 'audit-all.mjs');
const AUDIT_LATEST_JSON = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' ')), 'audit-latest.json');

// v4.11.0 步12: "仅被直接执行时才响应 argv flag" 守卫（与 lib/autoiter-decl.js 同一 idiom）。
// 背景：verify-gates.mjs 现在要 `import { resolveArtifactPath, readStepStates, REPO, EXP_DIR }`
// 只读引用本文件——但 process.argv 是**进程级全局**，`node verify-gates.mjs --selftest` 跑起来后，
// 本文件顶层若只判断 `process.argv.includes('--selftest')`（不问"我是不是被直接执行的那个脚本"），
// 会在**被 import 的时刻**就把自己的 --selftest 跑一遍并 process.exit()——把调用方（verify-gates.mjs）
// 的 --selftest 直接顶掉，输出看起来像是"verify-gates.mjs 的自检"实际全是本文件的（现场复现过一次）。
// 下面三处（--selftest / --selftest-parsers / CLI 真跑）全部加 isDirectRun 前置，就不会再被 import 触发。
const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

/** 停滞阈值（policy 常量，可用 --stall-ms 覆盖；**不随判定结果调整**）。
 *  取 6h 的理由：心跳对 executing 的陈旧阈值是 20min（DSH_RELAY_HEARTBEAT_STALE_MS），
 *  而单一合法步骤的耗时可能远超之；6h = 18×心跳阈值，既高于任何合理单步时长，
 *  又能在一个人工工作时段内暴露"跨重启续跑也没救活"的停摆。 */
export const STALL_MS_DEFAULT = 6 * 60 * 60 * 1000;

/** 策略常量：early-close（手动提前收口落记录）机制的引入时刻。
 *  早于它收口的历史 expr 本就无记录可查 → 归信息项；晚于它仍无记录 → J6 判违约。
 *  与 STALL_MS 同类：是"策略"而非"随判定结果调整的阈值"，可用 --early-close-since 覆盖。 */
export const EARLY_CLOSE_SINCE_MS_DEFAULT = Date.parse('2026-09-20T19:00:00.000Z');

// ---- 权威实现导入（只读、fail-open、可自证）----
let SR = null;
let SR_ERR = null;
try {
  SR = await import(pathToFileURL(path.join(REPO, 'lib', 'resume-scan.js')).href);
} catch (err) {
  SR_ERR = String((err && err.message) || err);
}
export const RESUME_MODULE_LOADED = !!(SR && typeof SR.isExprInterrupted === 'function');
const authoritative = (st, bootId) => {
  if (RESUME_MODULE_LOADED && typeof SR.isScanEligible === 'function' && !SR.isScanEligible(st)) return false;
  if (!RESUME_MODULE_LOADED) return null; // 未知：不得自行推断
  return SR.isExprInterrupted(st, bootId);
};

// ---- 统一身份（唯一来源）：只读导入仓库 lib/task-ref.mjs ----
// 用途①：J2 的"该对象是否已登记"改为**规范 ref 精确匹配**（旧实现是在信号 detail 里 grep 散文 exprId
//   —— 措辞一改就失配，属脆弱判据）；用途②：写入方（插件熔断登记）用同一模块产出 taskId。
let TR = null;
let TR_ERR = null;
try { TR = await import(pathToFileURL(path.join(REPO, 'lib', 'task-ref.mjs')).href); } catch (err) { TR_ERR = String((err && err.message) || err); }
export const TASKREF_MODULE_LOADED = !!(TR && typeof TR.sameRef === 'function');
const refSame = (a, b) => (TASKREF_MODULE_LOADED ? TR.sameRef(a, b) : String(a) === String(b));
const refOf = (exprId) => (TASKREF_MODULE_LOADED ? TR.makeRef('expr', String(exprId)) : String(exprId));
/** 判定某信号是否"登记了该 expr"：规范 ref 精确匹配优先；legacy 裸串（历史信号）要求 id 逐字相等，
 *  绝不回退到"包含"匹配（包含匹配正是旧实现的病根）。 */
function signalCoversExpr(sig, exprId) {
  if (!sig) return false;
  const want = refOf(exprId);
  if (sig.taskId && refSame(sig.taskId, want)) return true;
  // legacy：历史信号未带 taskId，或带了裸串
  if (sig.taskId && String(sig.taskId).trim() === String(exprId)) return true;
  return false;
}

/** 读 experiments 目录全部 steps.json（解析器，可被 --selftest-parsers 覆盖）。 */
export function readStepStates(dir = EXP_DIR) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /^expr-.+\.steps\.json$/.test(f)); } catch { return out; }
  for (const f of names) {
    try { out.push({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }); } catch { /* 跳过坏文件 */ }
  }
  return out;
}

/** 读信号（主槽 + 队列）**整体对象**（保留 taskId 供规范 ref 匹配；不再只抽散文里的 exprId）。 */
export function readSignals(file = SIGNAL_PATH) {
  const out = [];
  const take = (o) => { if (o && typeof o === 'object' && o.id) out.push({ id: o.id, chainId: o.chainId || null, reason: o.reason || null, taskId: o.taskId || null, stableKey: o.stableKey || null, at: o.at || null, acknowledgedAt: o.acknowledgedAt || null, detail: String(o.detail || '') }); };
  try { take(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* 无主槽 */ }
  try { const q = JSON.parse(fs.readFileSync(`${file}.queue.json`, 'utf8')); for (const e of q.queue || []) take(e); } catch { /* 无队列 */ }
  return out;
}

const t = (s) => { const v = Date.parse(s); return Number.isFinite(v) ? v : null; };
const isBusyStep = (s) => s && (s.status === 'executing' || s.status === 'review');
const allApproved = (st) => Array.isArray(st.steps) && st.steps.length > 0 && st.steps.every((s) => s && s.status === 'approved');
/** 实质已收口：**不能只看 finalized 标记**。实测（2026-09-20）历史 expr 普遍缺 finalized 字段，
 *  但 status=done + 步骤全 approved 已是收口事实 —— 用标记判作用域会把 9 条 legacy 记录误当在办对象
 *  （J5 因此假报未验证，被现场跑抓到）。判据要落在事实上，不落在标记上。 */
const substantivelyClosed = (st) => {
  if (!st) return true;
  if (st.finalized === true || st.archivedAt) return true;
  if (st.status === 'done' || st.status === 'stopped' || st.status === 'paused') return true;
  return allApproved(st);
};

/**
 * 纯函数：按 J1..J6 给出结论。
 * @param {{states:Array, liveBootId:string|null, signals:Array, nowMs:number, stallMs:number, earlyCloseSinceMs:number}} inp
 */
export function judgeIterationState(inp) {
  const { states = [], liveBootId = null, signals = [], nowMs = Date.now(), stallMs = STALL_MS_DEFAULT, earlyCloseSinceMs = EARLY_CLOSE_SINCE_MS_DEFAULT } = inp || {};
  const findings = [];
  const info = [];
  const earlyCloseMissing = [];
  const add = (id, exit, detail) => findings.push({ id, verdict: exit === 0 ? 'PASS' : exit === 1 ? 'FAIL' : exit === 3 ? 'INSTRUMENT-ERROR' : 'UNVERIFIED', exit, detail });

  if (!liveBootId) { add('范围', 3, '读不到活 bootId → 无法用权威实现判定"是否跨 boot 中断"，工具错误'); return { exit: 3, findings, info }; }
  if (!RESUME_MODULE_LOADED) { add('范围', 4, `无法只读导入权威实现 lib/resume-scan.js（${SR_ERR || '未知原因'}）→ fail-open 且显式未验证（不自行推断"什么算中断"）`); return { exit: 4, findings, info }; }

  const interrupted = [];
  for (const st of states) {
    const r = authoritative(st, liveBootId);
    if (r === true) interrupted.push(st);
    else if (st && st.status === 'done' && allApproved(st) && st.finalized !== true) {
      info.push(`${st.exprId}：实质已收口（status=done 且步骤全 approved）但缺 finalized 标记${st.archivedAt ? '（已归档）' : ''}`);
    }
  }

  // 2026-09-20（按主 agent 决策 (b)）：**提前收口必须有记录** → J6。
  // 该机制（手动收口落 early-close 记录）于下方常量时刻引入；早于它收口的历史 expr 本就无记录可查，
  // 归为**信息项**（不判违约、也不读成通过）。常量是**策略常量**，可用 --early-close-since 覆盖。
  for (const st of states) {
    if (!st || st.autoDecision !== true || !Number.isInteger(st.iterations) || st.iterations <= 1) continue;
    const ci = Number.isInteger(st.currentIteration) ? st.currentIteration : 1;
    if (!substantivelyClosed(st) || ci >= st.iterations) continue;
    const gates = Array.isArray(st.iterationGates) ? st.iterationGates : null;
    const documented = !!gates && gates.some((g) => g && ['early-close', 'blocked', 'finalized', 'advance'].includes(g.decision));
    if (documented || st.stopReason) continue;   // 有记录或有停止原因 → 已可解释
    // ⚠ 2026-09-20 修正：豁免键必须是**收口事实**（finalizedAt/stoppedAt），**不能是 updatedAt** ——
    // 任何顺手写入（协议写回/trace 追加/boot 扫描）都会把 updatedAt 顶到"最近"，于是 09-15 就收口的
    // 历史记录被误判成"机制引入后收口" → J6 假失败（实测本会话 expr-2026-09-13_17-36-07：
    // finalizedAt=2026-09-15T11:49Z，updatedAt=2026-09-20T19:06Z）。判据落在事实上，不落在标记上（L-090）。
    // 收口时刻确实缺失时才退回 updatedAt —— 那时它至少是唯一可用的时间证据。
    const closedAt = t(st.finalizedAt) ?? t(st.stoppedAt) ?? t(st.updatedAt);
    const closedAtText = st.finalizedAt || st.stoppedAt || st.updatedAt;
    if (closedAt === null || closedAt < earlyCloseSinceMs) {
      info.push(`${st.exprId}：声明 ${st.iterations} 版却在 V${ci} 收口且无门记录（早于 early-close 机制引入的历史记录，不判违约；收口时刻=${closedAtText}）`);
    } else {
      earlyCloseMissing.push(`${st.exprId}@V${ci}/${st.iterations}（收口时刻=${closedAtText}）`);
    }
  }
  add('J6-提前收口有记录', earlyCloseMissing.length ? 1 : 0,
    earlyCloseMissing.length
      ? `声明多版却在未走完时收口、且无任何门记录（early-close/blocked/finalized/advance 之一）：${earlyCloseMissing.join('、')} → 决策没有落成盘上对象`
      : '所有"未走完声明版数即收口"的 expr 都有对应门记录（或属早于机制引入的历史记录）');

  // ---- J1 停滞 ----
  const stalled = interrupted.filter((st) => { const u = t(st.updatedAt); return u !== null && nowMs - u > stallMs; });
  add('J1-停滞', stalled.length ? 1 : 0,
    stalled.length
      ? `有 ${stalled.length} 个 expr 处于「跨 boot 未完成且长时间无进展」：${stalled.map((s) => `${s.exprId}（updatedAt=${s.updatedAt}，超出阈值 ${Math.round(stallMs / 3600000)}h）`).join('；')}`
      : `无"跨 boot 未完成且超 ${Math.round(stallMs / 3600000)}h 无进展"的 expr（跨 boot 中断中的共 ${interrupted.length} 个）`);

  // ---- J2 熔断未登记（规范 ref 精确匹配；见 signalCoversExpr）----
  const tripped = states.filter((st) => st && (st.status === 'paused' || /熔断/.test(String(st.stopReason || ''))));
  const untracked = tripped.filter((st) => !signals.some((sig) => signalCoversExpr(sig, st.exprId)));
  add('J2-熔断未登记', untracked.length ? 1 : 0,
    untracked.length
      ? `已熔断却未登记 needs-human：${untracked.map((s) => s.exprId).join('、')} → 停下了但无人会被叫醒`
      : `无「已熔断但未登记」的 expr（熔断态共 ${tripped.length} 个，均已登记或不存在）`);

  // ---- J3 终态自洽 ----
  const bad3 = [];
  for (const st of states) {
    if (!st) continue;
    if (st.status === 'stopped' && !st.stopReason) bad3.push(`${st.exprId}：status=stopped 却无 stopReason`);
    if (st.finalized === true && !st.finalizedAt) bad3.push(`${st.exprId}：finalized=true 却无 finalizedAt`);
  }
  add('J3-终态自洽', bad3.length ? 1 : 0, bad3.length ? bad3.join('；') : '终态标记与字段自洽');

  // ---- J4 声明自洽（仅 autoDecision=true）----
  const bad4 = [];
  for (const st of states) {
    if (!st || st.autoDecision !== true) continue;
    const n = st.iterations;
    if (!Number.isInteger(n) || n < 1 || n > 10) bad4.push(`${st.exprId}：autoDecision=true 但 iterations=${JSON.stringify(n)} 不在 1..10`);
    const ci = st.currentIteration;
    if (ci !== undefined && ci !== null && (!Number.isInteger(ci) || (Number.isInteger(n) && n >= 1 && (ci < 1 || ci > n)))) bad4.push(`${st.exprId}：currentIteration=${JSON.stringify(ci)} 越界（iterations=${JSON.stringify(n)}）`);
    if (typeof st.rejectStreak === 'number' && st.rejectStreak > 2) bad4.push(`${st.exprId}：rejectStreak=${st.rejectStreak} > 2（≥3 本应已 paused）`);
  }
  add('J4-声明自洽', bad4.length ? 1 : 0, bad4.length ? bad4.join('；') : '自动迭代声明字段自洽（iterations/currentIteration/rejectStreak）');

  // ---- J5 版间门（有落盘对象后 → 从"未验证"升级为**真判据**）----
  // 作用域＝**实质在办**的自动迭代 expr（用 substantivelyClosed 而非 finalized 标记，否则历史记录会假报未验证）。
  // 判据：处于 Vn（n≥2）的在办 expr，必须能证明 V(n-1)→Vn 这一步**真的过了门**：
  //   · 有 iterationGates 记录但缺该转换 → **1 失败**（状态与门记录不自洽：计数涨了却无决策记录）
  //   · 完全没有 iterationGates 字段 → **4 未验证**（该字段 2026-09-20 才引入，早于此的 expr 无记录可查）
  //   · 有该转换记录 → PASS
  const gateSubjects = states.filter((st) => st && st.autoDecision === true && !substantivelyClosed(st) && Number.isInteger(st.currentIteration) && st.currentIteration >= 2);
  if (gateSubjects.length === 0) {
    add('J5-版间门', 0, '本周期无"进入第 2 版且未收口"的 expr → 版间门无可判定对象（无对象≠未验证）');
  } else {
    const inconsistent = [];
    const noField = [];
    for (const st of gateSubjects) {
      const n = st.currentIteration;
      const gates = Array.isArray(st.iterationGates) ? st.iterationGates : null;
      if (!gates) { noField.push(`${st.exprId}@V${n}`); continue; }
      const step = gates.find((g) => g && g.decision === 'advance' && g.from === n - 1 && g.to === n);
      if (!step || !step.at) inconsistent.push(`${st.exprId}@V${n}（iterationGates 里无 V${n - 1}→V${n} 的 advance 记录）`);
    }
    if (inconsistent.length) add('J5-版间门', 1, `门记录与迭代计数不自洽：${inconsistent.join('；')}`);
    else if (noField.length) add('J5-版间门', 4, `无法证明版间门真的跑过（这些 expr 无 iterationGates 字段，该字段 2026-09-20 才引入）：${noField.join('、')}`);
    else add('J5-版间门', 0, `版间门记录自洽：${gateSubjects.map((s) => `${s.exprId}@V${s.currentIteration}`).join('、')} 均有对应的 advance 决策记录`);
  }

  const anyFail = findings.some((f) => f.exit === 1);
  const anyInstr = findings.some((f) => f.exit === 3);
  const anyUnver = findings.some((f) => f.exit === 4);
  return { exit: anyFail ? 1 : anyInstr ? 3 : anyUnver ? 4 : 0, findings, info, interrupted: interrupted.map((s) => s.exprId) };
}

// ═══════════════════════════════════════════════════════════════════════════
// v4.11.0 步10：J7/J8（协议版本口径自洽）+ J9（审计层清单一致）+ J10（Step artifacts 存在性）
//
// 背景：V1 把协议版本元数据收敛到 lib/index.js 的 PROTOCOL_VERSIONS_META，随 /context 与
// /protocol/versions 下发，client.js 已改为数据驱动渲染（见 lib/client.js 注释 ccfeat-20260922-protoversion）。
// 但"收敛完了"和"收敛的结果自洽"是两件事——四处（元数据/两个端点/前端渲染）谁都可能单独漂移，
// 且没有机制持续盯着。J7/J8 补的正是这道持续性断言，而不是一次性人工核对。
// ═══════════════════════════════════════════════════════════════════════════

/** 从 lib/index.js 源码解析 PROTOCOL_VERSIONS_META 的 {version, contentKey} 列表。
 *  源码级解析（不 import lib/index.js）：version 字段既可能是字面量 'vX.Y'，也可能是具名常量
 *  （如 WEB_RELAY_PROTOCOL_VERSION_V16）——先建常量表，再解引用；两种写法都支持，防止未来
 *  重构成字面量或常量任一种都误判"解析失败"。解析不到 → null（工具错误，交给调用方判 3）。 */
export function extractMetaVersions(indexSrc) {
  const src = String(indexSrc || '');
  const constMap = new Map();
  for (const m of src.matchAll(/export const (WEB_RELAY_PROTOCOL_VERSION(?:_V\d+)?)\s*=\s*'([^']+)'/g)) {
    constMap.set(m[1], m[2]);
  }
  const blockMatch = src.match(/PROTOCOL_VERSIONS_META\s*=\s*\[([\s\S]*?)\n\]/);
  if (!blockMatch) return null;
  const entries = [];
  const entryRe = /\{\s*version:\s*([A-Za-z_][A-Za-z0-9_]*|'[^']+')[\s\S]*?contentKey:\s*'([^']+)'/g;
  let m;
  while ((m = entryRe.exec(blockMatch[1]))) {
    const raw = m[1];
    const version = raw.startsWith("'") ? raw.slice(1, -1) : (constMap.get(raw) || null);
    if (version) entries.push({ version, contentKey: m[2] });
  }
  return entries.length ? entries : null;
}

/** client.js 是否具备"数据驱动渲染"痕迹：对 protocolVersions 做 .map 渲染，且按 contentKey 查表取正文
 *  （而不是逐版本 if/三元链手写）。浏览器 bundle 无法直接执行，只能做源码级痕迹断言。 */
export function clientRendersFromMeta(clientSrc) {
  const src = String(clientSrc || '');
  // 口径修正（2026-09-22 主 agent，实测客户端实现后校准）：
  // 原判据要求 `protocolVersions` 与 `.map(` 在 300 字符窗口内相邻——但真实实现是
  //   const meta = (Array.isArray(protocolVersions) …) ? protocolVersions : PROTOCOL_VERSIONS_FALLBACK
  //   … meta.map((m) => h('option', …))
  // 即先把 protocolVersions 赋给局部变量再 map，窗口远大于 300 → 误 FAIL（断言过窄也是一种错误）。
  // 新口径：① 必须出现 protocolVersions（元数据来源）+ 至少一处 .map( 渲染；
  //          ② 且必须按 contentKey 查表取正文（而不是逐版本 if/三元链）。
  const readsMeta = /protocolVersions/.test(src);
  const mapsSomething = /\.map\(/.test(src);
  const usesContentKey = /contentKey/.test(src);
  return readsMeta && mapsSomething && usesContentKey;
}

/** J8 判据①：client.js 不得出现整串硬编码版本下拉列表（旧世界机器签名：连续字面量 'v1.5'…'v1.9'，
 *  或大量逐版本 `protocolVersion === 'vX.Y'` 分支）。判据口径与 probes/protocol-version-grounding-accept.mjs
 *  的 legacyOptionList/branchCount 一致（同一缺陷家族，不另开一套标准）。 */
export function clientHasHardcodedVersionList(clientSrc) {
  const src = String(clientSrc || '');
  const legacyOptionList = /'v1\.5'[\s\S]{0,400}'v1\.9'/.test(src);
  const branchCount = (src.match(/protocolVersion\s*===\s*'v\d\.\d'/g) || []).length;
  return legacyOptionList || branchCount > 2;
}

/** J8 判据②：client.js 不得有 localStorage 版本白名单（"未知值静默回落固定版本"的源头——本次修复前
 *  localStorage 读出的值只认 v1.6-v1.9，其余静默回落 v1.5，新增版本必然被吞）。 */
export function clientHasLocalStorageWhitelist(clientSrc) {
  const src = String(clientSrc || '');
  return /localStorage[\s\S]{0,300}===\s*'v1\.6'[\s\S]{0,150}'v1\.9'/.test(src) || /===\s*'v1\.6'[\s\S]{0,120}'v1\.9'/.test(src);
}

/** J7+J8：四处版本口径一致 + client.js 不硬编码。纯函数，输入均为已读取的字符串/已解析的 JSON，
 *  不在函数内部做任何 IO（IO 由 CLI 段落负责，selftest 可直接注入夹具字符串/对象）。
 *  宿主不可达（ctx===null）时 J7 落"未验证"（4），不得伪装成 PASS——与本文件既有语义一致。 */
export function judgeVersionGrounding({ indexSrc, clientSrc, ctx, versionsResp, hostReachable }) {
  const findings = [];
  const add = (id, exit, detail) => findings.push({ id, verdict: exit === 0 ? 'PASS' : exit === 1 ? 'FAIL' : exit === 3 ? 'INSTRUMENT-ERROR' : 'UNVERIFIED', exit, detail });

  const metaEntries = extractMetaVersions(indexSrc);
  const dataDriven = clientRendersFromMeta(clientSrc);
  if (!metaEntries) {
    add('J7-版本口径一致', 3, '无法从 lib/index.js 源码解析出 PROTOCOL_VERSIONS_META（工具错误，不是判定失败——多半是源码文件读不到或格式变了）');
  } else if (!hostReachable) {
    add('J7-版本口径一致', 4, `宿主不可达：无法比对 /context.protocolVersions 与 /protocol/versions（source 侧已解析出 META ${metaEntries.length} 项，client.js 数据驱动渲染痕迹=${dataDriven}）→ 按既有语义标记未验证，不得伪装成 PASS`);
  } else {
    const metaVersions = metaEntries.map((e) => e.version);
    const ctxVersions = Array.isArray(ctx && ctx.protocolVersions) ? ctx.protocolVersions.map((v) => v && v.version) : null;
    const pvVersions = Array.isArray(versionsResp && versionsResp.versions) ? versionsResp.versions.map((v) => v && v.version) : null;
    const setEq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v) => b.includes(v));
    const problems = [];
    if (!setEq(metaVersions, ctxVersions)) problems.push(`META(${metaVersions.join(',')}) ≠ /context.protocolVersions(${(ctxVersions || []).join(',') || '缺失'})`);
    if (!setEq(metaVersions, pvVersions)) problems.push(`META(${metaVersions.join(',')}) ≠ /protocol/versions(${(pvVersions || []).join(',') || '缺失'})`);
    if (!dataDriven) problems.push('client.js 未见"数据驱动渲染"痕迹（protocolVersions.map + contentKey 查表），无法保证其可渲染集合与后端一致');
    const missingBody = ctx ? metaEntries.filter((e) => !(ctx[e.contentKey] && String(ctx[e.contentKey]).trim())) : metaEntries;
    if (missingBody.length) problems.push(`以下 contentKey 在 /context 无非空正文：${missingBody.map((e) => `${e.version}→${e.contentKey}`).join('、')}`);
    add('J7-版本口径一致', problems.length ? 1 : 0, problems.length ? problems.join('；') : `四处版本口径一致（共 ${metaVersions.length} 版：${metaVersions.join(',')}），且每个 contentKey 在 /context 均有非空正文`);
  }

  const hardcoded = clientHasHardcodedVersionList(clientSrc);
  const whitelist = clientHasLocalStorageWhitelist(clientSrc);
  add('J8-无硬编码版本清单', (hardcoded || whitelist) ? 1 : 0,
    (hardcoded || whitelist)
      ? `client.js 出现${hardcoded ? '整串硬编码版本列表' : ''}${hardcoded && whitelist ? '、' : ''}${whitelist ? 'localStorage 版本白名单' : ''}（旧世界机器签名，静默回落固定版本）`
      : 'client.js 未见整串硬编码版本列表，也未见 localStorage 版本白名单');

  const anyFail = findings.some((f) => f.exit === 1);
  const anyInstr = findings.some((f) => f.exit === 3);
  const anyUnver = findings.some((f) => f.exit === 4);
  return { exit: anyFail ? 1 : anyInstr ? 3 : anyUnver ? 4 : 0, findings };
}

// ═══════════════════════════════════════════════════════════════════════════
// v4.11.0 步11：J9 —— 最近一次 audit-all 结果的层 key 集合必须 == AUDIT_LAYERS_MANIFEST 的 key 集合
// 缺层（漏跑）与多层（结果里出现但清单未登记）都必须 FAIL——两侧都是"清单与事实不同步"。
// ═══════════════════════════════════════════════════════════════════════════
export function judgeAuditLayerManifest({ manifestKeys, lastRunKeys, readable }) {
  const add = (id, exit, detail) => ({ id, verdict: exit === 0 ? 'PASS' : exit === 1 ? 'FAIL' : exit === 3 ? 'INSTRUMENT-ERROR' : 'UNVERIFIED', exit, detail });
  if (!readable || !Array.isArray(manifestKeys)) {
    return { exit: 4, findings: [add('J9-审计层清单一致', 4, '读不到 AUDIT_LAYERS_MANIFEST（audit-all.mjs --print-manifest 不可用）→ 未验证，不得伪装成 PASS')] };
  }
  if (!Array.isArray(lastRunKeys)) {
    return { exit: 4, findings: [add('J9-审计层清单一致', 4, '读不到最近一次 audit-all --json 结果（audit-latest.json 缺失或不可解析）→ 未验证，不得伪装成 PASS')] };
  }
  const mset = new Set(manifestKeys);
  const rset = new Set(lastRunKeys);
  const missing = manifestKeys.filter((k) => !rset.has(k));
  const extra = lastRunKeys.filter((k) => !mset.has(k));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`缺层（清单声明但最近一次结果里没跑）：${missing.join('、')}`);
    if (extra.length) parts.push(`多层（结果里出现但清单未登记）：${extra.join('、')}`);
    return { exit: 1, findings: [add('J9-审计层清单一致', 1, parts.join('；'))] };
  }
  return { exit: 0, findings: [add('J9-审计层清单一致', 0, `层 key 集合一致（共 ${manifestKeys.length} 层）`)] };
}

// ═══════════════════════════════════════════════════════════════════════════
// v4.11.0 步12：resolveArtifactPath + J10 —— Step List artifacts 存在性判据
// 与子任务①（shadow-gate resolveRepoPath）同一族缺陷：证据路径锚点错误——把 repoRoot 解析成
// 宿主工作区而不是插件仓库根，会让本该存在的产物"看起来缺失"。verify-gates.mjs 复用同一份实现
// （从本文件 import），不得各写一份自己的路径解析（两处实现迟早漂移）。
// ═══════════════════════════════════════════════════════════════════════════
/** 多根解析（口径修正 2026-09-22 主 agent，实测暴露）：
 *  产物分布在两个仓库——插件仓库（lib/…、test/…、probes/…）与主 agent 工作区（verify-*.mjs、audit-all.mjs、cc-specs/…）。
 *  Step List 的 artifacts 既有仓库相对也有工作区相对，用单根必误判其一。
 *  故按**候选根顺序**逐个尝试（仓库根优先——原始缺陷"仓库相对路径被当成工作区相对"的负控仍然成立：
 *  单传错误根时同一相对路径仍解析不到）。任一候选命中即返回命中的绝对路径。 */
export function resolveArtifactPathMulti(roots, artifactPath) {
  const list = (Array.isArray(roots) ? roots : [roots]).filter((r) => typeof r === 'string' && r);
  if (typeof artifactPath !== 'string' || !artifactPath.trim()) return null;
  const p = artifactPath.trim();
  if (path.isAbsolute(p)) { try { return fs.existsSync(p) ? p : null; } catch { return null; } }
  for (const r of list) {
    const abs = path.join(r, p);
    try { if (fs.existsSync(abs)) return abs; } catch { /* 试下一个 */ }
  }
  return null;
}

export function resolveArtifactPath(repoRoot, artifactPath) {
  if (typeof artifactPath !== 'string' || !artifactPath.trim()) return null;
  const p = artifactPath.trim();
  const abs = path.isAbsolute(p) ? p : (repoRoot ? path.join(repoRoot, p) : null);
  if (!abs) return null;
  try { return fs.existsSync(abs) ? abs : null; } catch { return null; }
}

/** 路径型 artifacts 判定（口径修正 2026-09-22 主 agent，实测暴露）：
 *  历史 expr 的 artifacts 混杂三类内容——① 仓库/工作区相对路径；② 句子型描述（如
 *  "验证：真实会话 … 全量解析 604 assistant/message"）；③ 带说明后缀的路径（"lib/index.js（后端费用解析 API）"）。
 *  把 ②③ 当路径判存在性必然全 FAIL（实测 100+ 条历史 expr 被一次性判失败）——那是**把历史包袱当成本周期违约**，
 *  与"证据必须属于该对象"（runbook §8.2）同一条纪律。故 J10 只判**在办/未终态** expr 的**可判定路径**：
 *  · 只取 status 非终态（非 done/finalized）的 expr；
 *  · 只取形态上像路径的项（含 / 或 \ 或带 .后缀，且不含空白——句子型描述一律跳过）；
 *  · 带"（说明）"后缀的先剥掉括号再判。
 *  被跳过的项作为 info 计数输出，不静默丢弃。 */
export function artifactPathLike(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p) return null;
  p = p.replace(/（[^）]*）\s*$/, '').replace(/\([^)]*\)\s*$/, '').trim();   // 剥说明后缀
  if (/^\[(NEW|MOD|DEL)\]\s*/i.test(p)) p = p.replace(/^\[(NEW|MOD|DEL)\]\s*/i, '').trim();
  if (!p || /\s/.test(p)) return null;                                      // 含空白 → 句子型，跳过
  if (!/[\\/]/.test(p) && !/\.[A-Za-z0-9]{1,6}$/.test(p)) return null;      // 既无分隔符也无扩展名 → 跳过
  if (/^[A-Za-z]:[\\/]/.test(p)) return p;                                  // 绝对路径
  if (/^[a-z]+:\/\//i.test(p)) return null;                                 // URL 不算产物路径
  return p;
}

export function judgeArtifactsExistence({ states, repoRoot, workspaceRoot }) {
  const missing = [];
  let checked = 0;
  let skippedLegacy = 0;
  let skippedTerminal = 0;
  const roots = [repoRoot, workspaceRoot].filter((r) => typeof r === 'string' && r);
  for (const st of states || []) {
    if (!st || !Array.isArray(st.steps)) continue;
    const terminal = st.finalized === true || st.status === 'done' || st.status === 'paused' || st.status === 'stopped';
    for (const step of st.steps) {
      const arts = Array.isArray(step && step.artifacts) ? step.artifacts : [];
      for (const a of arts) {
        const raw = typeof a === 'string' ? a : (a && a.path);
        const p = artifactPathLike(raw);
        if (!p) { skippedLegacy++; continue; }
        if (terminal) { skippedTerminal++; continue; }   // 历史终态 expr 的路径不判（早已交付/归档）
        checked++;
        if (!resolveArtifactPathMulti(roots, p)) missing.push(`${st.exprId || '?'}/${step.id || '?'}: ${p}`);
      }
    }
  }
  const add = (id, exit, detail) => ({ id, verdict: exit === 0 ? 'PASS' : 'FAIL', exit, detail });
  const note = `（在办路径型 ${checked} 个；候选根 ${roots.join(' + ')}；跳过非路径描述 ${skippedLegacy} 个、终态历史 ${skippedTerminal} 个）`;
  if (missing.length) return { exit: 1, findings: [add('J10-artifacts存在性', 1, `在办步骤的以下 artifacts 用 resolveArtifactPathMulti(${roots.join(' + ')}, ...) 均解析不到（路径锚点错误或文件确实缺失）：${missing.join('；')}${note}`)] };
  return { exit: 0, findings: [add('J10-artifacts存在性', 0, checked ? `在办步骤 ${checked} 个路径型 artifacts 均可在候选根下解析到${note}` : `本周期无"在办 + 路径型"artifacts → 无可判定对象（不算失败）${note}`)] };
}

// ---------------- 判定自检 ----------------
if (isDirectRun && process.argv.includes('--selftest')) {
  const now = Date.parse('2026-09-20T12:00:00.000Z');
  const mk = (o) => ({ exprId: 'expr-t', status: 'executing', bootId: 'old-boot', activeSteps: ['s1'], steps: [{ id: 's1', status: 'executing' }], updatedAt: '2026-09-20T11:00:00.000Z', autoDecision: false, ...o });
  // 注意：自检直接注入 states 与已判定的"权威范围"结果，故用真实模块的 isExprInterrupted 语义构造夹具。
  const base = { liveBootId: 'cur-boot', signals: [], nowMs: now, stallMs: 6 * 3600 * 1000, states: [] };
  const sigFor = (exprId) => [{ id: `autoir-circuit-${exprId}#g1`, chainId: 'autoir-circuit', reason: 'too-many-attempts', taskId: `expr:${exprId}`, stableKey: `autoir-circuit-${exprId}`, at: '2026-09-20T11:00:00.000Z', acknowledgedAt: null, detail: '' }];
  const cases = [
    ['[POS] 无在办对象 → 全判据放行（不制造假告警）', { ...base, states: [mk({ status: 'done', activeSteps: [], steps: [{ id: 's1', status: 'approved' }] })] }, 0],
    ['[NEG] 跨 boot 有 busy 步骤且超 6h 无进展 → J1 失败（静默停摆）', { ...base, states: [mk({ updatedAt: '2026-09-20T00:00:00.000Z' })] }, 1],
    ['[POS] 跨 boot 有 busy 步骤但刚更新过 → 不算停滞', { ...base, states: [mk({ updatedAt: '2026-09-20T11:59:00.000Z' })] }, 0],
    ['[NEG] 已熔断(paused)但未登记 needs-human → J2 失败', { ...base, states: [mk({ status: 'paused', stopReason: '宿主重启续跑熔断：…', activeSteps: [] })] }, 1],
    ['[POS] 已熔断且以**规范 ref** 登记 → 放行（J2 精确匹配）', { ...base, signals: sigFor('expr-t'), states: [mk({ status: 'paused', stopReason: '宿主重启续跑熔断：…', activeSteps: [] })] }, 0],
    ['[NEG] 登记的是**别的** expr（ref 不同）→ 仍判未登记（防误认领）', { ...base, signals: sigFor('expr-other'), states: [mk({ status: 'paused', stopReason: '宿主重启续跑熔断：…', activeSteps: [] })] }, 1],
    ['[POS] legacy 裸串 taskId 逐字相等 → 仍认领（向后兼容历史信号）', { ...base, signals: [{ id: 'x#g1', taskId: 'expr-t' }], states: [mk({ status: 'paused', stopReason: '宿主重启续跑熔断：…', activeSteps: [] })] }, 0],
    ['[NEG] status=stopped 却无 stopReason → J3 失败', { ...base, states: [mk({ status: 'stopped', activeSteps: [], steps: [] })] }, 1],
    ['[NEG] finalized=true 却无 finalizedAt → J3 失败', { ...base, states: [mk({ status: 'done', finalized: true, activeSteps: [], steps: [] })] }, 1],
    ['[NEG] autoDecision=true 但 iterations 越界 → J4 失败', { ...base, states: [mk({ status: 'done', autoDecision: true, iterations: 99, activeSteps: [], steps: [] })] }, 1],
    ['[NEG] rejectStreak>2（≥3 本应 paused）→ J4 失败', { ...base, states: [mk({ status: 'done', autoDecision: true, iterations: 3, currentIteration: 2, rejectStreak: 5, activeSteps: [], steps: [] })] }, 1],
    ['[NEG] V2 在办但**无 iterationGates 字段**（早于该机制）→ J5 未验证(4)',
      { ...base, states: [mk({ status: 'executing', autoDecision: true, iterations: 3, currentIteration: 2 })] }, 4],
    ['[NEG] 有 iterationGates 但缺 V1→V2 的 advance 记录 → J5 失败（计数涨了却无决策记录）',
      { ...base, states: [mk({ status: 'executing', autoDecision: true, iterations: 3, currentIteration: 2, iterationGates: [{ at: '2026-09-20T10:00:00.000Z', decision: 'finalized', from: 1, to: 1 }] })] }, 1],
    ['[POS] 有 V1→V2 advance 记录 → J5 放行（门决策可验证）',
      { ...base, states: [mk({ status: 'executing', autoDecision: true, iterations: 3, currentIteration: 2, iterationGates: [{ at: '2026-09-20T10:00:00.000Z', decision: 'advance', from: 1, to: 2, reasons: ['x'] }] })] }, 0],
    // 2026-09-20 现场抓到的假阳性回归：历史 expr 缺 finalized 标记但**实质已收口**（done + 步骤全 approved）→ 不得算在办对象
    ['[POS] V2 但实质已收口（status=done + 步骤全 approved，仅缺 finalized 标记）→ 不算在办对象，J5 不得假报未验证',
      { ...base, states: [mk({ status: 'done', autoDecision: true, iterations: 3, currentIteration: 2, activeSteps: [], steps: [{ id: 's1', status: 'approved' }], finalized: undefined })] }, 0],
    ['[NEG] 读不到活 bootId → 工具错误(3)', { ...base, liveBootId: null }, 3],
    // ---- J6：提前收口必须有记录（按主 agent 决策 (b)；机制引入后仍无记录 = 决策没落盘）----
    ['[POS] 提前收口但有 early-close 记录 → J6 放行',
      { ...base, states: [mk({ status: 'done', autoDecision: true, iterations: 3, currentIteration: 1, activeSteps: [], steps: [{ id: 's1', status: 'approved' }], updatedAt: '2026-09-20T20:00:00.000Z', iterationGates: [{ at: '2026-09-20T20:00:00.000Z', decision: 'early-close', from: 1, to: 1 }] })] }, 0],
    ['[NEG] 机制引入后提前收口却无任何门记录 → J6 判失败（决策未落盘）',
      { ...base, states: [mk({ status: 'done', autoDecision: true, iterations: 3, currentIteration: 1, activeSteps: [], steps: [{ id: 's1', status: 'approved' }], updatedAt: '2026-09-20T20:00:00.000Z' })] }, 1],
    ['[POS] 早于机制引入即收口的历史记录 → 归信息项，不判违约',
      { ...base, states: [mk({ status: 'done', autoDecision: true, iterations: 3, currentIteration: 1, activeSteps: [], steps: [{ id: 's1', status: 'approved' }], updatedAt: '2026-09-03T02:16:31.310Z' })] }, 0],
  ];
  let bad = 0;
  let total = cases.length;
  for (const [name, inp, expect] of cases) {
    const r = judgeIterationState(inp);
    const ok = r.exit === expect;
    if (!ok) bad++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : `（期望 exit=${expect}，实际 ${r.exit}：${r.findings.map((f) => f.detail).join('；')}）`}`);
  }

  // ---- v4.11.0 步10：J7/J8 协议版本口径自洽（自检两侧，防断言永真）----
  const goodIndexSrc = `
export const WEB_RELAY_PROTOCOL_VERSION = 'v1.5'
export const WEB_RELAY_PROTOCOL_VERSION_V16 = 'v1.6'
export const PROTOCOL_VERSIONS_META = [
  { version: WEB_RELAY_PROTOCOL_VERSION, concurrent: false, isConcurrent: false, contentKey: 'protocolV15', label: 'v1.5' },
  { version: WEB_RELAY_PROTOCOL_VERSION_V16, concurrent: true, isConcurrent: true, contentKey: 'protocolV16', label: 'v1.6' }
]
`;
  const goodClientSrc = `
const rendered = protocolVersions.map((v) => ({ key: v.contentKey, label: v.label }))
const entry = data[activeMeta.contentKey]
`;
  const goodCtx = { protocolVersions: [{ version: 'v1.5', contentKey: 'protocolV15' }, { version: 'v1.6', contentKey: 'protocolV16' }], protocolV15: '正文 A', protocolV16: '正文 B' };
  const goodVersionsResp = { versions: [{ version: 'v1.5' }, { version: 'v1.6' }] };
  const j78Cases = [
    ['[POS] 四处口径一致 + 数据驱动渲染 + contentKey 均有正文 → J7/J8 全放行', { indexSrc: goodIndexSrc, clientSrc: goodClientSrc, ctx: goodCtx, versionsResp: goodVersionsResp, hostReachable: true }, 0],
    ['[NEG] 宿主不可达 → J7 未验证(4)，不得伪装成 PASS', { indexSrc: goodIndexSrc, clientSrc: goodClientSrc, ctx: null, versionsResp: null, hostReachable: false }, 4],
    ['[NEG] 源码解析不到 META（工具错误）', { indexSrc: '// no meta here', clientSrc: goodClientSrc, ctx: goodCtx, versionsResp: goodVersionsResp, hostReachable: true }, 3],
    ['[NEG] /context.protocolVersions 缺一版（口径不一致）→ J7 失败',
      { indexSrc: goodIndexSrc, clientSrc: goodClientSrc, ctx: { protocolVersions: [{ version: 'v1.5', contentKey: 'protocolV15' }], protocolV15: 'x' }, versionsResp: goodVersionsResp, hostReachable: true }, 1],
    ['[NEG] contentKey 在 /context 里正文为空 → J7 失败',
      { indexSrc: goodIndexSrc, clientSrc: goodClientSrc, ctx: { protocolVersions: goodCtx.protocolVersions, protocolV15: '', protocolV16: '正文 B' }, versionsResp: goodVersionsResp, hostReachable: true }, 1],
    ['[NEG] 注入整串硬编码版本列表（旧世界机器签名）→ J8 失败',
      { indexSrc: goodIndexSrc, clientSrc: goodClientSrc + `\nconst LEGACY = ['v1.5','v1.6','v1.7','v1.8','v1.9']`, ctx: goodCtx, versionsResp: goodVersionsResp, hostReachable: true }, 1],
    ['[NEG] 注入 localStorage 版本白名单 → J8 失败',
      { indexSrc: goodIndexSrc, clientSrc: goodClientSrc + `\nif (localStorage.getItem('x') === 'v1.6' || stored === 'v1.9') {}`, ctx: goodCtx, versionsResp: goodVersionsResp, hostReachable: true }, 1],
    ['[NEG] client.js 无数据驱动渲染痕迹 → J7 失败（无法保证可渲染集合一致）',
      { indexSrc: goodIndexSrc, clientSrc: '// no map, no contentKey', ctx: goodCtx, versionsResp: goodVersionsResp, hostReachable: true }, 1],
  ];
  for (const [name, inp, expect] of j78Cases) {
    total++;
    const r = judgeVersionGrounding(inp);
    const ok = r.exit === expect;
    if (!ok) bad++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : `（期望 exit=${expect}，实际 ${r.exit}：${r.findings.map((f) => f.detail).join('；')}）`}`);
  }

  // ---- v4.11.0 步11：J9 审计层清单一致（自检两侧）----
  const j9Cases = [
    ['[POS] 层 key 集合完全一致 → 放行', { manifestKeys: ['a', 'b', 'c'], lastRunKeys: ['a', 'b', 'c'], readable: true }, 0],
    ['[NEG] 缺层（清单里有但最近一次结果没跑）→ 失败', { manifestKeys: ['a', 'b', 'c'], lastRunKeys: ['a', 'b'], readable: true }, 1],
    ['[NEG] 多层（结果里有但清单未登记）→ 失败', { manifestKeys: ['a', 'b'], lastRunKeys: ['a', 'b', 'c'], readable: true }, 1],
    ['[NEG] 清单不可读（audit-all.mjs --print-manifest 不可用）→ 未验证(4)', { manifestKeys: null, lastRunKeys: ['a', 'b'], readable: false }, 4],
    ['[NEG] 最近一次结果不可读（audit-latest.json 缺失）→ 未验证(4)', { manifestKeys: ['a', 'b'], lastRunKeys: null, readable: true }, 4],
  ];
  for (const [name, inp, expect] of j9Cases) {
    total++;
    const r = judgeAuditLayerManifest(inp);
    const ok = r.exit === expect;
    if (!ok) bad++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : `（期望 exit=${expect}，实际 ${r.exit}）`}`);
  }

  // ---- v4.11.0 步12：resolveArtifactPath + J10 artifacts 存在性（含"路径错位"负控）----
  {
    const os = await import('node:os');
    const realRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-repo-'));
    const wrongBase = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-wrongbase-')); // 冒充"宿主工作区"
    fs.mkdirSync(path.join(realRepo, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(realRepo, 'lib', 'foo.js'), '// x', 'utf8');
    const absFile = path.join(realRepo, 'lib', 'foo.js');
    const rpCases = [
      ['[POS] 相对路径按 repoRoot 正确解析到存在文件', resolveArtifactPath(realRepo, 'lib/foo.js') === absFile],
      ['[POS] 绝对路径原样返回（文件存在）', resolveArtifactPath('/whatever/不会被用到', absFile) === absFile],
      ['[NEG] 解析不到（相对路径在 repoRoot 下不存在）→ null', resolveArtifactPath(realRepo, 'lib/not-exist.js') === null],
      // ★ 核心负控：与子任务①同型——把 repoRoot 错传成"宿主工作区"（这里用 wrongBase 冒充），
      //   同一个相对 artifact 路径在错误的 base 下必须解析不到（null），证明"路径锚点错位"确实会被抓到。
      ['[NEG] 路径错位（repoRoot 误传成宿主工作区）→ 同一相对路径解析不到', resolveArtifactPath(wrongBase, 'lib/foo.js') === null],
    ];
    for (const [name, cond] of rpCases) {
      total++;
      if (!cond) bad++;
      console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}`);
    }

    const statesWithArtifact = [{ exprId: 'expr-art', steps: [{ id: 's1', artifacts: ['lib/foo.js'] }] }];
    const j10Cases = [
      ['[POS] repoRoot 正确 → artifacts 均可解析，放行', judgeArtifactsExistence({ states: statesWithArtifact, repoRoot: realRepo }).exit, 0],
      ['[NEG] repoRoot 错位（同一 artifact 路径按错误 base 解析）→ 失败', judgeArtifactsExistence({ states: statesWithArtifact, repoRoot: wrongBase }).exit, 1],
      ['[POS] 无步骤声明 artifacts → 无可判定对象，放行（不是假通过）', judgeArtifactsExistence({ states: [{ exprId: 'e', steps: [{ id: 's1' }] }], repoRoot: realRepo }).exit, 0],
    ];
    for (const [name, got, expect] of j10Cases) {
      total++;
      const ok = got === expect;
      if (!ok) bad++;
      console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : `（期望 ${expect}，实际 ${got}）`}`);
    }
    fs.rmSync(realRepo, { recursive: true, force: true });
    fs.rmSync(wrongBase, { recursive: true, force: true });
  }

  console.log(`\nRESULT: ${total - bad}/${total} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

// ---------------- 解析器自检（lesson L-089：判定自检 ≠ 输入解析自检）----------------
if (process.argv.includes('--selftest-parsers')) {
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iter-parsers-'));
  const cases = [];
  const ck = (name, cond, detail = '') => { cases.push({ name, cond }); console.log(`  [${cond ? 'PASS' : 'NEG-PASS'}] ${name}${detail ? ' — ' + detail : ''}`); };

  fs.writeFileSync(path.join(dir, 'expr-a.steps.json'), JSON.stringify({ exprId: 'expr-a', status: 'executing', steps: [], activeSteps: [] }), 'utf8');
  fs.writeFileSync(path.join(dir, 'expr-b.steps.json'), JSON.stringify({ exprId: 'expr-b', status: 'done', steps: [], activeSteps: [] }), 'utf8');
  fs.writeFileSync(path.join(dir, 'not-an-expr.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, 'expr-bad.steps.json'), '{坏 JSON', 'utf8');
  const got = readStepStates(dir);
  ck('[POS] 只收 expr-*.steps.json，且坏文件被跳过', got.length === 2 && got.every((s) => /^expr-/.test(s.exprId)), `读到 ${got.length} 条`);

  // 权威实现必须真的可用（否则 J1 永远无从判定）——这条是"导入成功"的自证
  ck('[POS] 权威实现 lib/resume-scan.js 已只读导入且暴露 isExprInterrupted', RESUME_MODULE_LOADED === true, `RESUME_MODULE_LOADED=${RESUME_MODULE_LOADED}${SR_ERR ? ' err=' + SR_ERR : ''}`);

  // 负控：paused/stopped 即便残留 activeSteps 也不得判"中断"（插件显式排除，⑩ 必须继承该语义）
  const pausedState = { exprId: 'expr-p', status: 'paused', bootId: 'old', activeSteps: ['s1'], steps: [{ id: 's1', status: 'executing' }] };
  ck('[NEG] paused + 残留 activeSteps 不得判为跨 boot 中断（继承插件显式排除语义）', authoritative(pausedState, 'cur') === false, `authoritative=${authoritative(pausedState, 'cur')}`);
  const busyState = { exprId: 'expr-q', status: 'executing', bootId: 'old', activeSteps: ['s1'], steps: [{ id: 's1', status: 'executing' }] };
  ck('[POS] executing + 跨 boot + busy 应判为中断（正控，证明上面那条不是永假）', authoritative(busyState, 'cur') === true, `authoritative=${authoritative(busyState, 'cur')}`);

  const sig = path.join(dir, 'sig.json');
  fs.writeFileSync(sig, JSON.stringify({ id: 'autoir-circuit-expr-a#g1', chainId: 'autoir-circuit', reason: 'too-many-attempts', taskId: 'expr:expr-a', stableKey: 'autoir-circuit-expr-a' }), 'utf8');
  const sigs = readSignals(sig);
  ck('[POS] 能读出信号整体对象（含规范 taskId，供 J2 精确匹配）', sigs.length === 1 && sigs[0].taskId === 'expr:expr-a', JSON.stringify(sigs.map((s) => s.taskId)));
  ck('[POS] 规范 ref 精确匹配：expr:expr-a ↔ expr:expr-a', signalCoversExpr(sigs[0], 'expr-a') === true);
  ck('[NEG] **不得**用包含/模糊匹配认领别的 expr（旧实现 grep 散文的病根）', signalCoversExpr(sigs[0], 'expr-a-b') === false && signalCoversExpr(sigs[0], 'expr') === false);

  // 统一身份原语（lib/task-ref.mjs）契约
  ck('[POS] 权威身份模块已只读导入', TASKREF_MODULE_LOADED === true, TASKREF_MODULE_LOADED ? '' : String(TR_ERR));
  if (TASKREF_MODULE_LOADED) {
    const r1 = TR.parseRef('expr:abc');
    const r2 = TR.parseRef('expr-2026-09-03_01-27-21');
    const r3 = TR.parseRef('signal:audit#g3');
    ck('[POS] 规范 ref 可解析（expr:/signal:#gN）', r1.ok && r1.kind === 'expr' && r3.ok && r3.generation === 3, `${r1.canonical} / ${r3.canonical}`);
    ck('[NEG] 裸串归为 legacy（可匹配但非规范，不得用于新写入）', r2.ok === false && r2.legacy === true, r2.why);
    ck('[POS] describeRef 给出 owner 与状态落点（跨载体追责不必各写路径）', TR.describeRef('expr:abc').owner === 'main-agent' && /experiments/.test(TR.describeRef('expr:abc').state), TR.describeRef('expr:abc').state);
    ck('[NEG] 跨 kind 不算同一对象（cc:x ≠ expr:x）', TR.sameRef('cc:x', 'expr:x') === false && TR.sameRef('expr:x', 'expr:x') === true);
  }

  // 跨实现契约：插件侧 PENDING_HUMAN_REASONS 必须与主 agent 侧 ALLOWED_REASONS 一致（防白名单漂移）
  try {
    const ph = await import(pathToFileURL(path.join(REPO, 'lib', 'pending-human.mjs')).href);
    const ws = await import(pathToFileURL(path.join(process.cwd(), 'chain-human-signal.mjs')).href);
    const a = [...ph.PENDING_HUMAN_REASONS].sort().join(',');
    const b = [...ws.ALLOWED_REASONS].sort().join(',');
    ck('[POS] 插件与主 agent 的 reason 白名单一致（跨实现契约）', a === b, `plugin=${a} ｜ workspace=${b}`);
  } catch (err) {
    ck('[NEG] reason 白名单跨实现比对未能执行 → 未验证（不得当作通过）', false, String((err && err.message) || err));
  }

  const bad = cases.filter((c) => !c.cond).length;
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

// ---------------- CLI ----------------
// v4.11.0 步12: 加"仅被直接执行时才跑"守卫（与 lib/autoiter-decl.js 同一idiom）。
// 背景：verify-gates.mjs 现在要 `import { resolveArtifactPath, readStepStates, REPO, EXP_DIR }`
// 只读引用本文件的纯函数/常量——若没有这道守卫，import 会把下面这段真跑一遍（拉 HTTP、
// spawn audit-all.mjs 子进程、最后还 process.exit()，把导入方的进程也一并带退出），
// 而 --selftest/--selftest-parsers 分支已经各自 process.exit()，正常直跑不受影响。
// 修复（2026-09-22 主 agent）：此处原先又声明了一次 `const isDirectRun`，与第 55 行的同名声明冲突
// （SyntaxError: Identifier 'isDirectRun' has already been declared）——该文件因 cc 任务超时被中断在
// 半成品状态。顶层已有该常量，这里不再重复声明。
if (isDirectRun) {
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const stallMs = Number(argOf('--stall-ms', String(STALL_MS_DEFAULT)));

const live = await (async () => {
  try { const r = await fetch(HEALTH_URL); const j = await r.json(); return j && j.bootId ? String(j.bootId) : null; } catch { return null; }
})();

const states = readStepStates();
const r = judgeIterationState({ states, liveBootId: live, signals: readSignals(), nowMs: Date.now(), stallMs });

// v4.11.0 步10：J7/J8——读源码 + 拉 /context 与 /protocol/versions（宿主不可达 → hostReachable=false，J7 按既有语义未验证）
let indexSrc = '', clientSrc = '';
try { indexSrc = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8'); } catch { /* 工具错误由 judgeVersionGrounding 内部判定 */ }
try { clientSrc = fs.readFileSync(path.join(REPO, 'lib', 'client.js'), 'utf8'); } catch { /* 同上 */ }
let ctx = null, versionsResp = null;
try { const cr = await fetch(CONTEXT_URL, { signal: AbortSignal.timeout(8000) }); ctx = await cr.json(); } catch { ctx = null; }
try { const vr = await fetch(VERSIONS_URL, { signal: AbortSignal.timeout(8000) }); versionsResp = await vr.json(); } catch { versionsResp = null; }
const rv = judgeVersionGrounding({ indexSrc, clientSrc, ctx, versionsResp, hostReachable: !!ctx });

// v4.11.0 步11：J9——最近一次 audit-all 结果的层 key 集合 == AUDIT_LAYERS_MANIFEST 的 key 集合
let manifestKeys = null;
try {
  const mp = spawnSync(process.execPath, [AUDIT_ALL_SCRIPT, '--print-manifest'], { encoding: 'utf8', timeout: 15000 });
  if (mp.status === 0 && mp.stdout) manifestKeys = (JSON.parse(mp.stdout).layers || []).map((l) => l.key);
} catch { manifestKeys = null; }
let lastRunKeys = null;
try { lastRunKeys = (JSON.parse(fs.readFileSync(AUDIT_LATEST_JSON, 'utf8')).runs || []).map((x) => x.key); } catch { lastRunKeys = null; }
const r9 = judgeAuditLayerManifest({ manifestKeys, lastRunKeys, readable: Array.isArray(manifestKeys) });

// v4.11.0 步12：J10——Step List artifacts 存在性（repoRoot = 插件仓库根 REPO，不是宿主工作区）
const r10 = judgeArtifactsExistence({ states, repoRoot: REPO, workspaceRoot: WORKSPACE });

const allFindings = [...r.findings, ...rv.findings, ...r9.findings, ...r10.findings];
const overallExit = [r.exit, rv.exit, r9.exit, r10.exit].includes(1) ? 1
  : [r.exit, rv.exit, r9.exit, r10.exit].includes(3) ? 3
  : [r.exit, rv.exit, r9.exit, r10.exit].includes(4) ? 4
  : 0;

console.log('=== ⑩ 迭代状态机审计（三方协议 step list）===');
console.log(`  活 bootId = ${live || '(读不到)'} ｜ steps.json ${states.length} 个 ｜ 权威实现已导入 = ${RESUME_MODULE_LOADED} ｜ 身份模块 = ${TASKREF_MODULE_LOADED}`);
console.log(`  跨 boot 中断中的 expr = ${(r.interrupted || []).length ? r.interrupted.join('、') : '(无)'}`);
for (const f of allFindings) console.log(`  [${f.verdict}] ${f.id} — ${f.detail}`);
if (r.info.length) console.log(`  ℹ 信息项（不判失败）：${r.info.length} 条${r.info.length <= 3 ? ' — ' + r.info.join('；') : ''}`);
const label = overallExit === 0 ? 'PASS（状态机自洽、版本口径自洽、审计层清单一致、artifacts 可解析，且无静默停摆）' : overallExit === 1 ? 'FAIL（存在判定不通过的判据）' : overallExit === 3 ? 'INSTRUMENT-ERROR（工具错误，不是判定失败）' : 'UNVERIFIED（证据不足，不得读成通过）';
console.log(`\n  RESULT: ${label}`);
if (argv.includes('--json')) {
  const out = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' ')), 'iteration-state.json');
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), exit: overallExit, liveBootId: live, findings: allFindings, info: r.info }, null, 2), 'utf8');
}
process.exit(overallExit);
}
