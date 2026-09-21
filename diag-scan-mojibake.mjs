// 扫描工作区里的乱码源文件：判定标准 = 该行含 ≥2 个 Latin-1 高位字符，且按 latin1 还原后出现 CJK
import fs from 'node:fs';
import path from 'node:path';

const roots = [String.raw`D:\dsh relay test`, String.raw`D:\cc-tasks`];
const skip = new Set(['node_modules', '.git', 'out', 'tasks', 'queue']);
const exts = new Set(['.json', '.mjs', '.js', '.md', '.txt', '.yml', '.yaml']);

function isMojibakeLine(line) {
  const hi = (line.match(/[\u00c0-\u00ff]/g) || []).length;
  if (hi < 2) return false;
  try {
    const back = Buffer.from(line, 'latin1').toString('utf8');
    return /[\u4e00-\u9fff]/.test(back);
  } catch { return false; }
}

const hits = [];
function walk(dir, depth = 0) {
  if (depth > 4) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    if (!exts.has(path.extname(e.name).toLowerCase())) continue;
    let txt;
    try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const lines = txt.split('\n');
    const bad = lines.filter(isMojibakeLine);
    if (bad.length) {
      hits.push({ p, n: bad.length, mtime: fs.statSync(p).mtime.toISOString(), sample: bad[0].trim().slice(0, 90) });
    }
  }
}
for (const r of roots) walk(r);

hits.sort((a, b) => b.n - a.n);
console.log(`=== 乱码文件 ${hits.length} 个（按乱码行数降序）===`);
for (const h of hits.slice(0, 20)) {
  console.log(`  ${h.n} 行  ${h.p}`);
  console.log(`        mtime=${h.mtime}`);
  console.log(`        ${JSON.stringify(h.sample)}`);
}
if (!hits.length) console.log('  （未发现）');
