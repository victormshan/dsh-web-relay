// 检查某个会话是否真的收到了「主 agent 能力装配」注入。
// 判据：会话日志里的 *系统/上下文类* 条目（而非我们自己的 user/assistant 对话）是否含
// relay 装配标记（【主 agent 请协助】/ 三方协作机制 / MAIN_AGENT_ASSEMBLY / 装配 / lessons）。
// 用法：node check-assembly-injection.mjs <session.jsonl.zstd>
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const MARKERS = [
  '【主 agent 请协助】',
  '三方协作机制（web-relay 语境',
  'MAIN_AGENT_ASSEMBLY',
  '主 agent 能力装配',
  '跨工作区上下文桥接',
  'dsh-web-relay-main-agent',
];

const buf = fs.readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offsets = [];
for (let i = 0; i + 4 <= buf.length; i++) if (buf.subarray(i, i + 4).equals(MAGIC)) offsets.push(i);
let text = '';
for (let k = 0; k < offsets.length; k++) {
  const s = offsets[k];
  const e = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
  try {
    text += zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
  } catch {}
}

const lines = text.split(/\r?\n/).filter((l) => l.trim());
const byType = {};
const systemEntries = [];
const markerHits = {};

for (const line of lines) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  const t = o.type ?? '?';
  byType[t] = (byType[t] ?? 0) + 1;
  if (t.startsWith('system/') || t.includes('context') || t.includes('injection')) {
    const walk = (v, acc = []) => {
      if (typeof v === 'string') acc.push(v);
      else if (Array.isArray(v)) v.forEach((x) => walk(x, acc));
      else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, acc));
      return acc;
    };
    const body = walk(o.data ?? o).join(' ');
    const plugin = o?.data?.message?.source?.plugin ?? o?.data?.source?.plugin ?? null;
    systemEntries.push({ type: t, plugin, len: body.length, sample: body.slice(0, 140) });
  }
  for (const m of MARKERS) {
    if (line.includes(m)) {
      markerHits[m] = markerHits[m] ?? { total: 0, inSystemLike: 0 };
      markerHits[m].total++;
      if (t.startsWith('system/') || t.includes('context') || t.includes('injection')) markerHits[m].inSystemLike++;
    }
  }
}

console.log('file       :', file);
console.log('frames/lines:', offsets.length, '/', lines.length);
console.log('事件类型    :', JSON.stringify(byType, null, 0));
console.log('\n--- 系统/上下文类条目（真正的"注入"只会出现在这里）---');
if (!systemEntries.length) console.log('  （无）');
for (const [i, s] of systemEntries.entries()) {
  console.log(`  [${i}] type=${s.type} plugin=${s.plugin ?? '-'} len=${s.len}`);
  console.log(`       ${s.sample.replace(/\s+/g, ' ')}`);
}
console.log('\n--- 装配标记命中（total=任何条目 / injected=系统类条目）---');
for (const m of MARKERS) {
  const h = markerHits[m];
  console.log(`  ${m.padEnd(28)} total=${h ? h.total : 0}  injected=${h ? h.inSystemLike : 0}`);
}
