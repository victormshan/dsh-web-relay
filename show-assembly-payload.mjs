// 零副作用复现「主 agent 能力注入」的载荷：
//   payload = handoffText + MAIN_AGENT_ASSEMBLY(REPO_ROOT 解析) + lesson Top-K(真实模块)
// 与 dsh-web-relay/lib/index.js L1714-1735 的实现逐字一致（那里是 apply 内部函数，未导出）。
// 用法: node show-assembly-payload.mjs [REPO_ROOT] [handoffText]
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const RUNTIME = 'C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-web-relay';
const { loadLessonsFile, topLessonsForTrigger, renderLessonBlock } = await import(
  pathToFileURL(`${RUNTIME}/lib/lessons-inject.js`).href
);

const REPO_ROOT = (process.argv[2] ?? 'D:/dsh-web-relay').replace(/[\\/]$/, '');
const handoff =
  process.argv[3] ??
  [
    '【主 agent 请协助】dsh-web-relay 试验记录 expr-2026-09-13_20-00-00',
    '【跨工作区上下文桥接】',
    'workspacePath: D:\\dsh relay test',
    '宿主换线后手机浏览器打开 GUI 一片空白，怀疑缓存',
  ].join('\n');

const rel = (...parts) => path.join(REPO_ROOT, ...parts);
const MAIN_AGENT_ASSEMBLY = [
  '',
  '【主 agent 装配】请先阅读以下持久化能力文件：',
  `- 执行手册: ${rel('docs', 'main-agent-runbook-v0.1.md')}`,
  `- 能力索引: ${rel('docs', 'capabilities', 'registry.yaml')}`,
  `- 自动迭代建模: ${rel('skills', 'auto-iteration-modeling', 'SKILL.md')}`,
  `- 工具排障: ${rel('skills', 'agent-tool-troubleshooting', 'SKILL.md')}`,
  `- 主 agent Skill: ${rel('skills', 'dsh-web-relay-main-agent', 'SKILL.md')}`,
].join('\n');

const lessons = loadLessonsFile(`${RUNTIME}/docs/main-agent-lessons.json`);
const top = topLessonsForTrigger(lessons, handoff) ?? [];
const lessonBlock = renderLessonBlock(top) ?? '';
const payload = handoff + '\n' + MAIN_AGENT_ASSEMBLY + lessonBlock;

console.log('REPO_ROOT =', REPO_ROOT);
console.log('lessons   =', lessons.length, '条；Top-K =', top.map((l) => l.id).join(', '));
console.log('载荷字节  =', Buffer.byteLength(payload, 'utf8'));

const paths = [
  rel('docs', 'main-agent-runbook-v0.1.md'),
  rel('docs', 'capabilities', 'registry.yaml'),
  rel('skills', 'auto-iteration-modeling', 'SKILL.md'),
  rel('skills', 'agent-tool-troubleshooting', 'SKILL.md'),
  rel('skills', 'dsh-web-relay-main-agent', 'SKILL.md'),
];
console.log('--- 装配清单路径可解析性 ---');
let ok = 0;
for (const p of paths) {
  const e = fs.existsSync(p);
  if (e) ok++;
  console.log(`  ${e ? 'OK  ' : 'MISS'} ${p}`);
}
console.log(`  可解析 ${ok}/${paths.length}`);

console.log('\n================ 会被注入的原文 ================');
console.log(payload);
console.log('================ 载荷结束 ================');
