// 通用双重编码解码器：node decode-file.mjs <path> [--write]
// 打印（可选写回）把 UTF-8-被当-latin1 的文件还原为正常文本的结果
import fs from 'node:fs';

const p = process.argv[2];
const doWrite = process.argv.includes('--write');
if (!p) { console.error('usage: node decode-file.mjs <path> [--write]'); process.exit(2); }

const raw = fs.readFileSync(p, 'utf8');
const countCjk = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;
const countHi = (s) => (s.match(/[\u00c0-\u00ff\u0080-\u00bf]/g) || []).length;

let out;
if (p.trim().endsWith('.json')) {
  const j = JSON.parse(raw);
  const dec = (s) => {
    if (typeof s !== 'string' || countHi(s) < 2) return s;
    let back; try { back = Buffer.from(s, 'latin1').toString('utf8'); } catch { return s; }
    if (back.includes('\ufffd')) return s;
    return countCjk(back) > countCjk(s) ? back : s;
  };
  const walk = (v) => (Array.isArray(v) ? v.map(walk) : (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : dec(v)));
  out = JSON.stringify(walk(j), null, 2);
} else {
  out = Buffer.from(raw, 'latin1').toString('utf8');
}

console.log(`=== ${p} ===`);
console.log(out.slice(0, 3000));
if (doWrite) { fs.writeFileSync(p + '.decoded', out, 'utf8'); console.log(`\n已写出 ${p}.decoded`); }
