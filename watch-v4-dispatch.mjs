// 无人值守派发观察器（只读，不改任何状态）：捕获 07:00（UTC 23:00）后链条是否真的自行派发
//
// 为什么需要它：上一轮只能验证到「派发边界」（额度把真实派发挡在外面）。
// 本观察器在后半夜静默记录每次自动触发的分支与产物，把「机制会触发」升级为「确实自行派发了」的实证。
// 纪律：全程只读 —— 不写 chain-state、不派发、不碰锁。
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const CC = 'D:\\cc-tasks';
const REPO = 'D:\\dsh-web-relay';
const TASK_ID = argOf('--task', 'ccfeat-20260916-chainstats-a');
const WINDOW_MIN = Number(argOf('--minutes', '90'));
const LOG = path.join(CC, 'chain-sched.log');
const STATE = path.join(CC, 'chain-state.json');
const QUEUE_TASK = path.join(CC, 'queue', `${TASK_ID}.task.json`);
const TASK_DIR = path.join(CC, 'tasks', TASK_ID);
const RESULT = path.join(TASK_DIR, 'result.json');
const OUT = path.join(CC, `_chain-watch-${TASK_ID}.md`);
// 硬截止：默认从现在起 90 分钟
const DEADLINE = Date.now() + WINDOW_MIN * 60000;

const events = [];
const t0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 19);
const rec = (msg) => { events.push(`- [${stamp()}] ${msg}`); };

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function head() {
  try { return fs.readFileSync(path.join(REPO, '.git', 'HEAD'), 'utf8').trim().slice(0, 60); } catch { return '(读不到)'; }
}

let lastLogLines = 0;
let lastSig = '';
let lastItemStatus = '';
let dispatched = false;
let finished = false;

function snapshot() {
  const st = readJson(STATE) || {};
  const key = Object.keys(st.items || {})[0];
  const item = key ? st.items[key] : {};
  const result = readJson(RESULT);
  const queued = fs.existsSync(QUEUE_TASK);
  return {
    chainId: st.chainId, index: st.index, itemStatus: item && item.status,
    quotaResetsAt: st.quotaResetsAt, queued, hasResult: !!result,
    resultStatus: result && result.status, resultError: result && result.errorCode,
    head: head(),
  };
}

while (Date.now() < DEADLINE) {
  // 1) 增量读取调度日志
  let lines = [];
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split(/\r?\n/); } catch { /* 日志暂不可读 */ }
  if (lines.length > lastLogLines) {
    // 首轮只回放末尾几行作基线：上一版把**全部历史**当成本窗口事件写进时间线（如实记过的瑕疵），此处修正。
    const from = lastLogLines === 0 ? Math.max(0, lines.length - 8) : lastLogLines;
    if (lastLogLines === 0) rec(`（首轮基线：仅回放日志末尾 ${lines.length - from} 行；更早的历史事件不视为本窗口内发生）`);
    for (const l of lines.slice(from)) {
      if (/run-chain start|run-chain exit|链条 .* 启动|完成，本次跳过|额度不可用|已知额度耗尽|探针确认|派发:|\[queued\]|等待结算|已提交 /.test(l)) {
        rec(`日志: ${l.trim().slice(0, 170)}`);
        if (/派发:|\[queued\]/.test(l)) dispatched = true;
      }
    }
    lastLogLines = lines.length;
  }

  // 2) 状态签名变化
  const s = snapshot();
  const sig = JSON.stringify(s);
  if (sig !== lastSig) {
    rec(`状态: chainId=${s.chainId} index=${s.index} 项=${s.itemStatus} 恢复时刻=${s.quotaResetsAt} 已排队=${s.queued} 有结果=${s.hasResult}${s.hasResult ? ` (status=${s.resultStatus} error=${s.resultError || '-'})` : ''} gitHEAD=${s.head}`);
    lastSig = sig;
  }

  // 3) 终止条件：拿到 result.json（真正派发并结算）即收工
  if (s.hasResult) { finished = true; rec('===== 观察到 result.json：无人值守派发已完成并结算 ====='); break; }
  // 只在**状态发生变化**时记录：上一版每轮轮询都重复打印同一状态（14 次噪声），如实修正。
  if (s.itemStatus && !['quota-paused', 'waiting', undefined].includes(s.itemStatus) && s.itemStatus !== lastItemStatus) {
    rec(`项状态已推进到 ${s.itemStatus}`);
    lastItemStatus = s.itemStatus;
  }

  await new Promise((r) => setTimeout(r, 45000));
}

const s = snapshot();
const budgetMin = ((Date.now() - t0) / 60000).toFixed(1);
const lines = [
  '# v4 链条无人值守派发观察记录',
  '',
  `- 观察窗口：${new Date(t0).toISOString()} → ${new Date().toISOString()}（${budgetMin} 分钟）`,
  `- 终止原因：${finished ? '已观察到 result.json（派发并结算）' : '到达硬截止（未观察到 result.json）'}`,
  `- 是否观察到派发动作：${dispatched ? '是' : '否'}`,
  '',
  '## 终态快照',
  '```json',
  JSON.stringify(s, null, 2),
  '```',
  '',
  '## 事件时间线',
  '',
  events.length ? events.join('\n') : '- （窗口内无关键事件）',
  '',
  '## 判读',
  '',
  finished
    ? '- 结论：链条在**无人工干预**下完成了派发与结算，配额门与探针短路按设计工作。'
    : dispatched
      ? '- 结论：已观察到派发动作，但窗口内未结算（任务可能仍在执行）。'
      : '- 结论：窗口内**未**发生派发。需核查：① 触发器是否按 20 分钟继续触发 ② 额度是否真的在 07:00 恢复（探针输出）③ 短路窗口是否误判。',
  '',
];
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
