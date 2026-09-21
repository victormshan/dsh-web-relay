// 重启后自动跑「实机探针」并落盘结论（幂等：已有结论就退出）。
// 为什么必须在会话外跑：重启会杀掉本会话的一切子进程，而这条通路（信号 → 唤醒）恰恰要**重启后才生效**。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WORK = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '));
const OUT = path.join(WORK, '_postrestart-pendinghuman.json');
const LOG = path.join(WORK, '_postrestart-pendinghuman.log');
const PROBE = path.join(WORK, 'probes', 'pending-human-accept.mjs');

if (fs.existsSync(OUT)) process.exit(0); // 已采集

const at = new Date().toISOString();
const r = spawnSync(process.execPath, [PROBE], { cwd: WORK, encoding: 'utf8', timeout: 300000 });
const out = `${r.stdout || ''}${r.stderr || ''}`;
const m = out.match(/RESULT:\s*(\d+)\/(\d+)/);
const pass = /判定 PASS/.test(out);
fs.appendFileSync(LOG, `${at} exit=${r.status} ${m ? m[1] + '/' + m[2] : '(无 RESULT)'} pass=${pass}\n`, 'utf8');

// 只在「宿主已经加载了新代码」时才落盘结论：
// ⚠ 初版条件是 `/pendingHuman/.test(out)` —— 但探针**失败时**的输出里也含 "pendingHuman" 字样
//   （例如"心跳后 /health-check 暴露 pendingHuman"），于是重启前的一轮就会写入一份 FAIL 结论并从此不再重试
//   （脚本是幂等的）。改为只在**探针真的读到了该字段**（输出里出现 decision=）时落盘。
const sawField = /decision=/.test(out);
if (r.status === 0 || sawField) {
  fs.writeFileSync(OUT, JSON.stringify({
    at, exit: r.status, ratio: m ? `${m[1]}/${m[2]}` : null, pass, sawField,
    tail: out.trim().split('\n').slice(-14),
  }, null, 2), 'utf8');
}
process.exit(0);
