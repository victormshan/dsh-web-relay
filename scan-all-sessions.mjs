// 只读全库扫描：在 C:\Users\Administrator\.dsh\sessions 下查找包含指定关键词的用户消息
// 用法: node scan-all-sessions.mjs [kw1,kw2,...]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = 'C:\\Users\\Administrator\\.dsh\\sessions';
const kws = (process.argv[2] ?? '升级,0.1.5,npm i -g,apiProxy,rc.7,rc.1').split(',');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const decode = (file) => {
  const buf = fs.readFileSync(file);
  const offsets = [];
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.subarray(i, i + 4).equals(MAGIC)) offsets.push(i);
  let out = '';
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      out += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    } catch {}
  }
  return { text: out, frames: offsets.length };
};

const latest = (bucket) => {
  const dir = path.join(root, bucket);
  const out = [];
  for (const sid of fs.readdirSync(dir)) {
    const sd = path.join(dir, sid);
    if (!fs.statSync(sd).isDirectory()) continue;
    for (const f of fs.readdirSync(sd)) {
      if (!f.endsWith('.jsonl.zstd')) continue; // 跳过 .decoded / digest
      const p = path.join(sd, f);
      out.push({ p, mtime: fs.statSync(p).mtime, size: fs.statSync(p).size });
    }
  }
  return out;
};

const fmt = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '?');
const hits = [];

for (const bucket of fs.readdirSync(root)) {
  const bd = path.join(root, bucket);
  if (!fs.statSync(bd).isDirectory()) continue;
  for (const file of latest(bucket)) {
    let text = '';
    let frames = 0;
    try {
      const r = decode(file.p);
      text = r.text;
      frames = r.frames;
    } catch (e) {
      console.log(`[decode-fail] ${file.p} :: ${e.message}`);
      continue;
    }
    let users = 0;
    let matched = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== 'user/message') continue;
      users++;
      const acc = [];
      const walk = (v) => {
        if (typeof v === 'string') acc.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(o.data ?? o);
      const body = (acc.sort((a, b) => b.length - a.length)[0] ?? '').replace(/\s+/g, ' ');
      const found = kws.filter((k) => body.includes(k));
      if (found.length) {
        matched++;
        hits.push({ bucket, file: path.basename(file.p), mtime: file.mtime, time: o.time, found, body: body.slice(0, 200) });
      }
    }
    console.log(
      `${bucket} | ${path.basename(file.p)} | ${(file.size / 1048576).toFixed(1)}MB | frames=${frames} | users=${users} | hits=${matched} | mtime=${file.mtime.toISOString().slice(0, 19)}Z`
    );
  }
}

console.log('\n================ HITS ================');
console.log('total hits:', hits.length);
for (const h of hits.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))) {
  console.log(`\n[${fmt(h.time)}] ${h.bucket} / ${h.file} | kw=${h.found.join(',')}\n  ${h.body}`);
}
