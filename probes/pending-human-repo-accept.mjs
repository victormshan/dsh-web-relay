// 仓库侧验收探针：「需要人介入 → 唤醒」这条通路的**产物级**验收（不需要交付重启即可判定）。
//
// 为什么要与实机探针分开（2026-09-18 设计修正）：
//   实机探针 probes/pending-human-accept.mjs 读的是**运行中的宿主**（打 /admin/heartbeat-check + /health-check），
//   而链条的验收发生在**交付+重启之前** —— 顺序冲突会让一份正确的实现被判失败（本会话已经因为"环境/顺序"误判过两轮）。
//   故拆成两层：
//     · 本探针（仓库侧，链条用它）：真 import 模块调纯函数 + 校验接线与契约 —— 当场可判、可复跑；
//     · 实机探针（交付重启后由主 agent 跑）：证明宿主真的会读信号并唤醒。
//   两层都接地到产物，而不是散文。
//
// 用法: node probes/pending-human-repo-accept.mjs [taskId]
//       node probes/pending-human-repo-accept.mjs --selftest
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 仓库根按平台取：**探针必须两个平台都能跑**（2026-09-18 实测教训）。
// runner（生产路径，WSL/POSIX）会执行声明的 acceptanceScript，而主 agent 的验收器在 Windows 上执行它；
// 初版硬编码 Windows 路径 + file:///D:/ → 在 WSL 里 import 直接失败 → runner 侧把一份合格实现判成
// [acceptance-script][FAIL]（v10/v11/v12 三次自报 failed 都是这个原因）。
const REPO = process.env.DSH_REPO || (process.platform === 'win32' ? 'D:\\dsh-web-relay' : '/mnt/d/dsh-web-relay');
const results = [];
const check = (label, cond, detail = '') => { results.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };

