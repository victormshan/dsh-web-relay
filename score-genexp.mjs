// 生成类实验评分器（确定性 token 匹配 + 保留原文供人工阅读）
// 用法: node score-genexp.mjs [--json]
// 判据来自 genexp-labels.json 的预登记：主指标只在 repo-specific 子集（案例 1、2）上计算。
import fs from 'node:fs';
import path from 'node:path';

const CC = 'D:\\cc-tasks';
const labels = JSON.parse(fs.readFileSync(path.join(CC, 'genexp-labels.json'), 'utf8'));
const ARMS = [
  { arm: 'S', label: '单方提议', taskId: 'ccgen-20260916-prop-s' },
  { arm: 'D', label: '多角色反证', taskId: 'ccgen-20260916-prop-d' },
];

function parseArm(taskId) {
  const rp = path.join(CC, 'tasks', taskId, 'out', 'report.md');
  if (!fs.existsSync(rp)) return { error: `报告不存在（${rp}）`, cases: new Map() };
  const txt = fs.readFileSync(rp, 'utf8');
  const a = txt.indexOf('GEN-RESULT-BEGIN');
  const b = txt.indexOf('GEN-RESULT-END');
  if (a < 0 || b < 0 || b < a) return { error: '未找到 GEN-RESULT 块', cases: new Map(), txt };
  const block = txt.slice(a + 'GEN-RESULT-BEGIN'.length, b);
  // 逐案例解析：CASE n: 之后到下个 CASE 之前，取 ALTERNATIVE / RISK 行
  const cases = new Map();
  const chunks = block.split(/^\s*CASE\s*(\d+)\s*[:：]\s*$/m);
  for (let i = 1; i < chunks.length; i += 2) {
    const id = Number(chunks[i]);
    const body = chunks[i + 1] || '';
    const alt = (body.match(/ALTERNATIVE\s*[:：]\s*([^\n]*)/i) || [, ''])[1].trim();
    const risk = (body.match(/RISK\s*[:：]\s*([^\n]*)/i) || [, ''])[1].trim();
    cases.set(id, { alt, risk, text: `${alt} ${risk}`.toLowerCase() });
  }
  return { cases, txt, doneFlag: fs.existsSync(path.join(CC, 'tasks', taskId, 'done.flag')) };
}

const score = (parsed) => {
  const per = [];
  for (const c of labels.cases) {
    const got = parsed.cases.get(c.id);
    if (!got) { per.push({ id: c.id, hit: false, groups: [], missing: true }); continue; }
    const groups = c.tokens.map((toks) => {
      const matched = toks.filter((t) => got.text.includes(String(t).toLowerCase()));
      return { ok: matched.length > 0, matched: matched.slice(0, 3) };
    });
    per.push({ id: c.id, hit: groups.every((g) => g.ok), groups, missing: false, alt: got.alt });
  }
  const specificIds = labels.cases.filter((c) => c.genericity === 'specific').map((c) => c.id);
  return {
    per,
    specificHits: per.filter((p) => specificIds.includes(p.id) && p.hit).length,
    allHits: per.filter((p) => p.hit).length,
    parsedMissing: per.filter((p) => p.missing).length,
  };
};

const results = ARMS.map((a) => ({ ...a, parsed: parseArm(a.taskId) }));
const summary = {};
for (const r of results) {
  summary[r.arm] = r.parsed.error ? { error: r.parsed.error } : { ...score(r.parsed), doneFlag: r.parsed.doneFlag };
}

console.log('=== 生成类实验评分（4 情境：specific 2 + mid 1 + generic 1）===');
console.log('  预登记假设：' + labels.hypothesis);
console.log('  判定规则：' + labels.decisionRule);
console.log('  混淆控制：' + labels.confoundControl);

for (const r of results) {
  const s = summary[r.arm];
  console.log(`\n  ── ${r.arm} 组（${r.label}）taskId=${r.taskId}`);
  if (s.error) { console.log(`     ⚠ ${s.error} → 该组无效`); continue; }
  console.log(`     主指标 specific 命中 ${s.specificHits}/${labels.cases.filter((c) => c.genericity === 'specific').length} ｜ 全例命中 ${s.allHits}/${labels.cases.length} ｜ 解析缺失 ${s.parsedMissing} ｜ done.flag=${s.doneFlag}`);
  for (const c of labels.cases) {
    const p = s.per.find((x) => x.id === c.id);
    const mark = p.missing ? '—' : p.hit ? '✓' : '✗';
    const g = p.groups ? p.groups.map((x, i) => `组${i + 1}:${x.ok ? '✓' : '✗'}`).join(' ') : '';
    console.log(`       ${mark} 案例${c.id} [${c.genericity}] ${c.title}  ${g}`);
    if (!p.missing && !p.hit) console.log(`          实际 ALTERNATIVE: ${(p.alt || '(空)').slice(0, 120)}`);
  }
}

console.log('\n=== 结论（按预登记规则）===');
const S = summary.S;
const D = summary.D;
if (S?.error || D?.error) {
  console.log('  ⚠ 至少一组无效（报告缺失或块无法解析）→ 不构成任何结论。');
} else if (D.specificHits > S.specificHits) {
  console.log(`  → 支持 H1：specific 子集命中 S ${S.specificHits} → D ${D.specificHits}（全例 S ${S.allHits} → D ${D.allHits}）。`);
} else if (D.specificHits === S.specificHits) {
  console.log(`  → 不支持 H1：specific 子集命中同为 ${S.specificHits}/2 → 判「该层面协议无收益」（负结果）。`);
} else {
  console.log(`  → 反方向：D 在 specific 子集上命中更少（S ${S.specificHits} vs D ${D.specificHits}）。`);
}
console.log('  注：n=4（specific 2），属试点规模；token 匹配粗糙，需结合原文阅读；案例 4 为通用建议，受训练知识混淆，不计入主指标。');

if (process.argv.includes('--json')) {
  const out = path.join(CC, 'genexp-result.json');
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), summary }, null, 2), 'utf8');
  console.log(`  → 已写 ${out}`);
}
