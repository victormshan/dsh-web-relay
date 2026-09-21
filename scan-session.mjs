// 只读：完整解码多帧 zstd 会话并在内存内做关键词/身份判定（不落盘）
// 用法: node scan-session.mjs <file.zstd> [kw1,kw2,...]
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const kws = (process.argv[3] ?? '升级,0.1.5,rc.1,rc.7,apiProxy,cordis.patch,注释,npm i -g,dsh web').split(',');

const buf = fs.readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offsets = [];
for (let i = 0; i + 4 <= buf.length; i++) if (buf.subarray(i, i + 4).equals(MAGIC)) offsets.push(i);

let out = '';
let ok = 0;
for (let k = 0; k < offsets.length; k++) {
  const start = offsets[k];
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
  try {
    out += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    ok++;
  } catch {}
}

const lines = out.split(/\r?\n/).filter((l) => l.trim());
console.log('file        :', file);
console.log('frames ok   :', `${ok}/${offsets.length}`);
console.log('chars/lines :', out.length, '/', lines.length);

const texts = [];
for (const l of lines) {
  let o;
  try {
    o = JSON.parse(l);
  } catch {
    continue;
  }
  const t = o.type ?? '';
  if (!t.startsWith('user/') && !t.startsWith('assistant/')) continue;
  const walk = (v, acc = []) => {
    if (typeof v === 'string') acc.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, acc));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, acc));
    return acc;
  };
  const s = walk(o.data ?? o).sort((a, b) => b.length - a.length)[0] ?? '';
  if (s.trim()) texts.push({ type: t, time: o.time ?? 0, text: s.replace(/\s+/g, ' ') });
}

const users = texts.filter((x) => x.type === 'user/message');
console.log('user msgs   :', users.length, '| assistant msgs:', texts.length - users.length);
const fmt = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : '?');
console.log('first user  :', fmt(users[0]?.time), '=>', (users[0]?.text ?? '').slice(0, 220));
console.log('last  user  :', fmt(users[users.length - 1]?.time), '=>', (users[users.length - 1]?.text ?? '').slice(0, 220));
console.log('last  asst  :', fmt(texts[texts.length - 1]?.time), '=>', (texts[texts.length - 1]?.text ?? '').slice(0, 220));

if ((process.argv[4] ?? '') === 'users') {
  console.log('--- ALL user messages ---');
  for (const u of users) console.log(`[${fmt(u.time)}] ${u.text.slice(0, 400)}`);
  process.exit(0);
}

console.log('--- keyword hits (user messages) ---');
for (const kw of kws) {
  const hits = users.filter((u) => u.text.includes(kw));
  console.log(`${kw.padEnd(14)} ${hits.length}`);
  for (const h of hits.slice(0, 2)) console.log(`    [${fmt(h.time)}] ${h.text.slice(0, 200)}`);
}
