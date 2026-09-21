// 探针自检：用「已知 bug 版」与「我写的参考修复版」各跑一遍三个探针。
// 要求：bug 版必须 FAIL、参考修复版必须 PASS —— 否则探针无区分力，整轮实验无意义。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MODULES } from '../exec-cases.mjs';

const DIR = 'D:\\dsh relay test\\probes';
// 临时产物放系统临时目录，**不污染工作区**（此前把 _buggy*/_fixed* 写进 probes/ 且不清理）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probeselftest-'));

const FIXED = {
  1: `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function collectChanged(cwd) {
  const out = String(spawnSync('git', ['-C', cwd, 'status', '--porcelain', '-uall'], { encoding: 'utf8' }).stdout || '');
  const res = [];
  for (const raw of out.split('\\n')) {
    const line = raw.replace(/\\r$/, '');
    if (!line.trim()) continue;
    // porcelain v1 格式为 "XY PATH"：**不得先 trim 整行**，否则会删掉状态列的前导空格并把 slice(3) 切进文件名
    const f = line.slice(3).trim();
    if (!f) continue;
    const p = path.join(cwd, f);
    let st = null;
    try { st = fs.statSync(p); } catch { /* 已删除 */ }
    if (!st) { res.push({ file: f, size: 0 }); continue; }
    if (!st.isFile()) continue; // 目录/特殊文件不是"改动文件"
    res.push({ file: f, size: st.size });
  }
  return res;
}
`,
  2: `import fs from 'node:fs';

export function loadChainState({ stateFile, chainId, fsImpl = fs }) {
  let state = fsImpl.existsSync(stateFile) ? JSON.parse(fsImpl.readFileSync(stateFile, 'utf8')) : null;
  if (state && state.chainId && state.chainId !== chainId) state = null; // 换链条 → 重开
  if (!state) state = { chainId, index: 0, items: {} };
  state.chainId = chainId;
  return state;
}

export function isComplete(state, itemCount) {
  return !!state.completedAt && state.index >= itemCount;
}
`,
  3: `export function decideRedispatch({ prev, maxAttempts = 3 }) {
  if (!prev) return 'redispatch';
  if (prev.status === 'quota-paused' || prev.status === 'waiting') return 'redispatch'; // 等待类不计失败
  if (prev.status === 'verify-rejected' || prev.status === 'dispatch-failed') {
    return (prev.failCount || 0) >= maxAttempts ? 'stop' : 'redispatch';
  }
  return 'skip';
}
`,
};

const run = (caseId, file) => {
  const r = spawnSync(process.execPath, [path.join(DIR, 'run-probe.mjs'), String(caseId), file], { encoding: 'utf8' });
  const tail = `${r.stdout || ''}`.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  return { status: r.status, tail: tail.trim() };
};

let bad = 0;
for (const id of [1, 2, 3]) {
  const bugFile = path.join(TMP, `buggy${id}.mjs`);
  const fixFile = path.join(TMP, `fixed${id}.mjs`);
  fs.writeFileSync(bugFile, MODULES[id].buggySource, 'utf8');
  fs.writeFileSync(fixFile, FIXED[id], 'utf8');
  const b = run(id, bugFile);
  const f = run(id, fixFile);
  const okB = b.status !== 0;
  const okF = f.status === 0;
  if (!okB || !okF) bad++;
  console.log(`  案例${id} ${MODULES[id].title}`);
  console.log(`    [NEG] bug 版  → ${okB ? 'PASS（如预期 FAIL）' : 'FAIL（探针没抓到 bug！）'}  ${b.tail.slice(0, 60)}`);
  console.log(`    [POS] 修复版  → ${okF ? 'PASS（如预期通过）' : 'FAIL（探针误杀正确修复！）'}  ${f.tail.slice(0, 60)}`);
}
console.log(`\n  RESULT: ${bad ? 'FAIL（' + bad + ' 例区分力不足）' : 'PASS（三个探针均能区分 bug 与修复）'}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
