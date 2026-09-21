// 验证 relay 的「主 agent 装配 + lesson Top-K」注入链在运行时副本上真的能跑通。
// 用法：node test-assembly-chain.mjs
import { pathToFileURL } from 'node:url';

const RUN = 'C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-web-relay';
const mod = await import(pathToFileURL(`${RUN}/lib/lessons-inject.js`).href);
const { loadLessonsFile, topLessonsForTrigger, renderLessonBlock } = mod;

const lessons = loadLessonsFile(`${RUN}/docs/main-agent-lessons.json`);
console.log('lessons 载入条数 =', Array.isArray(lessons) ? lessons.length : typeof lessons);

const samples = [
  '宿主换线后手机浏览器打开 GUI 一片空白，怀疑缓存',
  '宿主重启续跑唤醒主 agent 接管后续工作',
  'dsh 升级后插件 pending waiting for service apiProxy',
];

for (const text of samples) {
  const top = topLessonsForTrigger(lessons, text) ?? [];
  const ids = top.map((l) => l.id);
  console.log(`\nhandoff 片段: ${text}`);
  console.log(`  Top-K: ${ids.length ? ids.join(', ') : '(无匹配)'}`);
  const block = renderLessonBlock(top) ?? '';
  console.log(`  renderLessonBlock 长度 = ${block.length}`);
  if (block) console.log('  首行: ' + block.split('\n').find((l) => l.trim()).slice(0, 120));
}
