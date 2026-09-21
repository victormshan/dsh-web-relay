// 把新增教训的临时分类归入既有分类集合（避免 1-2 条的新分类稀释分组）
// 映射：verification → judgment-heuristic；channel-reliability → engineering-action
import fs from 'node:fs';

const FILE = 'D:\\dsh-web-relay\\docs\\main-agent-lessons.json';
const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const MAP = { verification: 'judgment-heuristic', 'channel-reliability': 'engineering-action' };
const ALLOWED = new Set(['collaboration-rhythm', 'repository-knowledge', 'tooling-trap', 'judgment-heuristic', 'engineering-action']);

let changed = 0;
for (const l of doc.lessons) {
  if (MAP[l.category]) {
    console.log(`  ${l.id}: ${l.category} → ${MAP[l.category]}`);
    l.category = MAP[l.category];
    changed++;
  }
}
for (const l of doc.lessons) {
  if (!ALLOWED.has(l.category)) throw new Error(`仍有未知分类: ${l.id} = ${l.category}`);
}
fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log(`[lessons] 归类 ${changed} 条；全部 ${doc.lessons.length} 条分类均合法`);
