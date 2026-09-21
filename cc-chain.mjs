// 可续跑 cc 链条：派发 → 等结算 → 独立验收 → 提交 → 续派；额度耗尽则暂停，恢复后从断点继续
// 设计约束（重要）：
//   1) 绝不代替协议审核——链条不调 /steps/update、不写 approve；结束时产出「待主 agent 审核」清单；
//   2) 每个 item 提交一次（保持工作树干净，否则下一个任务的 git status 自检会因上一任务残留而失败）；
//      提交是「暂定」的，若后续审核打回可走 /steps/rollback；
//   3) 幂等可重入：状态存 D:\cc-tasks\chain-state.json，重复运行从断点继续；用锁文件避免并发。
// 用法: node cc-chain.mjs [chainFile] [--max-wait-min 25] [--no-commit]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
// 判据的**唯一来源**是仓库模块 lib/quota-parser.mjs（2026-09-19 跨运行时收敛）。
// 监督者（本链条）只**只读**它，并且 **fail-open**：模块缺失/损坏时按"未耗尽"继续 + 醒目告警，
// **绝不**在本文件里另写一份判据兜底（那正是"同一判断多处实现"的漂移源）。
// 其路径无空格（D:\dsh-web-relay\lib\…），因此在 Windows / WSL 两侧都能稳定引用，无需 shim。
const REPO_QUOTA_MODULE = 'file:///D:/dsh-web-relay/lib/quota-parser.mjs';
let quotaMod = null;
try {
  quotaMod = await import(REPO_QUOTA_MODULE);
} catch (e) {
  console.warn(`[cc-chain] ⚠ 无法加载配额唯一模块（${String((e && e.message) || e).slice(0, 160)}）`);
  console.warn('[cc-chain]   → fail-open：本轮按"未耗尽"继续（可能白探一次），且不写恢复时刻；请在仓库侧修复该模块。');
}
export const QUOTA_MODULE_LOADED = !!quotaMod;
// 判据与细节全部来自仓库模块（**本处不含任何判据**，只做字段映射）：
//   v17 之后模块已提供 classifyQuotaProbeDetail(text) → { available, kind, resetsAt }，
//   因此消费方不再需要自己拼 kind（此前那处 /weekly/i 兜底正是"多处实现"的缩小版，已删除）。
const parseQuotaResetsAt = quotaMod ? quotaMod.parseResetsAt : (() => null);
const shortcutCapMs = quotaMod ? quotaMod.shortcutCapMs : (() => 6 * 60 * 60 * 1000);
function classifyQuotaProbe(text) {
  if (!quotaMod) return { limited: false, kind: null, resetsAt: null, sawOk: false, degraded: true };
  if (typeof quotaMod.classifyQuotaProbeDetail !== 'function') {
    // 理论上不会发生（v17 已交付）；真发生时按 fail-open 处理并明确标注，避免悄悄用旧语义
    console.warn('[cc-chain] ⚠ 仓库配额模块缺少 classifyQuotaProbeDetail（v17 未生效？）→ 本轮按"未耗尽"继续');
    return { limited: false, kind: null, resetsAt: null, sawOk: false, degraded: true };
  }
  const d = quotaMod.classifyQuotaProbeDetail(text);
  // available 时 kind 无意义 → 置 null（消费方的呈现选择；判断本身仍全在仓库模块里）
  const limited = d.available !== true;
  return { limited, kind: limited ? (d.kind ?? null) : null, resetsAt: limited ? (d.resetsAt ?? null) : null, sawOk: d.available === true };
}
import { buildHumanSignal, writeHumanSignal, SIGNAL_PATH } from './chain-human-signal.mjs';

const CC = 'D:\\cc-tasks';
const REPO = 'D:\\dsh-web-relay';
const WORK = 'D:\\dsh relay test';
const args = process.argv.slice(2);
const chainFile = args.find((a) => !a.startsWith('--')) || 'cc-chains/v1-v3.mjs';
const mwIdx = args.indexOf('--max-wait-min');
const maxWaitMin = mwIdx >= 0 ? Number(args[mwIdx + 1]) : 25;
const noCommit = args.includes('--no-commit');
// 闭环开关：验收提交后自动做协议收口（start→complete→auto-review）。裁决仍由独立通道给出，**不是自批**；
// --min-reviewer 控制可接受的最低审核通道强度（默认 web-gemini=3：接受 external/swarm/web-gemini，
// 拒绝 dialog 兜底；且收口器另有自审守卫——本步由 cc 实现时，cc/claude 的裁决一律不接受）。
const closeAfterAccept = args.includes('--close-after-accept');
const mrIdx = args.indexOf('--min-reviewer');
const minReviewer = mrIdx >= 0 ? args[mrIdx + 1] : 'web-gemini';
const STATE = path.join(CC, 'chain-state.json');
const LOG = path.join(CC, 'chain.log');
const LOCK = path.join(CC, 'chain.lock');

// 项终态判定（纯函数，便于自测）。2026-09-16 修一处**标注缺陷**：
// 原实现为 `status: closeAfterAccept ? 'approved-and-closed' : 'accepted-awaiting-review'`——
// **只看开关、不看是否真的收口了**。而收口块的条件是 `if (closeAfterAccept && it.planStepId)`：
// 当链条项**没有 planStepId**（本会话的 v4/v5/v6 各链条都如此，为的是不给已收口计划伪造协议步骤）时，
// 根本不进入收口，却仍被标成 `approved-and-closed` —— 字样声称"已批准并闭环"，事实是"未收口、等人审"。
// 这会直接误导链条末尾的待审清单（§"主 agent 下一步"）与任何按状态判断的消费方。
export function itemFinalStatus({ closeAfterAccept, planStepId, closure }) {
  const closedOk = !!(closeAfterAccept && planStepId && closure && !closure.error);
  return closedOk ? 'approved-and-closed' : 'accepted-awaiting-review';
}

