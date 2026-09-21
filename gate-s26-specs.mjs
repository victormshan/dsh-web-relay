// 批量门禁：对 26 份 S 复本逐一跑 check-spec，汇总结果（任一 FAIL 即整体不可派发）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const files = [];
for (let i = 1; i <= 26; i++) files.push(`cc-specs/genexp-s-r${String(i).padStart(2, '0')}.mjs`);
files.push('cc-specs/genexp-s.mjs');

let ok = 0;
const bad = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ['check-spec.mjs', f], { cwd: 'D:\\dsh relay test', encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = r.status === 0 && /RESULT: OK/.test(out);
  if (pass) ok++; else bad.push({ f, exit: r.status, tail: out.trim().split('\n').slice(-3).join(' | ') });
}
console.log(`  门禁: ${ok}/${files.length} 通过`);
for (const b of bad) console.log(`  ✗ ${b.f} exit=${b.exit}  ${b.tail}`);

// 顺带核对：链条定义里每项的 spec 文件都存在
const chainSrc = fs.readFileSync('D:\\dsh relay test\\cc-chains\\v6-gen-s26.mjs', 'utf8');
const specs = [...chainSrc.matchAll(/spec: '([^']+)'/g)].map((m) => m[1]);
const missing = specs.filter((s) => !fs.existsSync('D:\\dsh relay test\\' + s.replace(/\//g, '\\')));
console.log(`  链条引用 spec ${specs.length} 个，磁盘缺失 ${missing.length}${missing.length ? ': ' + missing.join(', ') : ''}`);
process.exit(bad.length || missing.length ? 1 : 0);
