// 乐观检测（optimistic guard）：在**覆写前**发现"工作树已不是我记得的样子"。
//
// 语义边界（必须说准，否则会被误用）：
//   · 它**不是**"谁改了我的文件"的探测器——无法区分"我改的"与"别人改的"；
//   · 它是**乐观并发**：`--record` 记下当时的指纹，`--check` 在覆写/提交/交付/重启前重算并比对；
//     不一致 → **停下、列出变化、要求重读**，而不是盲目盖上去。
//   · 它**不能**拦截任意的 Edit/Write 工具调用（那不在代码里，拦不住）；能保护的是**我方代码路径**
//     （commit / 交付 / 重启 / 派发 / 大改之前的自检），这也是它能覆盖的全部范围——如实写在 runbook。
//
// 为什么需要：系统默认"唯一权威工作树"，而 2026-09-20 实测打破过这个前提（GUI 刷新后两个会话同时活着），
// 且单写者锁只覆盖 信号/交付/重启 三类写入，**普通文件编辑与 git commit 没有锁**。
//
// 用法:
//   node optimistic-guard.mjs --record <name>          # 开工前记指纹（repo + 工作区工具链）
//   node optimistic-guard.mjs --check  <name>          # 覆写前检查（exit 1 = 已变动，需重读）
//   node optimistic-guard.mjs --show   <name>
//   node optimistic-guard.mjs --selftest               # 两侧自检（含"合成变动必须被抓到"负控）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REPO = 'D:\\dsh-web-relay';
export const WORK = 'D:\\dsh relay test';
export const GUARD_DIR = 'D:\\cc-tasks\\.guards';

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const t = (s) => { const v = Date.parse(s); return Number.isFinite(v) ? v : null; };

/** repo 指纹：HEAD + 工作树状态（含未跟踪）。谁动了仓库、或 HEAD 变了，都会变。 */
export function fingerprintRepo(repo = REPO) {
  const run = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30000 });
  const head = String((run(['rev-parse', 'HEAD']).stdout || '').trim());
  const status = String(run(['status', '--porcelain=v1', '--untracked-files=all']).stdout || '');
  const lines = status.split('\n').filter(Boolean);
  return { scope: 'repo', path: repo, head, statusHash: sha(status), dirtyCount: lines.length, sample: lines.slice(0, 5) };
}

/** 工作区**活工具链**指纹：根目录 *.mjs（排除 `_` 前缀与 `.bak`）+ probes/*.mjs。只读、不碰大目录。 */
export function fingerprintWorkspace(dir = WORK) {
  const collect = (d, prefix = '') => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return []; }
    return names
      .filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && !f.includes('.bak'))
      .sort()
      .map((f) => `${prefix}${f}`);
  };
  const rels = [...collect(dir), ...collect(path.join(dir, 'probes'), 'probes/')];
  const parts = [];
  for (const rel of rels) {
    try { parts.push(`${rel}:${sha(fs.readFileSync(path.join(dir, rel.split('/').join(path.sep)), 'utf8'))}`); } catch { /* 跳过不可读 */ }
  }
  return { scope: 'workspace', path: dir, files: rels.length, filesHash: sha(parts.join('\n')), sample: rels.slice(0, 5) };
}

export function snapshot({ repo = REPO, work = WORK } = {}) {
  return { at: new Date().toISOString(), repo: fingerprintRepo(repo), workspace: fingerprintWorkspace(work) };
}

