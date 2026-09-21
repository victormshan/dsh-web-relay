// 批量追加 lesson 到 dsh-web-relay/docs/main-agent-lessons.json（保持 2 空格 JSON + LF + 无 BOM）。
// 入参：一个 JSON 文件，内容为 lesson 对象数组。
// 用法：node append-lessons.mjs <lessons.json> [--apply]
import fs from 'node:fs';

const src = process.argv[2];
const apply = process.argv.includes('--apply');
const target = 'D:/dsh-web-relay/docs/main-agent-lessons.json';

const incoming = JSON.parse(fs.readFileSync(src, 'utf8'));
if (!Array.isArray(incoming) || incoming.length === 0) throw new Error('入参必须是 lesson 数组');

const before = fs.readFileSync(target, 'utf8');
const doc = JSON.parse(before);
if (!Array.isArray(doc.lessons)) throw new Error('lessons 字段不是数组');

const added = [];
const skipped = [];
for (const lesson of incoming) {
  if (doc.lessons.some((l) => l.id === lesson.id)) {
    skipped.push(lesson.id);
    continue;
  }
  doc.lessons.push(lesson);
  added.push(lesson.id);
}
doc.meta = { ...doc.meta, updatedAt: new Date().toISOString() };
const after = JSON.stringify(doc, null, 2) + '\n';

console.log(`追加 ${added.length} 条：${added.join(', ') || '(无)'}；跳过已存在 ${skipped.length} 条：${skipped.join(', ') || '(无)'}`);
console.log(`条数 ${doc.lessons.length}；行数 ${before.split('\n').length} -> ${after.split('\n').length}`);

if (!apply) {
  console.log('DRY-RUN（未写入；加 --apply 生效）');
  process.exit(0);
}
fs.writeFileSync(target, after, 'utf8');
console.log('written: ' + target);
