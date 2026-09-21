// 对 25 份归档的 D 组独立产物做全量评分（意外收获：重派循环留下了大样本）
// 目的：确认 run-1（被配额终止的那次）是否**代表性样本**——若 25 次分布一致，则"打平"结论不依赖于单次抽样。
import fs from 'node:fs';
import path from 'node:path';

const AR = 'D:\\cc-tasks\\tasks\\_retry-archive';
const labels = JSON.parse(fs.readFileSync('D:\\cc-tasks\\genexp-labels.json', 'utf8'));
const specific = labels.cases.filter((c) => c.genericity === 'specific');

const dirs = fs.readdirSync(AR).filter((d) => d.startsWith('ccgen-20260916-prop-d')).sort();
console.log(`  归档的 D 组尝试数 = ${dirs.length}`);

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
const hit = (c, got) => {
  if (!got) return false;
  return c.tokens.every((toks) => toks.some((tk) => got.text.includes(String(tk).toLowerCase())));
};

const rows = [];
let unparsable = 0;
const perCase = new Map(specific.map((c) => [c.id, 0]));
const combined = new Map(specific.map((c) => [c.id, 0])); // 两例同时命中
const bothHit = [];

for (const d of dirs) {
  const rp = path.join(AR, d, 'out', 'report.md');
  if (!fs.existsSync(rp)) { unparsable++; rows.push({ d, ok: false, note: 'report 缺失' }); continue; }
  const got = parseAlt(rp);
  if (!got || got.size === 0) { unparsable++; rows.push({ d, ok: false, note: 'GEN-RESULT 块缺失/不可解析' }); continue; }
  const res = specific.map((c) => ({ id: c.id, hit: hit(c, got.get(c.id)) }));
  res.forEach((r) => { if (r.hit) perCase.set(r.id, perCase.get(r.id) + 1); });
  const n = res.filter((r) => r.hit).length;
  if (n === specific.length) bothHit.push(d);
  rows.push({ d, ok: true, hits: res.map((r) => `${r.id}:${r.hit ? '✓' : '✗'}`).join(' '), n });
}

console.log(`  可解析 = ${rows.filter((r) => r.ok).length} ｜ 不可解析 = ${unparsable}`);
console.log('=== 逐次（specific 两例）===');
for (const r of rows) console.log(`  ${r.ok ? r.hits : '—  ' + r.note}   ${r.d.slice(-16)}`);
console.log('=== 分布（token 口径，与 S 组同口径）===');
for (const c of specific) console.log(`  案例${c.id}（${c.title}）命中 ${perCase.get(c.id)}/${rows.filter((r) => r.ok).length}`);
const okN = rows.filter((r) => r.ok).length;
const hitCounts = rows.filter((r) => r.ok).map((r) => r.n);
const mean = hitCounts.reduce((s, v) => s + v, 0) / (okN || 1);
console.log(`  specific 命中均值 = ${mean.toFixed(2)}/2（S 组单次 = 1/2）`);
console.log(`  两例同时命中 = ${bothHit.length}/${okN}`);

fs.writeFileSync('D:\\cc-tasks\\genexp-d-archive-scores.json', JSON.stringify({ at: new Date().toISOString(), n: okN, perCase: Object.fromEntries(perCase), mean, rows }, null, 2), 'utf8');
console.log('  → 明细已写 D:\\cc-tasks\\genexp-d-archive-scores.json');
