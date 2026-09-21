// 只读会话上下文恢复工具（支持 rc.7 旧格式 session.jsonl.zstd 与新线 v3 格式）
// 用法：
//   node recover-session-context.mjs <session 文件路径> head        # 看 schema 与头部
//   node recover-session-context.mjs <session 文件路径> messages    # 抽取 user/assistant 文本
import fs from 'node:fs';
import zlib from 'node:zlib';

const path = process.argv[2];
const mode = process.argv[3] ?? 'head';
if (!path) {
  console.error('usage: node recover-session-context.mjs <path> [head|messages]');
  process.exit(2);
}

const raw = fs.readFileSync(path);
const text = path.endsWith('.decoded')
  ? raw.toString('utf8')
  : zlib.zstdDecompressSync(raw).toString('utf8');

const lines = text.split(/\r?\n/).filter((l) => l.trim());
const objs = lines.map((l) => {
  try {
    return JSON.parse(l);
  } catch {
    return { __raw: l };
  }
});

console.log('file      :', path);
console.log('lines     :', lines.length);
console.log('chars     :', text.length);
console.log('first keys:', Object.keys(objs[0] ?? {}).join(','));

const census = {};
for (const o of objs) {
  const k = o.role ?? o.type ?? o.kind ?? '?';
  census[k] = (census[k] ?? 0) + 1;
}
console.log('census    :', JSON.stringify(census));
console.log('---');

const walk = (v, out = []) => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) walk(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, out);
  return out;
};

if (mode === 'head') {
  for (const o of objs.slice(0, 5)) console.log(JSON.stringify(o).slice(0, 700));
} else {
  for (const [i, o] of objs.entries()) {
    const role = o.role ?? o.type ?? o.kind;
    if (role !== 'user' && role !== 'assistant') continue;
    const strings = walk(o).filter((s) => s.trim().length > 0);
    const body = strings.sort((a, b) => b.length - a.length)[0] ?? '';
    console.log(`[${i}] ${role}: ${body.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
}