function selftest() {
  // 分类器自检：给定的 pendingHuman 形状是否表示"通路有效"（避免探针本身是永真的）
  const willWake = (p) => !!(p && p.id && !p.acknowledgedAt && (p.decision === 'wake' || p.decision === 'would-wake'));
  const cases = [
    ['[POS] 新条目 → 视为通路有效', willWake({ id: 'a', decision: 'wake' }) === true],
    ['[POS] dryRun 的 would-wake → 同样视为通路有效', willWake({ id: 'a', decision: 'would-wake' }) === true],
    ['[NEG] 已销账 → 不算', willWake({ id: 'a', decision: 'wake', acknowledgedAt: 'x' }) === false],
    ['[NEG] 缺 id → 不算', willWake({ decision: 'wake' }) === false],
    ['[NEG] null → 不算', willWake(null) === false],
  ];
  const bad = cases.filter((c) => !c[1]).length;
  for (const [l, ok] of cases) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}`);
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}
if (process.argv.includes('--selftest')) selftest();

const modPath = path.join(REPO, 'lib', 'pending-human.mjs');
const indexSrc = fs.existsSync(path.join(REPO, 'lib', 'index.js')) ? fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8') : '';
const selfcheckSrc = fs.existsSync(path.join(REPO, 'lib', 'selfcheck.mjs')) ? fs.readFileSync(path.join(REPO, 'lib', 'selfcheck.mjs'), 'utf8') : '';

// ---- 1) 模块存在且导出齐三个纯函数 ----
let mod = null;
try { mod = await import(pathToFileURL(modPath).href); } catch (e) {
  check('[POS] lib/pending-human.mjs 可导入', false, e.code === 'ERR_MODULE_NOT_FOUND' ? '文件不存在（尚未实现）' : e.message);
}
if (mod) {
  for (const fn of ['parsePendingHuman', 'decidePendingHuman', 'pendingHandoffText']) {
    check(`[POS] 导出纯函数 ${fn}`, typeof mod[fn] === 'function');
  }
}

// ---- 2) 纯函数行为（真调用）----
if (mod && typeof mod.parsePendingHuman === 'function') {
  const good = { id: 'c1|review-needed|-|t', chainId: 'c1', reason: 'review-needed', taskId: 't', detail: 'd', acknowledgedAt: null };
  const p1 = mod.parsePendingHuman(JSON.stringify(good));
  check('[POS] parse：合法条目 → ok=true', p1 && p1.ok === true && p1.entry && p1.entry.id === good.id);
  const p2 = mod.parsePendingHuman('\uFEFF' + JSON.stringify(good));
  check('[POS] parse：带 BOM 也能解析', p2 && p2.ok === true);
  let threw = false; let p3 = null;
  try { p3 = mod.parsePendingHuman('{ not json'); } catch { threw = true; }
  check('[NEG] parse：坏 JSON → ok=false 且不抛', !threw && p3 && p3.ok === false);
  const p4 = mod.parsePendingHuman(JSON.stringify({ reason: 'review-needed' }));
  check('[NEG] parse：缺 id/chainId → ok=false（不能拿半个信号去唤醒）', p4 && p4.ok === false);
  check('[NEG] parse：空字符串 → ok=false', mod.parsePendingHuman('') .ok === false);
}
if (mod && typeof mod.decidePendingHuman === 'function') {
  const base = { id: 'x1', chainId: 'c1', reason: 'review-needed', acknowledgedAt: null };
  const d1 = mod.decidePendingHuman({ ...base }, { notifiedIds: [] });
  check('[POS] decide：新条目 → wake', d1 && d1.decision === 'wake', d1 ? `decision=${d1.decision}` : '');
  const d2 = mod.decidePendingHuman({ ...base, dryRun: true }, { notifiedIds: [] });
  check('[POS] decide：dryRun → would-wake（判定需要唤醒但不真唤醒）', d2 && d2.decision === 'would-wake', d2 ? `decision=${d2.decision}` : '');
  const d3 = mod.decidePendingHuman({ ...base, acknowledgedAt: '2026-01-01T00:00:00Z' }, { notifiedIds: [] });
  check('[NEG] decide：已销账 → none', d3 && d3.decision === 'none', d3 ? `decision=${d3.decision}` : '');
  const d4 = mod.decidePendingHuman({ ...base }, { notifiedIds: ['x1'] });
  check('[NEG] decide：同 id 已通知 → none（去重，防每 15 分钟吵一次）', d4 && d4.decision === 'none', d4 ? `decision=${d4.decision}` : '');
  const d5 = mod.decidePendingHuman(null, { notifiedIds: [] });
  check('[NEG] decide：null 条目 → none（fail-open）', d5 && d5.decision === 'none');
}
if (mod && typeof mod.pendingHandoffText === 'function') {
  const txt = String(mod.pendingHandoffText({ id: 'x', chainId: 'chain-abc', reason: 'too-many-attempts', taskId: 'task-xyz', detail: '细节' }) || '');
  check('[POS] handoff 文本含 chainId 与 reason', txt.includes('chain-abc') && txt.includes('too-many-attempts'), txt.slice(0, 80));
  check('[POS] handoff 文本含 taskId 与处理指引', txt.includes('task-xyz') && /销账|处理|收口|复核/.test(txt));
}

// ---- 2b) 唤醒目标解析（2026-09-18 实测缺口：这台机器的宿主**没有** DSH_SESSION_ID）----
// 插件自己的心跳日志一直在说：「有待办但无 sessionId（expr 未落盘且宿主 env 无 DSH_SESSION_ID），仅记录留痕」
// —— 即：判定成立但**没有唤醒目标**，能力等于只能记录。回退逻辑（最近落盘 expr 的 sessionId）仓库里早就有
// （mostRecentExprSessionId），只是新代码没用它。故要求把解析抽成可注入的纯函数并真的接线。
if (mod && typeof mod.resolveWakeSessionId === 'function') {
  const a = mod.resolveWakeSessionId({ env: 'sess-env', recentExprSessionId: 'sess-recent' });
  check('[POS] 解析：有 env → 用 env', (a && (a.sessionId === 'sess-env' || a === 'sess-env')), JSON.stringify(a));
  const b = mod.resolveWakeSessionId({ env: null, recentExprSessionId: 'sess-recent' });
  check('[POS] 解析：env 缺失 → 回退到最近落盘 expr 的 sessionId（关键缺口）', (b && (b.sessionId === 'sess-recent' || b === 'sess-recent')), JSON.stringify(b));
  const c = mod.resolveWakeSessionId({ env: null, recentExprSessionId: null });
  check('[NEG] 解析：两者都缺 → null（不得凭空造一个目标去唤醒）', (c && (c.sessionId === null || c.sessionId === undefined)) || c === null);
} else if (mod) {
  check('[POS] 导出唤醒目标解析函数 resolveWakeSessionId（env 缺失时回退）', false, '未导出 → 宿主无 DSH_SESSION_ID 时无法唤醒');
}

// ---- 3) 接线与契约（静态但精确）----
check('[POS] index.js 读取信号文件名 chain-needs-human.json', /chain-needs-human/.test(indexSrc));
check('[POS] index.js 暴露 pendingHuman 字段', /pendingHuman/.test(indexSrc));
// 接线：唤醒目标解析必须被真的调用（而不是只 import 了不用），且 pendingHuman 里能看出目标来源
check('[POS] index.js 调用 resolveWakeSessionId（而不是只读 env）', /resolveWakeSessionId/.test(indexSrc));
check('[POS] pendingHuman 暴露 sessionIdSource（便于排查"为什么没唤醒"）', /sessionIdSource/.test(indexSrc));
check('[POS] 心跳入口 /admin/heartbeat-check 的响应带 pendingHuman', /admin\/heartbeat-check[\s\S]{0,600}?pendingHuman/.test(indexSrc) || /pendingHuman[\s\S]{0,600}?admin\/heartbeat-check/.test(indexSrc), '心跳 handler 与其响应体需包含该字段');
check('[POS] boot 路径也判定（与 bootResumeScan 同批次）', /bootResumeScan|resumeScanBases/.test(indexSrc) && /pendingHuman|pending-human/.test(indexSrc));
// [NEG] 路径必须由 CC_TASKS_ROOT 派生，不得硬编码盘符路径（换机器/换根目录就失效）
const hard = [...indexSrc.matchAll(/['"]D:\\\\cc-tasks[^'"]*['"]/g)].map((m) => m[0]);
check('[NEG] 不得硬编码 D:\\cc-tasks 路径（须由 CC_TASKS_ROOT 派生）', hard.length === 0, hard.slice(0, 2).join(', '));
check('[POS] selfcheck 契约含 pendingHuman', /'pendingHuman'/.test(selfcheckSrc));

const pass = results.filter((r) => r.cond).length;
console.log(`\nRESULT: ${pass}/${results.length} → 判定 ${pass === results.length ? 'PASS' : 'FAIL'}`);
process.exit(pass === results.length ? 0 : 1);
