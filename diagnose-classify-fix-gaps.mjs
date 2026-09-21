// 取全证据：调用点是否合并了 reason、计数判定是否与 category 一致、新用例覆盖到哪一层、报告自称什么
import fs from 'node:fs';

const REPO = 'D:\\dsh-web-relay';
const src = fs.readFileSync(REPO + '\\lib\\cc-stats.mjs', 'utf8');
const lines = src.split(/\r?\n/);

console.log('=== ① 两个调用点现在长什么样（要求：errorCode 与 reason 一并纳入判定）===');
lines.forEach((l, i) => {
  if (/classifyCcFailure\(/.test(l) && !/export function/.test(l)) console.log(`  L${i + 1}: ${l.trim()}`);
});

console.log('\n=== ② marker 计数判定 vs 分类结果（是否可能不一致）===');
lines.forEach((l, i) => {
  if (/isMarkerMissing|markerMissing\s*\+=|markerMissing\s*:/.test(l)) console.log(`  L${i + 1}: ${l.trim().slice(0, 130)}`);
});

console.log('\n=== ③ FAILURE_RULES 现状（cc 改后的实际规则）===');
const start = lines.findIndex((l) => /const FAILURE_RULES = \[/.test(l));
for (let i = start; i < start + 16 && i < lines.length; i++) console.log(`  L${i + 1}: ${lines[i].trim()}`);

console.log('\n=== ④ 新增用例名（看覆盖在哪一层：分类器层 or 计数层）===');
const t = fs.readFileSync(REPO + '\\test\\cc-stats.test.mjs', 'utf8');
const names = [...t.matchAll(/(?:^|\s)(?:test|it)\(\s*['"`]([^'"`]{4,120})/g)].map((m) => m[1]);
console.log(`  用例总数 = ${names.length}`);
for (const n of names.slice(-18)) console.log(`    - ${n}`);

console.log('\n=== ⑤ cc 报告里自称的回放结果 ===');
const rp = 'D:\\cc-tasks\\tasks\\ccfix-20260916-fallback-classify\\out\\report.md';
const rep = fs.readFileSync(rp, 'utf8');
const rl = rep.split(/\r?\n/);
rl.forEach((l, i) => {
  if (/unknown|byFailure|markerMissing|before|after|回放|failed=/.test(l)) console.log(`  ${l.trim().slice(0, 150)}`);
});
