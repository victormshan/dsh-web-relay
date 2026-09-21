// 隐藏探针：对**候选修复源码**做**执行判定**（无模型裁判、无仓库写入）。
// 用法: node probes/run-probe.mjs <caseId> <candidateSourceFile>
// 机制：把候选源码写入临时 .mjs → 动态 import → 跑断言 → 输出 PASS/FAIL（exit 0/1）。
// 探针本身**不下发给 cc**（否则等于泄题）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const CASE = Number(process.argv[2]);
const SRC = process.argv[3];
if (!CASE || !SRC) { console.error('usage: node probes/run-probe.mjs <1|2|3> <candidateSourceFile>'); process.exit(2); }
if (!fs.existsSync(SRC)) { console.error('候选源码不存在: ' + SRC); process.exit(2); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execprobe-'));
const modPath = path.join(tmpDir, 'candidate.mjs');
fs.writeFileSync(modPath, fs.readFileSync(SRC, 'utf8'), 'utf8');

const results = [];
const check = (name, fn) => {
  try { const ok = fn(); results.push({ name, ok: !!ok }); }
  catch (e) { results.push({ name, ok: false, err: String(e && e.message).slice(0, 160) }); }
};

let mod;
try { mod = await import(pathToFileURL(modPath).href); }
catch (e) { console.log(`  [FAIL] 候选源码无法载入/导出缺失: ${String(e.message).slice(0, 200)}`); process.exit(1); }

const mkRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'p@e'); git('config', 'user.name', 'p');
  fs.writeFileSync(path.join(dir, 'tracked.js'), 'x\n', 'utf8');
  git('add', 'tracked.js'); git('commit', '-qm', 'init');
  return { dir, git };
};

if (CASE === 1) {
  check('导出 collectChanged', () => typeof mod.collectChanged === 'function');
  // 场景 A：未跟踪的**目录**（旧实现会 readFileSync 目录 → EISDIR 崩溃）
  const A = mkRepo();
  fs.mkdirSync(path.join(A.dir, 'untracked-dir'));
  fs.writeFileSync(path.join(A.dir, 'untracked-dir', 'inner.txt'), 'hello\n', 'utf8');
  check('未跟踪目录：不抛错', () => { mod.collectChanged(A.dir); return true; });
  check('未跟踪目录：列出内部文件（或至少给出非目录条目）', () => {
    const r = mod.collectChanged(A.dir);
    return r.some((x) => String(x.file).includes('inner.txt') || String(x.file).startsWith('untracked-dir/'));
  });
  check('未跟踪目录：不得把目录本身当作文件返回', () => {
    const r = mod.collectChanged(A.dir);
    return !r.some((x) => String(x.file).replace(/\/$/, '') === 'untracked-dir');
  });
  // 场景 B：已删除的跟踪文件（旧实现 readFileSync 不存在路径 → ENOENT）
  const B = mkRepo();
  fs.rmSync(path.join(B.dir, 'tracked.js'));
  check('已删除文件：不抛错', () => { mod.collectChanged(B.dir); return true; });
  // 场景 C：干净仓库
  const C = mkRepo();
  check('干净仓库：返回空数组', () => Array.isArray(mod.collectChanged(C.dir)) && mod.collectChanged(C.dir).length === 0);
  // 场景 D：正常修改
  const D = mkRepo();
  fs.writeFileSync(path.join(D.dir, 'tracked.js'), 'y\n', 'utf8');
  check('普通修改：能正常返回该文件', () => mod.collectChanged(D.dir).some((x) => String(x.file) === 'tracked.js'));
}

