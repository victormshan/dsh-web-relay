// 验收探针：「需要人介入」信号 → 插件唤醒主 agent 的**端到端**通路（不是读代码，是真打端点）。
//
// 背景（2026-09-18 实测缺口）：v11 因护栏 `已连续失败 3 次 → 停止链条并等人处理` 停住后，
// **没有任何机制叫醒主 agent**；现有两条续跑机制（boot 事件 + 15 分钟心跳）只续 web-relay/experiments 里"忙"的计划步，
// 表达不了"链条停下等人"。本探针验证补齐后的通路：
//   链条侧写 <cc-tasks>/chain-needs-human.json → 插件在 boot/心跳时读到 → 去重后唤醒主 agent → /health-check 可观测。
//
// 断言（都要可复跑）：
//   [POS] POST /admin/heartbeat 后，/health-check 暴露 pendingHuman 且其 id 等于夹具的 id
//   [POS] dryRun 夹具不得真的唤醒（探针不能顺手打断主 agent —— 有副作用的东西必须能空跑）
//   [NEG] 同一条目第二次心跳**不得**再次唤醒（去重；否则每 15 分钟吵一次）
//   [NEG] 已销账（acknowledgedAt 非空）的条目不得唤醒
//   [NEG] 坏 JSON / 缺字段 → 不得唤醒，且不得让心跳/启动路径异常（fail-open）
//   [POS] pendingHuman 已纳入自检契约（装一半会被重启自检抓出）
//   [NEG] 移除夹具后必须回到"无待办"（否则一次假信号会永久污染）
//
// 用法: node probes/pending-human-accept.mjs [taskId]
//       node probes/pending-human-accept.mjs --selftest
import fs from 'node:fs';
import path from 'node:path';

const CC = 'D:\\cc-tasks';
const SIGNAL = path.join(CC, 'chain-needs-human.json');
const HEALTH = 'http://127.0.0.1:3080/dsh-web-relay/health-check';
const HEARTBEAT = 'http://127.0.0.1:3080/dsh-web-relay/admin/heartbeat-check';
const REPO = 'D:\\dsh-web-relay';

const j = async (url, opt) => {
  const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(15000) });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: null, text: t.slice(0, 300) }; }
};
const health = async () => (await j(HEALTH)).body || {};
const beat = async () => await j(HEARTBEAT, { method: 'POST' });

const results = [];
const check = (label, cond, detail = '') => { results.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };

