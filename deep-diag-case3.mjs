// 深挖：案例3 候选为何在 v2 探针下仍 0/16 —— 打印完整源码并复演调用序列
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CC = 'D:\\cc-tasks';
const id = 'ccexec-20260917-e01';
const t = fs.readFileSync(path.join(CC, 'tasks', id, 'out', 'report.md'), 'utf8');
const b = t.indexOf('===EXEC-FIX 3 BEGIN===');
const e = t.indexOf('===EXEC-FIX 3 END===');
const src = t.slice(b + '===EXEC-FIX 3 BEGIN==='.length, e).trim().replace(/^```[a-zA-Z]*\s*\n/, '').replace(/\n```\s*$/, '').trim();
console.log('=== 候选完整源码（E01 案例3）===');
console.log(src.split('\n').map((l) => '  ' + l).join('\n'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-'));
const f = path.join(tmp, 'c.mjs');
fs.writeFileSync(f, src, 'utf8');
const mod = await import(pathToFileURL(f).href);

const mkPrev = (status, n) => ({ status, attempts: n, failCount: n, failures: n, retryCount: n });
console.log('\n=== 复演探针的调用序列 ===');
let prev = null;
for (let i = 0; i < 12; i++) {
  let d;
  try { d = mod.decideRedispatch({ prev, maxAttempts: 3, attempts: prev ? prev.attempts : 0 }); }
  catch (err) { console.log(`  i=${i} prev=${JSON.stringify(prev)} → 抛错 ${err.message}`); break; }
  console.log(`  i=${i} prev=${JSON.stringify(prev)} → ${d}`);
  if (d === 'stop') break;
  if (d === 'redispatch') prev = mkPrev('verify-rejected', (prev?.attempts || 0) + 1);
  else prev = { ...(prev || mkPrev('waiting', 0)), status: 'waiting' };
}
fs.rmSync(tmp, { recursive: true, force: true });
