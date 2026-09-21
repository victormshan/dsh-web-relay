// 扫描：steps.json 编码损坏范围 + 运行副本的请求体解码方式
import fs from 'node:fs';
import path from 'node:path';

const dir = String.raw`D:\dsh relay test\web-relay\experiments`;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.steps.json'));
console.log(`=== steps.json 共 ${files.length} 份，逐份检测双重编码 ===`);

let bad = 0; let good = 0; const badList = [];
for (const f of files) {
  const p = path.join(dir, f);
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
  const titles = (j.steps || []).map((s) => String(s.title || ''));
  const cjk = /[\u4e00-\u9fff]/;
  const suspicious = titles.some((t) => !cjk.test(t) && /[\u00c0-\u00ff]{2,}/.test(t) && cjk.test(Buffer.from(t, 'latin1').toString('utf8')));
  // 有中文正文（如 record md 正常）却被判定可疑 = 损坏
  const anyMojibake = titles.some((t) => /Ã.|å.|æ.|ç.|è.|é./.test(t) && !cjk.test(t));
  if (anyMojibake) { bad++; badList.push({ f, mtime: fs.statSync(p).mtime.toISOString(), it: j.iterations, ad: j.autoDecision, n: titles.length, sample: titles[0].slice(0, 40) }); }
  else good++;
}
console.log(`  损坏=${bad}  正常=${good}`);
badList.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
for (const b of badList.slice(0, 12)) {
  console.log(`  [坏] ${b.f}  mtime=${b.mtime}  iterations=${b.it} autoDecision=${b.ad} steps=${b.n}`);
  console.log(`        title=${JSON.stringify(b.sample)}`);
}
if (badList.length) {
  console.log(`  最早损坏 mtime = ${badList[badList.length - 1].mtime}`);
  console.log(`  最新损坏 mtime = ${badList[0].mtime}`);
}

console.log('\n=== 运行副本 code 中的请求体解码/编码方式 ===');
const rt = String.raw`C:\Users\Administrator\.dsh\profiles\web\node_modules\dsh-web-relay\lib\index.js`;
const src = fs.readFileSync(rt, 'utf8');
const lines = src.split('\n');
const pats = [/latin1/i, /binary/i, /setEncoding/i, /charset/i, /Buffer\.concat/, /toString\(['"]utf-?8['"]\)/i, /writeText\(/];
lines.forEach((l, i) => {
  if (pats.some((re) => re.test(l))) {
    console.log(`  L${i + 1}: ${l.trim().slice(0, 150)}`);
  }
});
