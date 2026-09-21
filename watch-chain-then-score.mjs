// 等链条跑完 → 自动做两臂分布比较（一个后台任务闭环，避免我中途误判"跑完了"）
// 用法: node watch-chain-then-score.mjs --chain v6-gen-s26 --expect 26 --minutes 200
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHAIN = argOf('--chain', 'v6-gen-s26');
const EXPECT = Number(argOf('--expect', '26'));
const MINUTES = Number(argOf('--minutes', '200'));
const SCORE = argOf('--score', 'score-genexp-two-arms.mjs');
const STATE = 'D:\\cc-tasks\\chain-state.json';
const LOCK = 'D:\\cc-tasks\\chain.lock';
const OUT = argOf('--out', 'D:\\cc-tasks\\_s26-watch.md');
const DEADLINE = Date.now() + MINUTES * 60000;

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } };
// 进度计数：从**链条定义**里读 taskId（通用；此前写死某一轮的 id 模式，换链条后会显示 0——已修）
const chainTaskIds = (() => {
  try {
    const src = fs.readFileSync(`D:\\dsh relay test\\cc-chains\\${CHAIN}.mjs`, 'utf8');
    return [...src.matchAll(/taskId: '([^']+)'/g)].map((m) => m[1]);
  } catch { return []; }
})();
const doneCount = () => chainTaskIds.filter((id) => fs.existsSync(`D:\\cc-tasks\\tasks\\${id}\\result.json`)).length;

const events = [];
const t0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 19);
const rec = (m) => { events.push(`- [${stamp()}] ${m}`); console.log(`  [${stamp()}] ${m}`); };

rec(`开始观察链条 ${CHAIN}（期望 ${EXPECT} 项，窗口 ${MINUTES} 分钟）`);
let lastDone = -1;
let finished = false;

while (Date.now() < DEADLINE) {
  const s = readState();
  const n = doneCount();
  const locked = fs.existsSync(LOCK);
  if (n !== lastDone) { rec(`已完成复本 ${n}/${EXPECT}（chainId=${s ? s.chainId : '?'} index=${s ? s.index : '?'} 锁=${locked ? '持有' : '释放'}）`); lastDone = n; }
  const chainDone = s && s.chainId === CHAIN && s.index >= EXPECT;
  const chainStalled = s && s.chainId === CHAIN && !locked && n === lastDone && n < EXPECT && Date.now() - t0 > 5 * 60000;
  if (chainDone) { finished = true; rec('链条已达期望项数 → 判定完成'); break; }
  await new Promise((r) => setTimeout(r, 60000));
}

const s = readState();
const n = doneCount();
const lines = [
  `# S 组 26 次重复 — 观察与评分`,
  '',
  `- 链条: ${CHAIN}｜期望 ${EXPECT} 项｜实得复本结果 ${n} 份`,
  `- 终止: ${finished ? '链条完成' : '到达硬截止'}`,
  `- chain-state: ${s ? `chainId=${s.chainId} index=${s.index}` : '(读不到)'}`,
  `- 观察时长: ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`,
  '',
  '## 事件时间线',
  '',
  events.join('\n'),
  '',
  '## 两臂分布比较（自动执行）',
  '',
  '```',
];
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

console.log('\n=== 自动评分 ===');
if (!fs.existsSync(`D:\\dsh relay test\\${SCORE}`)) {
  console.log(`  （评分脚本 ${SCORE} 尚不存在 → 跳过；数据已就绪，可稍后手动运行）`);
  fs.appendFileSync(OUT, `\n（评分脚本 ${SCORE} 尚未就绪，未自动评分）\n`, 'utf8');
} else {
  const r = spawnSync(process.execPath, [SCORE, '--json'], { cwd: 'D:\\dsh relay test', encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  console.log(out);
  fs.appendFileSync(OUT, '```\n' + out + '\n```\n', 'utf8');
}
console.log(`\n  报告已写 ${OUT}`);
