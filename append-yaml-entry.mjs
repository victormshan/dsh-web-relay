// 把一段 YAML 条目以 LF 追加到目标文件（避免 PowerShell here-string 引入 CRLF/BOM）。
// 用法: node append-yaml-entry.mjs <entry文件> <目标yaml>
import fs from 'node:fs';

const [entryFile, target] = process.argv.slice(2);
if (!entryFile || !target) {
  console.error('usage: node append-yaml-entry.mjs <entryFile> <targetYaml>');
  process.exit(2);
}

let cur = fs.readFileSync(target, 'utf8');
const entry = fs.readFileSync(entryFile, 'utf8');

if (!cur.endsWith('\n')) cur += '\n';
if (!cur.endsWith('\n\n')) cur += '\n';

fs.writeFileSync(target, cur + entry, 'utf8');

const crlf = (cur + entry).includes('\r\n');
console.log(`appended ${entry.length} chars -> ${target} | trailing LF ok=${(cur + entry).endsWith('\n')} | crlf=${crlf}`);