// 自测（无副作用）：node cc-chain.mjs --selftest-final-status
if (args.includes('--selftest-final-status')) {
  const cases = [
    ['[NEG] 无 planStepId + 传了开关（本次事故场景）→ 必须是 awaiting，不得声称已闭环',
      { closeAfterAccept: true, planStepId: null, closure: null }, 'accepted-awaiting-review'],
    ['[POS] 有 planStepId 且收口成功 → 已闭环',
      { closeAfterAccept: true, planStepId: '7', closure: { finalStatus: 'approved' } }, 'approved-and-closed'],
    ['[NEG] 有 planStepId 但收口失败（带 error）→ 不得声称已闭环',
      { closeAfterAccept: true, planStepId: '7', closure: { error: 'not-approved' } }, 'accepted-awaiting-review'],
    ['[POS] 没传开关 → awaiting',
      { closeAfterAccept: false, planStepId: '7', closure: { finalStatus: 'approved' } }, 'accepted-awaiting-review'],
    ['[NEG] 开关+planStepId 但 closure 缺失 → 不得声称已闭环',
      { closeAfterAccept: true, planStepId: '7', closure: null }, 'accepted-awaiting-review'],
  ];
  let bad = 0;
  for (const [name, input, expect] of cases) {
    const got = itemFinalStatus(input);
    const ok = got === expect;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}（期望 ${expect}，实际 ${got}）`);
  }
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} 通过`);
  process.exit(bad ? 1 : 0);
}

