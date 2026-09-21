// 复原权威计划的编码损坏：对双重编码字符串做 latin1→utf8 逆变换（仅在还原后 CJK 增多时采用，避免误伤正常文本）
// 产出：D:\dsh relay test\_steps-clean.json（干净的 steps 数组，供 build-restructure-payload.mjs 使用）
import fs from 'node:fs';

const SRC = String.raw`D:\dsh relay test\web-relay\experiments\expr-2026-09-13_17-36-07.steps.json`;
const OUT = String.raw`D:\dsh relay test\_steps-clean.json`;

const countCjk = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;
const countHi = (s) => (s.match(/[\u00c0-\u00ff\u0080-\u00bf]/g) || []).length;

function decodeStr(s) {
  if (typeof s !== 'string' || !s) return s;
  if (countHi(s) < 2) return s;
  let back;
  try { back = Buffer.from(s, 'latin1').toString('utf8'); } catch { return s; }
  if (back.includes('\ufffd')) return s; // 还原失败，保留原值
  const cjkBack = countCjk(back) + (back.match(/[≥≤→←—·×÷“”‘’【】《》（）：；！？、，。]/g) || []).length;
  const cjkOrig = countCjk(s) + (s.match(/[≥≤→←—·×÷“”‘’【】《》（）：；！？、，。]/g) || []).length;
  return cjkBack > cjkOrig ? back : s;
}

const walk = (v) =>
  Array.isArray(v) ? v.map(walk)
    : (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)])) : decodeStr(v));

const j = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const fixed = walk(j);

let changed = 0;
const steps = (j.steps || []).map((orig, i) => {
  const f = fixed.steps[i];
  for (const k of Object.keys(orig)) {
    if (typeof orig[k] === 'string' && orig[k] !== f[k]) changed++;
  }
  const detailChanged = (orig.detail || '') !== (f.detail || '');
  const accChanged = (orig.acceptance || '') !== (f.acceptance || '');
  if (detailChanged) changed++;
  if (accChanged) changed++;
  return f;
});

console.log(`=== 复原结果：${steps.length} 步，字段修正 ${changed} 处 ===\n`);
for (const s of steps) {
  console.log(`[${s.id}] ${s.title}`);
  console.log(`     importance=${s.importance} review=${s.review} depends_on=[${(s.depends_on || []).join(',')}]`);
  console.log(`     detail: ${String(s.detail || '').replace(/\n/g, ' ').slice(0, 160)}`);
  console.log(`     acceptance: ${String(s.acceptance || '').replace(/\n/g, ' ').slice(0, 140)}`);
  console.log(`     artifacts: ${(s.artifacts || []).join(', ')}`);
}

// 自证：还原后不得残留双重编码
const bad = steps.filter((s) => countHi(String(s.title)) >= 2 && countCjk(Buffer.from(String(s.title), 'latin1').toString('utf8')) > countCjk(String(s.title)));
console.log(`\n=== 残留损坏步数 = ${bad.length}（应为 0）===`);

fs.writeFileSync(OUT, JSON.stringify(steps, null, 2), 'utf8');
console.log(`已写出干净 steps -> ${OUT}`);
