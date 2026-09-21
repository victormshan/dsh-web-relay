// 守望 v9-loadedhash 的第 1 项派发：等 cc 落定 → 立刻跑验收 → 若通过则直接独立重算指纹。
// 用法: node watch-v9-loadedhash.mjs [--minutes 75]
//
// 为什么要守望：本条链条的验收条款**是执行接地**的（acceptanceScript = probes/loaded-hash-accept.mjs），
// 探针在派发前是 3/9 失败（正是本项要修的东西），所以"cc 说 done"完全不能当通过——
// 必须由 verify-cc-task 用同一探针复跑，并且我再独立按算法重算一次指纹做交叉核对。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MINUTES = Number(argOf('--minutes', '75'));
const TASK = 'ccfeat-20260917-loadedhash';
const CC = 'D:\\cc-tasks';
const WORK = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '));
const TASKDIR = path.join(CC, 'tasks', TASK);
const OUT = path.join(WORK, '_v9-watch.md');

const events = [];
const t0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 19);
const rec = (m) => { events.push(`- [${stamp()}] ${m}`); console.log(`  [${stamp()}] ${m}`); };

rec(`开始守望 ${TASK}（窗口 ${MINUTES} 分钟）`);
rec(`派发前基线：探针 = ${probeLine()}｜result.json = ${fs.existsSync(path.join(TASKDIR, 'result.json')) ? '已存在（旧残留？）' : '无'}`);

function probeLine() {
  // 探针接口：node probes/loaded-hash-accept.mjs <taskId>（不给参数是用法错误 exit=2，别把它当成"解析不出"）
  const r = spawnSync(process.execPath, [path.join(WORK, 'probes', 'loaded-hash-accept.mjs'), TASK], { cwd: WORK, encoding: 'utf8' });
  const txt = `${r.stdout || ''}${r.stderr || ''}`.replace(/\s+/g, ' ');
  const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? `${m[1]}/${m[2]}（exit=${r.status}）` : `解析不出（exit=${r.status}）`;
}

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
      // 只有真落定（done.flag + result）才算；cc-watchdog 会先写 out/ 再写 result
      settled = j;
      rec(`cc 落定：status=${j.status} exit=${j.exit ?? '?'} errorCode=${j.errorCode ?? '-'} end=${j.end || '-'}`);
      break;
    } catch { /* result.json 正在写，下一轮再读 */ }
  }
  // 同步睡眠 20s（Atomics.wait 不烧 CPU；不要用忙等）
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
}

if (!settled) {
  rec(`窗口内未落定（dispatched=${dispatched}）→ 需人看 chain.log / cc-watchdog 日志`);
} else {
  rec('跑验收：verify-cc-task.mjs ' + TASK);
  const v = spawnSync(process.execPath, [path.join(WORK, 'verify-cc-task.mjs'), TASK], { cwd: WORK, encoding: 'utf8' });
  const out = `${v.stdout || ''}${v.stderr || ''}`;
  console.log(out);
  const verdict = v.status === 0 ? 'ACCEPT' : v.status === 1 ? 'REJECT' : v.status === 3 ? 'INSTRUMENT-ERROR' : `exit=${v.status}`;
  rec(`验收结论 = ${verdict}`);
  rec(`验收后探针独立复算 = ${probeLine()}`);
  events.push('\n```\n' + out.trim().slice(-4000) + '\n```');
}

const ms = Date.now() - t0;
const md = [`# v9-loadedhash 守望报告`, ``, `- 任务：\`${TASK}\``, `- 耗时：${(ms / 60000).toFixed(1)} 分钟`, ``, ...events, ``].join('\n');
fs.writeFileSync(OUT, md, 'utf8');
console.log(`\n报告 → ${OUT}`);
