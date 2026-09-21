// 找当前宿主启动时打印的「带 token 的 URL」落在哪个日志里。
// 背景：dsh web 启动会打印 process-token URL；手机打不开是因为旧 token/cookie 失效，
// 需要拿到**当前**这条 URL 重新打开一次以换取新 cookie。
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  'D:\\dsh-web-relay\\bin',
  'D:\\cc-tasks',
  'C:\\Users\\Administrator\\.dsh\\logs',
  'C:\\Users\\Administrator\\.dsh',
  'D:\\DSH',
];

const RE = /token=|authentication required|dsh web[:\s].*(http|listen|url)/i;
const rows = [];
const walk = (dir, depth = 0) => {
  if (depth > 2) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git|sessions|storages/.test(e.name)) walk(p, depth + 1); continue; }
    if (!/\.(log|txt|out|err)$/i.test(e.name)) continue;
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.size === 0 || st.size > 8 * 1024 * 1024) continue;
    let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (!RE.test(txt)) continue;
    rows.push({ p, mtime: st.mtime, size: st.size });
  }
};
for (const d of CANDIDATES) walk(d);

rows.sort((a, b) => b.mtime - a.mtime);
console.log(`  命中含 token/认证字样的日志 = ${rows.length}`);
for (const r of rows.slice(0, 12)) console.log(`  ${r.mtime.toISOString().slice(5, 16)}  ${String(r.size).padStart(9)} B  ${r.p}`);

// 对最新的几个文件，把含 token 的行抽出来（打码显示，仅确认位置与时效）
console.log('\n=== 最近文件中的 token/URL 行（token 值打码）===');
for (const r of rows.slice(0, 6)) {
  const txt = fs.readFileSync(r.p, 'utf8');
  const lines = txt.split(/\r?\n/).filter((l) => /token=|authentication required|localhost:3080|127\.0\.0\.1:3080/i.test(l));
  if (!lines.length) continue;
  console.log(`  --- ${r.p}（${r.mtime.toISOString().slice(0, 16)}）`);
  for (const l of lines.slice(-4)) {
    console.log('    ' + l.replace(/token=[A-Za-z0-9_-]+/g, 'token=***').trim().slice(0, 160));
  }
}
