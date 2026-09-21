// 两臂**分布**比较器（token 口径 + 置换检验）
// 动机：§9.1 的教训是"对随机系统做单次对照，结论必然是伪影"。故 S 与 D 各跑到同轮数后比分布。
// 用法: node score-genexp-two-arms.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';

const CC = 'D:\\cc-tasks';
const AR = path.join(CC, 'tasks', '_retry-archive');
const labels = JSON.parse(fs.readFileSync(path.join(CC, 'genexp-labels.json'), 'utf8'));
const specific = labels.cases.filter((c) => c.genericity === 'specific');

const parseAlt = (rp) => {
  const t = fs.readFileSync(rp, 'utf8');
  const a = t.indexOf('GEN-RESULT-BEGIN');
  const b = t.indexOf('GEN-RESULT-END');
  if (a < 0 || b < 0 || b < a) return null;
  const out = new Map();
  const parts = t.slice(a, b).split(/CASE\s*(\d+)\s*[:：]/);
  for (let i = 1; i < parts.length; i += 2) {
    const id = Number(parts[i]);
    const body = parts[i + 1] || '';
    const alt = (body.match(/ALTERNATIVE\s*[:：]\s*([^\n]*)/i) || [, ''])[1].trim();
    const risk = (body.match(/RISK\s*[:：]\s*([^\n]*)/i) || [, ''])[1].trim();
    out.set(id, { alt, risk, text: `${alt} ${risk}`.toLowerCase() });
  }
  return out;
};
const caseHit = (c, got) => !!got && c.tokens.every((toks) => toks.some((tk) => got.text.includes(String(tk).toLowerCase())));

function collect(dir, tag) {
  const rp = path.join(dir, 'out', 'report.md');
  if (!fs.existsSync(rp)) return null;
  const got = parseAlt(rp);
  if (!got || !got.size) return null;
  const per = specific.map((c) => caseHit(c, got.get(c.id)));
  return { tag, per, score: per.filter(Boolean).length };
}

const S = [];
const D = [];
// S：原始 + 26 复本
{
  const one = collect(path.join(CC, 'tasks', 'ccgen-20260916-prop-s'), 's-base');
  if (one) S.push(one);
  for (let i = 1; i <= 26; i++) {
    const tag = String(i).padStart(2, '0');
    const r = collect(path.join(CC, 'tasks', `ccgen-20260916-prop-s-r${tag}`), `s-r${tag}`);
    if (r) S.push(r);
  }
}
// D：当前 + 归档
{
  const one = collect(path.join(CC, 'tasks', 'ccgen-20260916-prop-d'), 'd-current');
  if (one) D.push(one);
  for (const d of fs.readdirSync(AR).filter((x) => x.startsWith('ccgen-20260916-prop-d')).sort()) {
    const r = collect(path.join(AR, d), 'd-' + d.slice(-12));
    if (r) D.push(r);
  }
}

const dist = (arr) => {
  const c = { 0: 0, 1: 0, 2: 0 };
  arr.forEach((x) => { c[x.score] = (c[x.score] || 0) + 1; });
  const mean = arr.reduce((s, x) => s + x.score, 0) / (arr.length || 1);
  return { n: arr.length, mean, c };
};
const rate = (arr, idx) => (arr.length ? arr.filter((x) => x.per[idx]).length / arr.length : 0);

console.log(`=== 两臂分布比较（token 口径；语料 same；specific 满分 2）===\n`);
for (const [name, arr] of [['S（单方提议）', S], ['D（多角色反证）', D]]) {
  const d = dist(arr);
  console.log(`  ${name}: n=${d.n}  均值=${d.mean.toFixed(2)}/2  分布 0分:${d.c[0]} 1分:${d.c[1]} 2分:${d.c[2]}`);
  specific.forEach((c, i) => console.log(`     案例${c.id} 命中率 ${(rate(arr, i) * 100).toFixed(0)}%（${arr.filter((x) => x.per[i]).length}/${arr.length}）`));
}

// 置换检验（双尾）：在"两臂同分布"的原假设下，观测到的均值差有多极端
// ⚠ 两个坑，本脚本初版都踩了：
//   ① RNG 必须用 Math.imul 做 32 位乘法——直接 `seed * 1103515245` 在 JS 里超出 2^53 精度，
//      低位失真 → 退化成固定置换 → p 值恒为 0（荒谬：n=1 也报"拒绝同分布"）。
//   ② **任一臂 n < 5 时不得报告 p 值**——那正是 §9.1 记录的"用单次观测下结论"的伪影来源。
const MIN_N_FOR_TEST = 5;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x.score, 0) / a.length : 0);
const obs = mean(D) - mean(S);
const pool = [...S, ...D].map((x) => x.score);

let permutationP = null;
const ITER = 20000;
if (S.length < MIN_N_FOR_TEST || D.length < MIN_N_FOR_TEST) {
  console.log(`\n  观测均值差（D−S）= ${obs.toFixed(3)}`);
  console.log(`  ✗ **不报告 p 值**：样本不足（S n=${S.length}、D n=${D.length}，要求各 ≥${MIN_N_FOR_TEST}）。`);
  console.log('    单次观测之间的差就是随机波动，检验无意义——这正是 §9.1 记录的伪影来源。');
} else {
  let ge = 0;
  let s0 = 0x9e3779b9;
  const rnd = () => { s0 ^= s0 << 13; s0 >>>= 0; s0 ^= s0 >>> 17; s0 ^= s0 << 5; s0 >>>= 0; return s0 / 0x100000000; };
  for (let it = 0; it < ITER; it++) {
    const a = pool.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    const dm = mean(a.slice(0, S.length));
    const dd = mean(a.slice(S.length));
    if (Math.abs(dd - dm) >= Math.abs(obs) - 1e-12) ge++;
  }
  const p = ge / ITER;
  permutationP = p;
  console.log(`\n  观测均值差（D−S）= ${obs.toFixed(3)}`);
  console.log(`  置换检验（${ITER} 次，双尾，xorshift32）p ≈ ${p.toFixed(4)}${p < 0.05 ? ' → 拒绝"同分布"' : ' → 不足以拒绝"同分布"'}`);
}

console.log('\n=== 必须同时声明的仪器局限 ===');
console.log('  · token 匹配器已实测存在**系统性假阴性**（近义词不命中，见 §3.5）→ 绝对命中率被低估；');
console.log('  · 但其**偏差方向对两臂相同**（同一词表、同一语料），故两臂**相对比较**仍可用；');
console.log('  · 生成任务随机性大（同臂得分跨越 0–2）→ 需要本轮这样的多轮重复才能比较。');

if (process.argv.includes('--json')) {
  const out = path.join(CC, 'genexp-two-arms.json');
  fs.writeFileSync(out, JSON.stringify({
    at: new Date().toISOString(),
    S: { n: S.length, mean: dist(S).mean, dist: dist(S).c, perCase: specific.map((c, i) => rate(S, i)), runs: S.map((x) => x.score) },
    D: { n: D.length, mean: dist(D).mean, dist: dist(D).c, perCase: specific.map((c, i) => rate(D, i)), runs: D.map((x) => x.score) },
    observedDiff: obs, permutationP, iterations: ITER,
  }, null, 2), 'utf8');
  console.log(`  → 已写 ${out}`);
}