// 崩溃兜底：本脚本在流程早期取锁；若中途异常退出而未清锁，后续运行会被「已有运行中的链条」挡最长 30 分钟
// （2026-09-15 实际踩到：一次自测崩溃遗留 chain.lock）。这里保证任何未捕获异常都会清锁。
const dropLock = () => { try { fs.rmSync(LOCK, { force: true }); } catch { /* ignore */ } };
process.on('uncaughtException', (e) => { console.error('  [fatal] ' + ((e && e.stack) || e)); dropLock(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('  [fatal] ' + ((e && e.stack) || e)); dropLock(); process.exit(1); });

const log = (m) => {
  const line = `${new Date().toISOString()} ${m}`;
  fs.appendFileSync(LOG, line + '\n', 'utf8');
  console.log('  ' + m);
};

// ---- 锁：避免计划任务重入 ----
if (fs.existsSync(LOCK)) {
  const age = (Date.now() - fs.statSync(LOCK).mtimeMs) / 60000;
  if (age < 30) { log(`已有运行中的链条（锁 ${age.toFixed(1)} 分钟前），本次跳过`); process.exit(0); }
  log(`发现陈旧锁（${age.toFixed(1)} 分钟），接管`);
}
fs.writeFileSync(LOCK, String(process.pid), 'utf8');

const mod = await import(pathToFileURL(path.join(WORK, chainFile)).href);
const chain = mod.chain ?? mod.default;
// 链条状态按 chainId 隔离（2026-09-16 修正）：
// 状态文件是全局单文件（D:\cc-tasks\chain-state.json），而原实现无条件执行 `state.chainId = chain.id`，
// 于是把调度器指向**另一条**链条时，旧链条的 index/completedAt 会被整体继承。实测后果：
// v1-v3 完成后 index=5，指向仅 1 项的 v4 链条时命中 L251 已完成守卫（5 >= 1），
// 打印「链条已于 … 完成，本次跳过」并 exit 0 —— 装填看似成功、实则**永不派发**（静默空转）。
// 语义修正：chainId 变化即视为换链条 → 旧状态先另存备份（审计留痕），再重开本链条状态。
let state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
// 诊断模式（--selftest-quota / --probe-only）**不得**产生状态副作用（2026-09-16 修正）：
// 二者都不传链条文件 → 默认落到 v1-v3 → 会被下面的「换链条」逻辑当成换链，写出多余的备份文件；
// 且 --probe-only 会走 quotaAvailable()，而新增的探针落盘 save() 会把**被换掉的空状态**写进
// chain-state.json —— 足以抹掉活跃链条的进度。故诊断模式直接跳过换链条。
const diagnosticOnly = args.includes('--selftest-quota') || args.includes('--probe-only');
if (!diagnosticOnly && state && state.chainId && state.chainId !== chain.id) {
  const backup = path.join(CC, `chain-state.${state.chainId}.json`);
  try {
    fs.writeFileSync(backup, JSON.stringify(state, null, 2), 'utf8');
    log(`检测到换链条（${state.chainId} → ${chain.id}）：旧状态已备份至 ${backup}，本链条状态重开`);
  } catch (e) {
    log(`检测到换链条（${state.chainId} → ${chain.id}）：旧状态备份失败（${e.message}），仍重开本链条状态`);
  }
  state = null;
}
if (!state) state = { chainId: chain.id, index: 0, items: {}, startedAt: new Date().toISOString() };
// 诊断模式同样**不得改写 chainId**（2026-09-16 07:57 实测缺口，比上面那条更隐蔽）：
// 上面只挡住了「换链条 + 写备份」，但本行原本无条件执行，而诊断路径仍会调用 save()
// （探针成功后清空 state.quotaResetsAt → save()），于是把当前链条的**归属**写成默认链条 v1-v3。
// 实测后果：跑 regression-post-restart（内含 --probe-only）后 chain-state 变成
// chainId=v1-v3 而 item=A4b、index=1；调度器指向 v4-a4b 时会被判为「换链条」→ 重开状态
// → **把已完成的项重新派发一遍**。故诊断模式下保持 chainId 原样。
if (!diagnosticOnly) state.chainId = chain.id;

function save() { fs.writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8'); }

// 解析 claude.log 里的额度恢复时间（如 "You've hit your session limit · resets 3:20am (Asia/Shanghai)"）
// → 返回未来时刻的 ISO 字符串；解析不出返回 null（不抛错）。
// 用途：探针与真实任务的额度判定可能不一致（2026-09-15 02:00 实测：探针 OK 而真实任务 4 秒后 cc-quota-exhausted），
// 有了已知恢复时间就不必再盲探/盲派，直接等到点再试。
// 2026-09-16 修正：**分钟可选**。本环境真实文案是 `resets 7am (Asia/Shanghai)`（只有小时、没有分钟），
// 而原正则要求 H:MM → 恒返回 null → 已知耗尽短路不生效、每次调度仍白跑一次探针。
// （relay 侧同名解析的 8 小时时区偏差已在 lib/cc-channel.js 修正；本函数用机器本地时区 setHours，
//   本机本地即 Asia/Shanghai，故无该偏差——但这也意味着它**忽略文案里的时区**，已在此备记。）
// 判据已**收敛到唯一模块** quota-classify.mjs（2026-09-19）：本文件不再自带实现，只做再导出，
// 以免"同一判断多处实现"再次漂移（该模块头部注释记录了五处副本与 weekly limit 事故的来龙去脉）。
export { parseQuotaResetsAt, classifyQuotaProbe, shortcutCapMs };

/**
 * 写共享配额状态 cc-quota-state.json（与 runner / scripts/quota-state-write.mjs 同 schema），
 * 供插件 /health-check 与分层审计读取。
 * 为什么必须由链条也写（2026-09-19 实测）：该文件此前**只有 runner 会写**（source:"runner"），
 * 而链条在**探测阶段**就暂停时压根没有任务跑到 runner → 文件长期停在 09-17 的旧值，
 * 插件侧显示一个过期数天的"恢复时刻"。
 * 纪律：恢复时刻只允许**向后**推进（绝不改早）；payload=null 表示已恢复可用（删除该文件）。
 */
function writeSharedQuotaState(payload) {
  const P = path.join(CC, 'cc-quota-state.json');
  try {
    if (payload === null) { fs.rmSync(P, { force: true }); return; }
    if (payload.resetsAt) {
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(P, 'utf8')).resetsAt || null; } catch { /* 无旧值 */ }
      const prevMs = prev ? Date.parse(prev) : NaN;
      const nextMs = Date.parse(payload.resetsAt);
      if (Number.isFinite(prevMs) && Number.isFinite(nextMs) && nextMs < prevMs) return; // 绝不改早
    }
    fs.writeFileSync(P, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) { log(`⚠ 写共享配额状态失败（不影响判定）：${e.message}`); }
}

function quotaAvailable() {
  // 已知耗尽且未到恢复点 → 直接短路（不探针、不派发），避免白耗一次派发。
  // 保护上限按**限额类型**分开（2026-09-19 修）：会话限额 6h；**周限额** 24h ——
  // 实测周限额恢复点在 ~15.7h 之后，用 6h 上限会导致它永远短路不了、每 20 分钟白探一次（45+ 次/天）。
  // 保护上限按限额类型分开（见 shortcutCapMs）。是否用 24h 由 kind 决定。
  const known = state.quotaResetsAt ? Date.parse(state.quotaResetsAt) : NaN;
  const capMs = shortcutCapMs(state.quotaKind);
  if (Number.isFinite(known) && known > Date.now() && (known - Date.now()) <= capMs) {
    return { ok: false, out: `已知额度耗尽（${state.quotaKind || 'session'}，预计 ${state.quotaResetsAt} 恢复，≤${capMs / 3600000}h 内短路），跳过探针与派发`, known: true };
  }
  const r = spawnSync('wsl.exe', ['-e', 'bash', '-lc', "cd /mnt/d/cc-tasks && timeout 90 claude -p 'Reply with exactly: OK' 2>&1 | tail -c 300"], { encoding: 'utf8' });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const cls = classifyQuotaProbe(out);
  const limited = cls.limited;
  if (!limited) {
    state.quotaResetsAt = null;
    state.quotaKind = null;
    if (!diagnosticOnly) { save(); writeSharedQuotaState(null); }
  }
  // 探针已确认耗尽时把恢复时刻落盘（2026-09-16 补；2026-09-19 补 kind 与共享状态文件）：
  // 只允许**向后**推进（绝不把已知恢复时刻改早），与 quota-state-write.mjs 的纪律一致；
  // 短路上限按 kind 决定（会话 6h / 周 24h），见函数开头。
  if (limited) {
    const at = cls.resetsAt;
    const prev = state.quotaResetsAt ? Date.parse(state.quotaResetsAt) : NaN;
    state.quotaKind = cls.kind;
    if (at && (!Number.isFinite(prev) || Date.parse(at) > prev)) {
      state.quotaResetsAt = at;
      if (!diagnosticOnly) {
        save();
        writeSharedQuotaState({ kind: 'quota-exhausted', resetsAt: at, at: new Date().toISOString(), source: 'chain', quotaKind: cls.kind });
      }
      log(`探针确认额度耗尽（${cls.kind}），记录恢复时刻 ${at}（${(state.quotaKind === 'weekly' ? 24 : 6)}h 内后续触发将短路，不再白跑探针）`);
    } else if (!at) {
      // 解析不出恢复时刻也要落"已耗尽"这个事实（此前只有 runner 会写，导致插件侧长期显示旧值）
      if (!diagnosticOnly) writeSharedQuotaState({ kind: 'quota-exhausted', resetsAt: null, at: new Date().toISOString(), source: 'chain', quotaKind: cls.kind });
      log(`探针确认额度耗尽（${cls.kind}）但未能解析恢复时刻 → 仍每轮探测`);
    }
  }
  return { ok: !limited, out: out.trim().slice(0, 200) };
}

// 重跑前清理上次尝试的残留：watchdog 对已存在 tasks/<id>/task.json 的任务会当重复跳过（L32-36），
// 且 waitResult 会读到上次那份失败的 result.json → 若不清理，断点续跑会无限空转。
// 处置：把整个 tasks/<id>/ 归档到 tasks/_retry-archive/ 后移除，使 watchdog 视其为新任务。
function clearStaleAttempt(taskId) {
  const dir = path.join(CC, 'tasks', taskId);
  const rp = path.join(dir, 'result.json');
  if (!fs.existsSync(dir) || !fs.existsSync(rp)) return false;
  const arch = path.join(CC, 'tasks', '_retry-archive', `${taskId}-${Date.now()}`);
  fs.mkdirSync(path.dirname(arch), { recursive: true });
  try {
    fs.renameSync(dir, arch);
    log(`清理上次尝试残留（已归档 ${path.relative(CC, arch)}），允许重跑 ${taskId}`);
    return true;
  } catch (e) {
    log(`清理残留失败（${e.code || e.message}），改为仅移除 result.json/done.flag`);
    fs.rmSync(rp, { force: true });
    fs.rmSync(path.join(dir, 'done.flag'), { force: true });
    return true;
  }
}

// 额度解析自测（无副作用）：node cc-chain.mjs --selftest-quota
// 直接 import 本脚本会执行整条链（顶层副作用），故单测入口必须内置。
if (args.includes('--selftest-quota')) {
  const t1 = parseQuotaResetsAt("You've hit your session limit · resets 3:20am (Asia/Shanghai)");
  const t2 = parseQuotaResetsAt('resets 11:05pm (Asia/Shanghai)');
  const t3 = parseQuotaResetsAt('resets 12:30pm');
  const t4 = parseQuotaResetsAt('no reset here');
  // 2026-09-16 增补：**本环境真实文案是仅小时形态**（实测 2026-09-16T18:57Z 任务失败的 claude.log 全文）。
  // 旧正则要求 H:MM → 恒 null → 已知耗尽短路不生效。此两条为该修复的回归守卫。
  const t5 = parseQuotaResetsAt("You've hit your session limit · resets 7am (Asia/Shanghai)");
  const t6 = parseQuotaResetsAt('resets 7am');
  const future1 = t1 && new Date(t1) > new Date();
  const future2 = t2 && new Date(t2) > new Date();
  const future3 = t3 && new Date(t3) > new Date();
  const future5 = t5 && new Date(t5) > new Date();
  const future6 = t6 && new Date(t6) > new Date();
  console.log('  [selftest] parseQuotaResetsAt');
  console.log(`    "resets 3:20am" → ${t1}（未来=${future1}）`);
  console.log(`    "resets 11:05pm" → ${t2}（未来=${future2}）`);
  console.log(`    "resets 12:30pm" → ${t3}（未来=${future3}）`);
  console.log(`    "resets 7am (Asia/Shanghai)"（真实文案·仅小时）→ ${t5}（未来=${future5}）`);
  console.log(`    "resets 7am"（仅小时·无时区）→ ${t6}（未来=${future6}）`);
  console.log(`    无恢复时间 → ${t4}（应为 null=${t4 === null}）`);
  // 精确性守卫：仅小时形态的分钟必须为 0（防「顺延一天」把小时也带偏）
  const minuteOk = t5 && new Date(t5).getMinutes() === 0;
  console.log(`    仅小时形态的分钟应为 0 → ${minuteOk}`);
  const ok = future1 && future2 && future3 && future5 && future6 && minuteOk && t4 === null;

  // 2026-09-19 增补：**分类器**（本次事故的正主）。真实文案是 weekly limit，旧判据漏掉 → 不落盘恢复时刻 → 每 20 分钟白探。
  console.log('  [selftest] classifyQuotaProbe');
  // 期望值按**仓库唯一模块的规范语义**（v17）：kind 词表 = weekly|rate|usage|session|unknown
  // （weekly > rate > usage > session > unknown）；无限额措辞时为 'unknown' 而**不是** session。
  // 教训：这类期望会随被收敛模块的语义变化而过时——改完要回看（L-2026-0919-087）。
  const cases = [
    ["You've hit your weekly limit · resets 2am (Asia/Shanghai)", { limited: true, kind: 'weekly' }],
    ["You've hit your session limit · resets 7am (Asia/Shanghai)", { limited: true, kind: 'session' }],
    ['rate limit reached, resets 3:20am', { limited: true, kind: 'rate' }],
    ['OK', { limited: false, kind: null }],
    ['OK\n(some noise)', { limited: false, kind: null }],
    // 探针契约是"可用时打印 OK" → 没有 OK 就是不可用（保守判耗尽，避免把配额浪费在盲派上）；
    // 但**种类**无从判断 → 'unknown'（规范语义不允许默认成 session，那会谎报种类并误用 6h 上限的判断依据）
    ['something unexpected without ok token', { limited: true, kind: 'unknown' }],
  ];
  let clsOk = true;
  for (const [text, want] of cases) {
    const got = classifyQuotaProbe(text);
    const pass = got.limited === want.limited && got.kind === want.kind;
    if (!pass) clsOk = false;
    console.log(`    ${pass ? 'PASS' : 'FAIL'}  limited=${got.limited} kind=${got.kind}（期望 ${want.limited}/${want.kind}）← ${text.slice(0, 46)}`);
  }
  // 周限额必须真的解析出恢复时刻（这是"不再白探"的前提）
  const wk = classifyQuotaProbe("You've hit your weekly limit · resets 2am (Asia/Shanghai)");
  const weekParsed = !!wk.resetsAt && new Date(wk.resetsAt) > new Date();
  console.log(`    weekly 恢复时刻已解析 = ${weekParsed} → ${wk.resetsAt}`);
  // 短路上限按类型分（周 24h / 会话 6h）——否则周限额永远短路不了
  const capOk = shortcutCapMs('weekly') === 24 * 3600000 && shortcutCapMs('session') === 6 * 3600000 && shortcutCapMs(null) === 6 * 3600000;
  console.log(`    shortcutCapMs: weekly=${shortcutCapMs('weekly') / 3600000}h session=${shortcutCapMs('session') / 3600000}h → ${capOk}`);

  const allOk = ok && clsOk && weekParsed && capOk;
  console.log(`  RESULT: ${allOk ? 'PASS' : 'FAIL'}`);
  fs.rmSync(LOCK, { force: true });
  process.exit(allOk ? 0 : 1);
}

// 协议门：读取计划状态（用于 requiresApproved 检查与 --selftest-gate）
const RELAY = 'http://127.0.0.1:3080/dsh-web-relay';
const EXPR = 'expr-2026-09-13_17-36-07';
async function fetchPlanSteps() {
  const r = await fetch(`${RELAY}/steps?cwd=${encodeURIComponent(WORK)}&id=${encodeURIComponent(EXPR)}`);
  if (!r.ok) throw new Error(`GET /steps HTTP ${r.status}`);
  return await r.json();
}
function gateStatus(plan, need) {
  const missing = (need || []).filter((sid) => {
    const s = (plan.steps || []).find((x) => String(x.id) === String(sid));
    return !s || s.status !== 'approved';
  });
  return { ok: missing.length === 0, missing };
}

// 协议门自测（无副作用、不需要额度）：node cc-chain.mjs --selftest-gate
if (args.includes('--selftest-gate')) {
  const plan = await fetchPlanSteps();
  const need = chain.items.find((i) => Array.isArray(i.requiresApproved))?.requiresApproved || [];
  const g = gateStatus(plan, need);
  console.log('  [selftest] 协议门（V2-1 前的 requiresApproved）');
  console.log(`    需要 approved 的计划步骤 = [${need.join(',')}]`);
  console.log(`    当前状态 = ${need.map((sid) => `${sid}:${(plan.steps || []).find((x) => String(x.id) === String(sid))?.status || '缺失'}`).join(' ')}`);
  console.log(`    门判定 = ${g.ok ? 'OPEN（可推进 V2）' : 'CLOSED（缺 ' + g.missing.join(',') + '）'}`);
  const ok = need.length > 0 && typeof g.ok === 'boolean';
  console.log(`  RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  fs.rmSync(LOCK, { force: true });
  process.exit(ok ? 0 : 1);
}

// 探针模式（无副作用）：node cc-chain.mjs --probe-only
// 只跑额度探针并打印结论，不派发、不改状态。供回归套件/巡检使用——
// 此前回归套件的「干跑」用例在探针偶然返回 OK 时会**真的派发任务**（2026-09-15 02:00 实际发生过）。
if (args.includes('--probe-only')) {
  const q = quotaAvailable();
  console.log(`  quota=${q.ok ? 'available' : 'limited'} | probe=${q.out}`);
  fs.rmSync(LOCK, { force: true });
  process.exit(0);
}

// 自测入口（不需要额度即可运行）：node cc-chain.mjs --selftest-clear
// 目的：clearStaleAttempt 只在额度可用、进入重试路径时才被走到；若它坏了，表现为整夜空转。
// 本自测用合成目录验证两条语义：① 有 result.json → 归档并移除（返回 true）；② 无 result.json（上次仍在运行）→ 不动（返回 false）。
if (args.includes('--selftest-clear')) {
  const id = `selftest-clear-${Date.now()}`;
  const dir = path.join(CC, 'tasks', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ status: 'failed', errorCode: 'cc-quota-exhausted' }), 'utf8');
  const did = clearStaleAttempt(id);
  const removed = !fs.existsSync(dir);
  const archRoot = path.join(CC, 'tasks', '_retry-archive');
  const archived = fs.existsSync(archRoot) && fs.readdirSync(archRoot).some((n) => n.startsWith(id));
  // 情形②：仅 task.json（上次仍在运行）→ 不得清理
  const id2 = `${id}-running`;
  const d2 = path.join(CC, 'tasks', id2);
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d2, 'task.json'), '{}', 'utf8');
  const did2 = clearStaleAttempt(id2);
  const kept = fs.existsSync(d2);
  // 清理自测残留
  fs.rmSync(d2, { recursive: true, force: true });
  if (fs.existsSync(archRoot)) for (const n of fs.readdirSync(archRoot).filter((x) => x.startsWith(id))) fs.rmSync(path.join(archRoot, n), { recursive: true, force: true });
  const ok = did === true && removed && archived && did2 === false && kept;
  console.log('  [selftest] clearStaleAttempt');
  console.log(`    ① 有 result.json → 返回 true=${did === true} 目录已移除=${removed} 归档副本存在=${archived}`);
  console.log(`    ② 无 result.json（上次仍在运行）→ 返回 false=${did2 === false} 目录保留=${kept}`);
  console.log(`  RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  fs.rmSync(LOCK, { force: true });
  process.exit(ok ? 0 : 1);
}

function waitResult(taskId, minutes) {
  const rp = path.join(CC, 'tasks', taskId, 'result.json');
  const deadline = Date.now() + minutes * 60000;
  while (Date.now() < deadline) {
    if (fs.existsSync(rp)) {
      try { return JSON.parse(fs.readFileSync(rp, 'utf8')); } catch { /* 半写，继续等 */ }
    }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { encoding: 'utf8' });
  }
  return null;
}

function commitItem(taskId, label) {
  const gs = spawnSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' });
  const files = String(gs.stdout || '').split('\n').filter(Boolean).map((l) => l.replace(/^(\?\?|M|A|D|\s)+/, '').trim());
  if (!files.length) return null;
  spawnSync('git', ['-C', REPO, 'add', '--', ...files], { encoding: 'utf8' });
  const msg = `feat(plan): ${label}（cc 任务 ${taskId}，机械验收通过；协议审核待主 agent 记录）`;
  const c = spawnSync('git', ['-C', REPO, 'commit', '-q', '-m', msg], { encoding: 'utf8' });
  if (c.status !== 0) { log(`提交失败: ${String(c.stderr || '').slice(0, 200)}`); return null; }
  const sha = String(spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim();
  log(`已提交 ${sha}（${files.length} 文件）: ${label}`);
  return { sha, files };
}

log(`链条 ${chain.id} 启动，共 ${chain.items.length} 项，当前 index=${state.index}`);

// 已完成守卫：链条跑完后计划任务仍会按期触发，这里直接快速退出（不再重复探测额度/重写清单）
if (state.completedAt && state.index >= chain.items.length) {
  log(`链条已于 ${state.completedAt} 完成，本次跳过`);
  fs.rmSync(LOCK, { force: true });
  process.exit(0);
}

for (let i = state.index; i < chain.items.length; i++) {
  const it = chain.items[i];
  log(`--- [${i + 1}/${chain.items.length}] ${it.label} (taskId=${it.taskId}) ---`);

  // 幂等跳过：若计划中该步**已 approved**，不再重复派发。
  // 场景：某步审核被打回 → 主 agent 补证 reopen→complete→重审通过（approved），而链状态仍是 review-rejected；
  // 若不做此检查，链条会把已批准的工作**重新实现一遍**（2026-09-15 V2-1 实际发生）。
  if (it.planStepId) {
    try {
      const plan0 = await fetchPlanSteps();
      const s0 = (plan0.steps || []).find((x) => String(x.id) === String(it.planStepId));
      if (s0 && s0.status === 'approved') {
        log(`计划步骤 ${it.planStepId} 已 approved → 跳过派发（幂等），继续下一项`);
        state.items[it.label] = { ...(state.items[it.label] || {}), status: 'already-approved', planStepId: it.planStepId, at: new Date().toISOString() };
        state.index = i + 1;
        save();
        continue;
      }
    } catch (e) {
      log(`计划状态读取失败（${e.message}）→ 不跳过，按常规流程处理`);
    }
  }

  // 协议门（若该项声明 requiresApproved）：先查计划状态，未过门则暂停等主 agent 收口——
  // 放在额度探针之前，避免为「注定不能推进」的项浪费探针与派发。
  if (Array.isArray(it.requiresApproved) && it.requiresApproved.length) {
    try {
      const plan = await fetchPlanSteps();
      const g = gateStatus(plan, it.requiresApproved);
      if (!g.ok) {
        log(`协议门未满足：需计划步骤 [${it.requiresApproved.join(',')}] 全部 approved，当前未通过 = [${g.missing.join(',')}]`);
        state.items[it.label] = { ...(state.items[it.label] || {}), status: 'awaiting-gate', detail: `not approved: ${g.missing.join(',')}`, at: new Date().toISOString() };
        save(); fs.rmSync(LOCK, { force: true });
        log('等待主 agent 完成版间门后重跑（本项不派发）');
        process.exit(3);
      }
      log(`协议门已通过（[${it.requiresApproved.join(',')}] 均 approved），继续派发`);
    } catch (e) {
      log(`协议门检查失败（${e.message}）→ 保守暂停，不派发`);
      state.items[it.label] = { ...(state.items[it.label] || {}), status: 'gate-check-failed', detail: e.message, at: new Date().toISOString() };
      save(); fs.rmSync(LOCK, { force: true });
      process.exit(3);
    }
  }

  const q = quotaAvailable();
  if (!q.ok) {
    log(`额度不可用，暂停链条：${q.out}`);
    state.items[it.label] = { ...(state.items[it.label] || {}), status: 'quota-paused', at: new Date().toISOString() };
    save(); fs.rmSync(LOCK, { force: true }); process.exit(3);
  }

  // 规格前置检查：语法坏的规格会白占一个稀缺额度窗口（本会话已踩 4 次模板字面量崩因）
  const specCheck = spawnSync(process.execPath, ['--check', path.join(WORK, it.spec)], { encoding: 'utf8' });
  if (specCheck.status !== 0) {
    log(`规格语法检查失败，跳过本项并停止链条：${it.spec}`);
    log('  ' + String(specCheck.stderr || '').split('\n').slice(0, 3).join(' '));
    state.items[it.label] = { ...(state.items[it.label] || {}), status: 'spec-broken', detail: String(specCheck.stderr || '').slice(0, 200), at: new Date().toISOString() };
    save(); fs.rmSync(LOCK, { force: true }); process.exit(1);
  }

  // 重跑前清理上次尝试的残留（额度暂停/等待超时/验收打回后再次进入本项时）
  const prev = state.items[it.label];
  if (prev && ['quota-paused', 'waiting', 'verify-rejected', 'dispatch-failed'].includes(prev.status)) {
    // ★ 重派护栏（2026-09-16，真实事故后新增）：
    // 原逻辑下「verify-rejected」可被 clearStaleAttempt 重派，而**持久性失败**（验收器缺陷、仓库污染
    // 导致的越界等）会让链条每 20 分钟重派一次、无限烧配额——实测 25 次、约 87 分钟 cc 执行时间。
    // 故对同一项的重派计数设上限：达到上限即停下等人，而不是继续重试。
    const failCount = prev.failCount || 0;
    const MAX_ITEM_ATTEMPTS = Number(process.env.DSH_CC_MAX_ITEM_ATTEMPTS || 3);
    if (failCount >= MAX_ITEM_ATTEMPTS) {
      log(`✗ 项「${it.label}」已连续失败 ${failCount} 次（上限 ${MAX_ITEM_ATTEMPTS}）→ 停止链条并等人处理（防无限重派）`);
      state.items[it.label] = { ...prev, status: 'paused-too-many-attempts', at: new Date().toISOString() };
      save();
      // 写下"需要人"的机器可读信号：插件会在 boot / 周期心跳时读到并**唤醒主 agent**。
      // 否则链条停在后只能静静等人来看（实测：v11 停下后无人被叫醒，直到人问了一句）。
      try {
        const sig = buildHumanSignal({
          chainId: state.chainId, reason: 'too-many-attempts', taskId: it.taskId,
          detail: `项「${it.label}」连续失败 ${failCount} 次（上限 ${MAX_ITEM_ATTEMPTS}）`,
          attempts: failCount,
        });
        writeHumanSignal(sig);
        log(`→ 已写需要人介入信号：${SIGNAL_PATH}（${sig.id}）`);
      } catch (e) { log(`⚠ 写需要人介入信号失败（不阻断收尾）：${e.message}`); }
      fs.rmSync(LOCK, { force: true });
      process.exit(4);
    }
    clearStaleAttempt(it.taskId);
  }

  // 派发（若同名任务已在 queue/ 或已完成，cc-dispatch 会报重复——此时继续等待其结果即可）
  const d = spawnSync(process.execPath, ['cc-dispatch.mjs', it.spec], { cwd: WORK, encoding: 'utf8' });
  const dOut = String(d.stdout || '') + String(d.stderr || '');
  log(`派发: ${dOut.replace(/\s+/g, ' ').slice(0, 220)}`);
  const queued = /\[queued\]/.test(dOut) || /已存在同名任务/.test(dOut);
  if (!queued) {
    state.items[it.label] = { status: 'dispatch-failed', detail: dOut.slice(0, 300), at: new Date().toISOString() };
    save(); fs.rmSync(LOCK, { force: true }); process.exit(1);
  }

  const res = waitResult(it.taskId, maxWaitMin);
  if (!res) {
    log('等待结算超时（可能仍在执行），本次暂停，下次运行会继续等待');
    state.items[it.label] = { status: 'waiting', at: new Date().toISOString() };
    save(); fs.rmSync(LOCK, { force: true }); process.exit(3);
  }
  log(`结算: ${JSON.stringify(res)}`);

  if (res.errorCode === 'cc-quota-exhausted') {
    // 记录已知恢复时间（解析 claude.log），后续轮次直接短路到该时刻，不再盲探/盲派
    let resetAt = null;
    try {
      const logText = fs.readFileSync(path.join(CC, 'tasks', it.taskId, 'claude.log'), 'utf8');
      resetAt = parseQuotaResetsAt(logText);
    } catch { /* 日志缺失则仅沿用旧值 */ }
    if (resetAt) {
      state.quotaResetsAt = resetAt;
      log(`解析到额度恢复时间：${resetAt}（claude.log）`);
    }
    state.items[it.label] = { status: 'quota-paused', detail: res.errorCode, quotaResetsAt: state.quotaResetsAt || null, at: new Date().toISOString() };
    save(); fs.rmSync(LOCK, { force: true }); log('额度耗尽，暂停链条'); process.exit(3);
  }

  // 独立验收（不采信 result.json 的 status）
  const v = spawnSync(process.execPath, ['verify-cc-task.mjs', it.taskId], { cwd: WORK, encoding: 'utf8' });
  const vOut = String(v.stdout || '');
  const instrumentErr = v.status === 3;   // 见 verify-cc-task：探针缺失/超时/异常退出 → 工具错误
  const accept = v.status === 0;
  log(`验收: ${instrumentErr ? 'INSTRUMENT-ERROR' : accept ? 'ACCEPT' : 'REJECT'}`);
  if (instrumentErr) {
    // 工具错误 ≠ 产物不合格：**不得**计入 failCount、不得触发重派（重派只会重复烧额度，因为工具坏了）。
    // 教训来源（2026-09-16）：验收器因 EISDIR 崩溃 → 非零退出被读成 REJECT → 每 20 分钟重派一次，共 25 次。
    const why = vOut.split('\n').filter((l) => /工具错误|INSTRUMENT-ERROR/.test(l)).join(' | ');
    state.items[it.label] = { status: 'probe-broken', detail: why.slice(0, 300), result: res, at: new Date().toISOString() };
    save();
    // 同样写"需要人"信号：工具坏了必须人来修，静默停在这里等于自动化悄悄失效。
    try {
      const sig = buildHumanSignal({
        chainId: state.chainId, reason: 'instrument-error', taskId: it.taskId,
        detail: `验收器自身出错（exit 3）：${why.slice(0, 300)}`,
      });
      writeHumanSignal(sig);
      log(`→ 已写需要人介入信号：${SIGNAL_PATH}（${sig.id}）`);
    } catch (e) { log(`⚠ 写需要人介入信号失败（不阻断收尾）：${e.message}`); }
    fs.rmSync(LOCK, { force: true });
    log('✗ 验收工具本身出错 → 停止链条并等人修工具（不重派、不计失败次数）');
    process.exit(5);
  }
  if (!accept) {
    const tail = vOut.split('\n').filter((l) => l.includes('[FAIL]')).join(' | ');
    const failCount = ((state.items[it.label] || {}).failCount || 0) + 1;
    state.items[it.label] = { status: 'verify-rejected', detail: tail.slice(0, 300), result: res, failCount, at: new Date().toISOString() };
    save(); fs.rmSync(LOCK, { force: true }); process.exit(1);
  }

  const commit = noCommit ? null : commitItem(it.taskId, it.label);

  // 先落「已验收」状态再收口：收口器的前置守卫会读 chain-state 判断该步是否已落地，
  // 若顺序反过来（先收口后写状态），守卫会因读不到 accepted 记录而拒绝收口。
  state.items[it.label] = {
    status: 'accepted-awaiting-review',
    planStepId: it.planStepId,
    result: { status: res.status, exit: res.exit, errorCode: res.errorCode || null, end: res.end },
    commit,
    at: new Date().toISOString(),
  };
  save();

  // 协议收口（可选闭环）：裁决来自 /steps/auto-review 的独立通道；若未通过或通道强度不足则停止链条等人。
  let closure = null;
  if (closeAfterAccept && it.planStepId) {
    // 收口含外部审核（Swarm 双角色时是两次调用），必须设超时：否则外部通道卡住会让链条无限阻塞，
    // 而计划任务每 20 分钟还会因锁跳过，表现为「链条静默停摆」。超时按 closure-timeout 停止并留状态。
    const CLOSE_TIMEOUT_MS = 20 * 60 * 1000;
    const cl = spawnSync(process.execPath, ['protocol-close-step.mjs', String(it.planStepId), '--task', it.taskId, '--json', '--min-reviewer', minReviewer], { cwd: WORK, encoding: 'utf8', timeout: CLOSE_TIMEOUT_MS });
    const timedOut = cl.error && (cl.error.code === 'ETIMEDOUT' || cl.signal);
    const out = String(cl.stdout || '');
    const jline = out.split('\n').find((l) => l.startsWith('__JSON__'));
    try { closure = jline ? JSON.parse(jline.slice(8)) : null; } catch { closure = null; }
    if (timedOut) closure = { error: 'closure-timeout', timeoutMs: CLOSE_TIMEOUT_MS };
    log(`协议收口 step ${it.planStepId}: exit=${cl.status}${timedOut ? ' (超时)' : ''} ${closure ? JSON.stringify(closure) : out.trim().slice(-200)}`);
    if (cl.status !== 0) {
      const st = closure?.error === 'closure-timeout' ? 'closure-timeout'
        : closure?.error === 'self-review-rejected' ? 'self-review-rejected'
          : closure?.error === 'reviewer-too-weak' ? 'reviewer-too-weak'
            : closure?.error === 'not-approved' ? 'review-rejected'
              : closure?.error === 'not-landed' || closure?.error === 'no-chain-record' ? 'closure-blocked'
                : 'closure-failed';
      state.items[it.label] = { ...state.items[it.label], status: st, detail: JSON.stringify(closure || {}).slice(0, 240) };
      save(); fs.rmSync(LOCK, { force: true });
      log(`协议收口未通过（${st}）→ 停止链条，等待人工/主 agent 处理`);
      process.exit(1);
    }
  }

  state.items[it.label] = {
    ...state.items[it.label],
    status: itemFinalStatus({ closeAfterAccept, planStepId: it.planStepId, closure }),
    closure,
  };
  state.index = i + 1;
  save();
}

// 链条完成 → 产出待审清单（协议审核仍由主 agent 执行，链条不代批）
const lines = [
  '# cc 链条完成 — 待主 agent 协议审核',
  '',
  `链条: ${chain.id} | 完成时间: ${new Date().toISOString()}`,
  '',
  '| 计划步骤 | 任务 | 提交 | 任务记录 | 状态 |',
  '| --- | --- | --- | --- | --- |',
];
for (const it of chain.items) {
  const s = state.items[it.label] || {};
  lines.push(`| ${it.planStepId || '-'} | ${it.label} | ${s.commit?.sha || '-'} | ${s.result?.status || '-'}${s.result?.errorCode ? ' / ' + s.result.errorCode : ''} | ${s.status} |`);
}
lines.push('', '## 主 agent 下一步（不得跳过）', '',
  '1. 对每个 accepted-awaiting-review 项：POST /steps/update action=start（首次）→ complete（带证据）→ POST /steps/auto-review 取得独立审核结论；',
  '2. 高价值步骤（importance=high 且 review=true）**禁止自审自批**，必须走外部/降级链审核；',
  '3. 若审核打回：走 /steps/rollback 回到该步基线（提交仅为暂定），修正后重提；',
  '4. 全部 approved 后再评估版间门（V1 完成后即第 3 步），并核对 finalAcceptance。', '');
fs.writeFileSync(path.join(CC, 'chain-review-needed.md'), lines.join('\n'), 'utf8');
state.completedAt = new Date().toISOString();
save();
log('链条全部完成，已产出 D:\\cc-tasks\\chain-review-needed.md');
// 链条跑完 ≠ 事情结束：还有"协议复核 + 收口"必须由主 agent 做（原本只产出一份 md 给人看）。
// 这里登记为需要人介入 → 插件会唤醒主 agent 来收口，而不是等下一次人工巡视。
try {
  const pending = chain.items.filter((it) => (state.items[it.label] || {}).status === 'accepted-awaiting-review');
  if (pending.length) {
    const sig = buildHumanSignal({
      chainId: state.chainId, reason: 'review-needed',
      detail: `链条全部完成，${pending.length} 项待协议复核/收口：${pending.map((it) => it.label).join('；')}`,
    });
    writeHumanSignal(sig);
    log(`→ 已写需要人介入信号：${SIGNAL_PATH}（${sig.id}）`);
  }
} catch (e) { log(`⚠ 写需要人介入信号失败（不阻断收尾）：${e.message}`); }
fs.rmSync(LOCK, { force: true });
process.exit(0);
