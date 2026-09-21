// 通用守望：等某个 cc 任务落定 → 立刻跑独立验收 → 若任务声明了验收探针则再独立复算一次。
// 用法: node watch-cc-task.mjs --task <taskId> [--probe <探针相对路径>] [--minutes 75]
//
// 为什么要守望而不是事后查：cc 的 result.json 是**自报**，本会话已实测它会错
// （2026-09-18：v2-validate-failed 把一份独立验收 8/8、探针 9/9 的合格产物判成失败）。
// 所以必须由独立验收器复跑，且探针要**再独立复算一次**，两手都要。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const TASK = argOf('--task', '');
if (!TASK) { console.error('usage: node watch-cc-task.mjs --task <taskId> [--probe <rel.mjs>] [--minutes 75]'); process.exit(2); }
const PROBE = argOf('--probe', '');
const MINUTES = Number(argOf('--minutes', '75'));
const CC = 'D:\\cc-tasks';
const WORK = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '));
const TASKDIR = path.join(CC, 'tasks', TASK);
const OUT = path.join(WORK, `_watch-${TASK}.md`);

const events = [];
const t0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 19);
const rec = (m) => { events.push(`- [${stamp()}] ${m}`); console.log(`  [${stamp()}] ${m}`); };

function probeLine() {
  if (!PROBE) return '(未指定探针)';
  const r = spawnSync(process.execPath, [path.join(WORK, PROBE), TASK], { cwd: WORK, encoding: 'utf8', timeout: 300000 });
  const txt = `${r.stdout || ''}${r.stderr || ''}`.replace(/\s+/g, ' ');
  const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? `${m[1]}/${m[2]}（exit=${r.status}）` : `解析不出（exit=${r.status}）`;
}

rec(`开始守望 ${TASK}（窗口 ${MINUTES} 分钟）｜探针基线 = ${probeLine()}`);

let dispatched = false;
let settled = null;
const DEADLINE = Date.now() + MINUTES * 60000;
while (Date.now() < DEADLINE) {
  if (!dispatched && fs.existsSync(TASKDIR)) { dispatched = true; rec('cc 已开始执行（任务目录出现）'); }
  const resPath = path.join(TASKDIR, 'result.json');
  const donePath = path.join(TASKDIR, 'done.flag');
  if (fs.existsSync(resPath) && fs.existsSync(donePath)) {
    try {
      const j = JSON.parse(fs.readFileSync(resPath, 'utf8'));
      settled = j;
      rec(`cc 落定：status=${j.status} exit=${j.exit ?? '?'} errorCode=${j.errorCode ?? '-'} end=${j.end || '-'}`);
      break;
    } catch { /* result.json 正在写 */ }
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
}

if (!settled) {
  // 区分"没派发"的原因（2026-09-19 实测：配额耗尽时守望器空等 80 分钟，只报"未落定"，
  // 看不出链条其实每 20 分钟都在按设计暂停、等配额恢复）。
  let why = '原因不明（建议看 chain.log / runner.log）';
  try {
    const st = JSON.parse(fs.readFileSync(path.join(CC, 'chain-state.json'), 'utf8'));
    const item = Object.values(st.items || {}).find((v) => v && v.status);
    if (st.quotaResetsAt) {
      why = `配额耗尽（${st.quotaKind || 'session'}）：预计 ${st.quotaResetsAt} 恢复；届时链路自动继续，无需人干预`;
    } else if (item && item.status === 'quota-paused') {
      why = '配额暂停但未解析出恢复时刻 → 链条每轮会重探';
    } else if (item && item.status === 'paused-too-many-attempts') {
      why = '护栏停止（连续失败达上限）→ 需要人处理（应已写 needs-human 信号）';
    } else if (fs.existsSync(path.join(CC, 'chain.lock'))) {
      why = '链条锁被持有（有链条在跑）';
    }
    if (st.chainId) why += `｜状态归属=${st.chainId} index=${st.index}`;
  } catch { /* 读不到就保持默认说明 */ }
  rec(`窗口内未派发（dispatched=${dispatched}）→ ${why}`);
} else {
  rec('跑独立验收：verify-cc-task.mjs ' + TASK);
  const v = spawnSync(process.execPath, [path.join(WORK, 'verify-cc-task.mjs'), TASK], { cwd: WORK, encoding: 'utf8', timeout: 900000 });
  const out = `${v.stdout || ''}${v.stderr || ''}`;
  console.log(out);
  const verdict = v.status === 0 ? 'ACCEPT' : v.status === 1 ? 'REJECT' : v.status === 3 ? 'INSTRUMENT-ERROR' : `exit=${v.status}`;
  rec(`独立验收结论 = ${verdict}`);
  rec(`验收后探针独立复算 = ${probeLine()}`);
  events.push('\n```\n' + out.trim().slice(-4000) + '\n```');
}

const md = [`# 守望报告：${TASK}`, ``, `- 耗时：${((Date.now() - t0) / 60000).toFixed(1)} 分钟`, ``, ...events, ``].join('\n');
fs.writeFileSync(OUT, md, 'utf8');
console.log(`\n报告 → ${OUT}`);