if (CASE === 2) {
  check('导出 loadChainState / isComplete', () => typeof mod.loadChainState === 'function' && typeof mod.isComplete === 'function');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'));
  const f = path.join(dir, 'chain-state.json');
  // 旧链条：已完成、index=5（项数 5）
  fs.writeFileSync(f, JSON.stringify({ chainId: 'old-chain', index: 5, items: { a: {}, b: {} }, completedAt: '2026-01-01T00:00:00Z' }), 'utf8');
  check('换链条：index 必须重置为 0', () => mod.loadChainState({ stateFile: f, chainId: 'new-chain' }).index === 0);
  check('换链条：不得继承 completedAt', () => !mod.loadChainState({ stateFile: f, chainId: 'new-chain' }).completedAt);
  check('换链条：chainId 为新链条', () => mod.loadChainState({ stateFile: f, chainId: 'new-chain' }).chainId === 'new-chain');
  check('换链条后 isComplete(1) 必须为 false（否则永不派发）', () => mod.isComplete(mod.loadChainState({ stateFile: f, chainId: 'new-chain' }), 1) === false);
  // 同链条：必须保留进度（不能为了修 bug 而每次都重置）
  const f2 = path.join(dir, 'same.json');
  fs.writeFileSync(f2, JSON.stringify({ chainId: 'same-chain', index: 2, items: {}, completedAt: null }), 'utf8');
  check('同链条：必须保留 index 进度（不得无脑重置）', () => mod.loadChainState({ stateFile: f2, chainId: 'same-chain' }).index === 2);
  // 不存在文件：初始化
  check('状态文件不存在：初始化为 index=0', () => mod.loadChainState({ stateFile: path.join(dir, 'none.json'), chainId: 'x' }).index === 0);
}

if (CASE === 3) {
  check('导出 decideRedispatch', () => typeof mod.decideRedispatch === 'function');
  check('首次（prev=null）→ redispatch', () => mod.decideRedispatch({ prev: null }) === 'redispatch');
  check('已完成（status=accepted）→ skip', () => mod.decideRedispatch({ prev: { status: 'accepted-awaiting-review' } }) === 'skip');
  // 核心：持续失败必须有终止条件
  // ★ v2 公平性修复：带 bug 源码的注释只说明 prev 形如 { status, at }，**未定义任何重试计数字段**。
  //   v1 探针只喂 failCount（我参考实现的私有取名），等于逼候选猜我的字段名 → 两臂全员 0/8，是**无效测量**。
  //   现同时喂多个常见别名，并允许模块内部自计数（同一模块实例跨 12 次调用，内部状态可保留）。
  const mkPrev = (status, n) => ({ status, attempts: n, failCount: n, failures: n, retryCount: n });
  const sim = () => {
    let prev = null; const decisions = [];
    for (let i = 0; i < 12; i++) {
      const d = mod.decideRedispatch({ prev, maxAttempts: 3, attempts: prev ? prev.attempts : 0 });
      decisions.push(d);
      if (d === 'stop') break;
      if (d === 'redispatch') prev = mkPrev('verify-rejected', (prev?.attempts || 0) + 1);
      else prev = { ...(prev || mkPrev('waiting', 0)), status: 'waiting' };
    }
    return decisions;
  };
  let decisions = [];
  check('持续失败：12 轮内必须出现 stop（不得无限 redispatch）', () => { decisions = sim(); return decisions.includes('stop'); });
  check('持续失败：redispatch 次数不得超过 maxAttempts+1', () => decisions.filter((d) => d === 'redispatch').length <= 4);
  // 非缺陷暂停（额度耗尽）不应被当作失败计数而耗尽上限
  check('额度暂停不应触发 stop（它是等待而非缺陷）', () => {
    let prev = null;
    for (let i = 0; i < 6; i++) {
      const d = mod.decideRedispatch({ prev, maxAttempts: 3, attempts: prev ? prev.attempts : 0 });
      if (d === 'stop') return false;
      prev = { ...mkPrev('quota-paused', prev?.attempts || 0) };
    }
    return true;
  });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name}${r.err ? ' — ' + r.err : ''}`);
console.log(`  RESULT: ${results.length - failed.length}/${results.length}${failed.length ? ' → 判定 FAIL' : ' → 判定 PASS'}`);
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
