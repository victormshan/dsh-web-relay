// Append a UTF-8 markdown fragment to a file (ASCII-only source: no Chinese literals in code).
// Usage: node append-md.mjs <fragment> <target>
import fs from 'node:fs';
const [, , src, dst] = process.argv;
if (!src || !dst) { console.error('usage: node append-md.mjs <fragment> <target>'); process.exit(2); }
const frag = fs.readFileSync(src, 'utf8');
const before = fs.statSync(dst).size;
fs.appendFileSync(dst, '\n' + frag.replace(/\s*$/, '') + '\n', 'utf8');
const after = fs.statSync(dst).size;
console.log(`appended ${after - before} bytes: ${before} -> ${after}`);
