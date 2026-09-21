// Step 0 建模：分类器回退修复的影响面、锚点唯一性、真实 reason 文本形态
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:\\dsh-web-relay';

console.log('=== ① classifyCcFailure 的调用方（影响面）===');
for (const f of ['lib/cc-stats.mjs', 'lib/index.js', 'lib/cc-channel.js', 'lib/swarm-prompts.js']) {
  const p = path.join(REPO, f);
  if (!fs.existsSync(p)) continue;
  fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((l, i) => {
    if (/classifyCcFailure/.test(l)) console.log(`  ${f}:${i + 1}  ${l.trim().slice(0, 118)}`);
  });
}

console.log('\n=== ② 锚点候选唯一性（避免假锚点）===');
const src = fs.readFileSync(path.join(REPO, 'lib/cc-stats.mjs'), 'utf8');
const cands = [
  'const isMarkerMissing = ',
  'category = classifyCcFailure(reasonText).category;',
  'export function classifyCcFailure(reasonText)',
  'export function summarizeChainTasks(results,',
  'const FAILURE_RULES = [',
  "'cc-marker-missing',",
  "['cc-timeout',",
  "['runner-failed',",
  "['timeout',",
  'done.flag',
];
for (const c of cands) {
  let n = 0; let i = 0;
  while ((i = src.indexOf(c, i)) !== -1) { n++; i += c.length; }
  console.log(`  出现 ${n} 次: ${c}`);
}

console.log('\n=== ③ 真实 reason 文本形态（errorCode 为空的行）===');
const seen = new Map();
const tasksRoot = 'D:\\cc-tasks\\tasks';
for (const d of fs.readdirSync(tasksRoot)) {
  const p = path.join(tasksRoot, d, 'result.json');
  if (!fs.existsSync(p)) continue;
  let r; try { r = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
  if (r.errorCode) continue;
  const key = String(r.reason || '(空)');
  seen.set(key, (seen.get(key) || 0) + 1);
}
for (const [k, v] of [...seen].sort((a, b) => b[1] - a[1])) console.log(`  ×${String(v).padStart(2)}  ${k}`);

console.log('\n=== ④ 有 errorCode 的行的 reason 形态（对照）===');
const seen2 = new Map();
for (const d of fs.readdirSync(tasksRoot)) {
  const p = path.join(tasksRoot, d, 'result.json');
  if (!fs.existsSync(p)) continue;
  let r; try { r = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
  if (!r.errorCode) continue;
  const key = `${r.errorCode}  |  ${String(r.reason || '(空)')}`;
  seen2.set(key, (seen2.get(key) || 0) + 1);
}
for (const [k, v] of [...seen2].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ×${String(v).padStart(2)}  ${k}`);

console.log('\n=== ⑤ 规则顺序（决定分桶优先级）===');
src.split(/\r?\n/).slice(54, 71).forEach((l, i) => console.log(`  L${i + 55}: ${l.trim()}`));