if (process.argv.includes('--selftest')) {
  // 分类器自检：给定 pendingHuman 形状，判定它是否"表示需要唤醒"
  const willWake = (p) => !!(p && p.id && !p.acknowledgedAt && (p.decision === 'wake' || p.decision === 'would-wake'));
  const cases = [
    ['[POS] 新条目 → 判为需要唤醒', willWake({ id: 'x|review-needed|-|t', decision: 'wake' }) === true],
    ['[POS] dryRun 判定 would-wake 也算"通路有效"', willWake({ id: 'x', decision: 'would-wake' }) === true],
    ['[NEG] 已销账 → 不算需要唤醒', willWake({ id: 'x', decision: 'wake', acknowledgedAt: '2026-01-01' }) === false],
    ['[NEG] 无 id → 不算（不能拿半个信号唤醒）', willWake({ decision: 'wake' }) === false],
    ['[NEG] 字段缺失 → 不算（fail-open 视为无待办）', willWake(null) === false],
    ['[NEG] 只有 heartbeat 无 pendingHuman（未接线）→ 不算', willWake(undefined) === false],
  ];
  const bad = cases.filter((c) => !c[1]);
  for (const [l, ok] of cases) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}`);
  console.log(`\nRESULT: ${cases.length - bad.length}/${cases.length} ${bad.length ? 'FAIL' : 'PASS'}`);
  process.exit(bad.length ? 1 : 0);
}

// ---- 真跑 ----
const backup = fs.existsSync(SIGNAL) ? fs.readFileSync(SIGNAL, 'utf8') : null;
const restore = () => {
  try {
    if (backup === null) fs.rmSync(SIGNAL, { force: true });
    else fs.writeFileSync(SIGNAL, backup, 'utf8');
  } catch { /* 尽力还原 */ }
};
const probeId = `__acceptance-probe__|review-needed|-|${new Date().toISOString()}`;
const fixture = {
  id: probeId, chainId: '__acceptance-probe__', reason: 'review-needed', taskId: null,
  detail: '验收探针夹具（dryRun，不真的唤醒主 agent）', lastVerdict: null, attempts: null,
  at: new Date().toISOString(), acknowledgedAt: null, ackNote: null, dryRun: true,
};

try {
  // [POS] 夹具写入 + 心跳 → 应产生 pendingHuman 判定，且 id 是夹具的
  fs.writeFileSync(SIGNAL, JSON.stringify(fixture, null, 2), 'utf8');
  const b1 = await beat();
  const h1 = await health();
  const p1 = h1.pendingHuman || (b1.body && b1.body.pendingHuman) || null;
  check('[POS] 心跳后 /health-check 暴露 pendingHuman', !!p1, p1 ? `decision=${p1.decision} id=${String(p1.id).slice(0, 40)}` : '(无该字段——未接线或未交付重启)');
  check('[POS] pendingHuman 指向我们的夹具（通路真的读到了文件）', !!p1 && String(p1.id || '') === probeId, p1 ? `id=${String(p1.id).slice(0, 50)}` : '');
  check('[POS] dryRun 夹具不得真的唤醒（探针不能打断主 agent）', !p1 || p1.actuallyWoken !== true, p1 ? `actuallyWoken=${p1.actuallyWoken}` : '');

  // [NEG] 第二次心跳：同一条目不得重复唤醒（去重）
  const b2 = await beat();
  const h2 = await health();
  const p2 = h2.pendingHuman || (b2.body && b2.body.pendingHuman) || null;
  check('[NEG] 同一条目第二次心跳不得再次唤醒（去重）', !p2 || p2.decision !== 'wake' || p2.duplicateSuppressed === true || p2.actuallyWoken !== true,
    p2 ? `decision=${p2.decision} duplicateSuppressed=${p2.duplicateSuppressed}` : '');

  // [NEG] 已销账条目不得唤醒
  fs.writeFileSync(SIGNAL, JSON.stringify({ ...fixture, id: probeId + '|acked', acknowledgedAt: new Date().toISOString() }, null, 2), 'utf8');
  const b3 = await beat();
  const h3 = await health();
  const p3 = h3.pendingHuman || (b3.body && b3.body.pendingHuman) || null;
  check('[NEG] 已销账条目不得唤醒', !p3 || p3.decision === 'none' || p3.actuallyWoken !== true, p3 ? `decision=${p3.decision}` : '(无 pendingHuman=视为无待办)');

  // [NEG] 坏 JSON → 不唤醒且心跳不报错（fail-open）
  fs.writeFileSync(SIGNAL, '{ this is not json', 'utf8');
  const b4 = await beat();
  check('[NEG] 坏 JSON 不得让心跳失败（fail-open）', b4.status === 200 && b4.body && b4.body.ok === true, `HTTP ${b4.status}`);
  const h4 = await health();
  check('[NEG] 坏 JSON 时不得唤醒（ok:false 视为无待办）', !(h4.pendingHuman && h4.pendingHuman.actuallyWoken === true));

  // [POS] 契约：pendingHuman 纳入自检契约（装一半会被重启自检抓出）
  const sc = fs.existsSync(path.join(REPO, 'lib', 'selfcheck.mjs')) ? fs.readFileSync(path.join(REPO, 'lib', 'selfcheck.mjs'), 'utf8') : '';
  check('[POS] pendingHuman 已纳入 SELFCHECK_REQUIRED_HEALTH_FIELDS', /'pendingHuman'/.test(sc));
  const ix = fs.existsSync(path.join(REPO, 'lib', 'index.js')) ? fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8') : '';
  check('[POS] boot 路径与心跳路径都接了该信号', /chain-needs-human/.test(ix) && /pendingHuman/.test(ix));
} finally {
  restore();
  try {
    await beat(); // 让插件把状态收敛回"无待办"
  } catch { /* 忽略 */ }
  const h = await health().catch(() => ({}));
  const p = h.pendingHuman || null;
  check('[NEG] 移除夹具后回到"无待办"（防一次假信号永久污染）', !p || String(p.id || '') !== probeId, p ? `id=${String(p.id).slice(0, 40)}` : '(无)');
}

const pass = results.filter((r) => r.cond).length;
console.log(`\nRESULT: ${pass}/${results.length} → 判定 ${pass === results.length ? 'PASS' : 'FAIL'}`);
process.exit(pass === results.length ? 0 : 1);