const guardPath = (name) => path.join(GUARD_DIR, `${String(name).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
export function recordGuard(name, opts = {}) {
  fs.mkdirSync(GUARD_DIR, { recursive: true });
  const snap = snapshot(opts);
  fs.writeFileSync(guardPath(name), JSON.stringify({ name, ...snap }, null, 2), 'utf8');
  const back = JSON.parse(fs.readFileSync(guardPath(name), 'utf8'));
  if (!back.repo || !back.workspace) throw new Error('recordGuard: 回读不一致（工具错误）');
  return back;
}
export function readGuard(name) {
  try { return JSON.parse(fs.readFileSync(guardPath(name), 'utf8')); } catch { return null; }
}

/** 纯函数：比较两次快照。返回 {ok, changes[]}。只依赖结构性事实（哈希/HEAD/计数），不编码瞬时状态。 */
export function diffSnapshots(before, after) {
  const changes = [];
  if (!before || !after) return { ok: false, changes: ['快照缺失（无法比较）'] };
  if (before.repo && after.repo) {
    if (before.repo.head !== after.repo.head) changes.push(`repo HEAD ${String(before.repo.head).slice(0, 8)} → ${String(after.repo.head).slice(0, 8)}（有人提交/切分支了）`);
    if (before.repo.statusHash !== after.repo.statusHash) changes.push(`repo 工作树状态变化（脏文件 ${before.repo.dirtyCount} → ${after.repo.dirtyCount}）`);
  }
  if (before.workspace && after.workspace) {
    if (before.workspace.filesHash !== after.workspace.filesHash) changes.push(`工作区活工具链内容变化（文件数 ${before.workspace.files} → ${after.workspace.files}）`);
  }
  return { ok: changes.length === 0, changes };
}

/** 复用门（供 deliver / restart 等工具调用）：返回 {ok, exit, message}，**不抛异常**便于 CLI 直接透传退出码。
 *  语义：无记录 → 4 未验证（**不得**当成"没变"）；已变动 → 1（拒绝继续）；未变动 → 0。 */
export function guardGate(name, opts = {}) {
  const g = readGuard(name);
  if (!g) return { ok: false, exit: 4, message: `[guard] 无记录「${name}」→ 未验证（不得当成"没变"）。先跑 --record ${name}。` };
  const d = diffSnapshots(g, snapshot(opts));
  if (d.ok) return { ok: true, exit: 0, message: `[guard] 「${name}」自 ${g.at} 以来**未变动**（repo HEAD=${String(g.repo.head).slice(0, 8)}，脏 ${g.repo.dirtyCount}；工作区 ${g.workspace.files} 文件）→ 放行。` };
  return { ok: false, exit: 1, message: `[guard] 「${name}」自 ${g.at} 以来**已变动** → 拒绝继续（覆写/交付/重启前请重读）：\n  · ${d.changes.join('\n  · ')}` };
}

if (process.argv.includes('--selftest')) {
  const cases = [];
  const ck = (label, cond, detail = '') => { cases.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };
  const A = { repo: { head: 'aaa', statusHash: 'h1', dirtyCount: 1 }, workspace: { filesHash: 'w1', files: 10 } };
  ck('[POS] 完全相同 → 通过（不制造假告警）', diffSnapshots(A, JSON.parse(JSON.stringify(A))).ok === true);
  ck('[NEG] HEAD 变了 → 抓（有人提交/切分支）', diffSnapshots(A, { ...A, repo: { ...A.repo, head: 'bbb' } }).changes.some((c) => /HEAD/.test(c)));
  ck('[NEG] 工作树脏文件变了 → 抓（有人改了仓库）', diffSnapshots(A, { ...A, repo: { ...A.repo, statusHash: 'h2', dirtyCount: 3 } }).changes.some((c) => /工作树状态变化/.test(c)));
  ck('[NEG] 工作区工具链内容变了 → 抓（有人改了我方脚本）', diffSnapshots(A, { ...A, workspace: { ...A.workspace, filesHash: 'w2' } }).changes.some((c) => /活工具链内容变化/.test(c)));
  ck('[NEG] 缺快照 → 不通过（不得当成"没变"）', diffSnapshots(null, A).ok === false && diffSnapshots(A, null).ok === false);
  // 端到端（临时目录，绝不碰真仓库/工作区）
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-e2e-'));
  fs.mkdirSync(path.join(tmp, 'probes'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'live-tool.mjs'), 'export const x = 1\n', 'utf8');
  const rec = { at: new Date().toISOString(), repo: fingerprintRepo('D:\\dsh-web-relay'), workspace: fingerprintWorkspace(tmp) };
  const same = { at: new Date().toISOString(), repo: rec.repo, workspace: fingerprintWorkspace(tmp) };
  ck('[POS] 端到端：未改动 → 一致', diffSnapshots(rec, same).ok === true);
  fs.writeFileSync(path.join(tmp, 'live-tool.mjs'), 'export const x = 2   // 被别人改了\n', 'utf8');
  const after = { at: new Date().toISOString(), repo: rec.repo, workspace: fingerprintWorkspace(tmp) };
  const d = diffSnapshots(rec, after);
  ck('[NEG] 端到端：合成改动**必须被抓到**（证明不是永真）', d.ok === false && d.changes.some((c) => /活工具链/.test(c)), d.changes.join('；'));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  const bad = cases.filter((c) => !c.cond).length;
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

// ---------------- CLI ----------------
// ⚠ isMain 守卫（2026-09-20 实测补）：本模块被 **import** 时（deliver/restart/接线探针都要用它）绝不能再执行 CLI 尾部。
//   初版没有这道守卫 → verify-guard-wiring.mjs 一 import 就被打印"用法"并以 exit 3 结束（跑都没跑起来）。
//   这与本会话早先 cc-chain.mjs"import 即跑整条链"是同一类缺陷；凡"既可 CLI 又可被 import"的模块都必须有守卫。
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) { /* 被 import：只暴露 API，不执行 CLI */ } else {
const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const name = argOf('--record') || argOf('--check') || argOf('--show');
if (!name) { console.log('用法: --record <name> | --check <name> | --show <name> | --selftest'); process.exit(3); }

if (argv.includes('--record')) {
  const g = recordGuard(name);
  console.log(JSON.stringify({ ok: true, name, at: g.at, repo: { head: String(g.repo.head).slice(0, 8), dirty: g.repo.dirtyCount }, workspace: { files: g.workspace.files, hash: g.workspace.filesHash } }, null, 1));
  process.exit(0);
}
if (argv.includes('--show')) {
  const g = readGuard(name);
  console.log(g ? JSON.stringify(g, null, 2) : `(无 guard: ${name})`);
  process.exit(g ? 0 : 4);
}
// --check
const g = readGuard(name);
if (!g) { console.log(`[guard] 无记录「${name}」→ 未验证（不得当成"没变"）。先 --record。`); process.exit(4); }
const d = diffSnapshots(g, snapshot());
if (d.ok) {
  console.log(`[guard] 「${name}」自 ${g.at} 以来**未变动**（repo HEAD=${String(g.repo.head).slice(0, 8)}，脏 ${g.repo.dirtyCount}；工作区 ${g.workspace.files} 文件）→ 可安全覆写/提交。`);
  process.exit(0);
}
console.log(`[guard] 「${name}」自 ${g.at} 以来**已变动** → 覆写前请重读，不要盲目盖上去：`);
for (const c of d.changes) console.log(`  · ${c}`);
console.log('  注：本工具无法区分"我改的"与"别人改的"——它只说"世界变了"。');
process.exit(1);
}
