// A/B 实验评分器（确定性解析，不靠人工判读）
// 用法: node score-ab-experiment.mjs   [--json]
// 读两个任务 out/report.md 里的 AB-RESULT 块，与 ground truth 对照，按**预登记**规则给结论。
import fs from 'node:fs';
import path from 'node:path';

const CC = 'D:\\cc-tasks';
const LABELS = path.join(CC, 'ab-labels.json');
const ARMS = [
  { arm: 'A', label: '单方评审', taskId: 'ccab-20260916-review-a' },
  { arm: 'B', label: '结构化对抗（反证+证据强制）', taskId: 'ccab-20260916-review-b' },
];

const labels = JSON.parse(fs.readFileSync(LABELS, 'utf8'));
const expected = new Map(labels.cases.map((c) => [c.id, c.expected]));

function parseArm(taskId) {
  const rp = path.join(CC, 'tasks', taskId, 'out', 'report.md');
  if (!fs.existsSync(rp)) return { taskId, error: `报告不存在（${rp}）`, verdicts: new Map() };
  const txt = fs.readFileSync(rp, 'utf8');
  const a = txt.indexOf('AB-RESULT-BEGIN');
  const b = txt.indexOf('AB-RESULT-END');
  if (a < 0 || b < 0 || b < a) return { taskId, error: '未找到 AB-RESULT 块（BEGINS/ENDS 标记缺失）', verdicts: new Map(), txt };
  const block = txt.slice(a + 'AB-RESULT-BEGIN'.length, b);
  const verdicts = new Map();
  const bad = [];
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\s*CASE\s*(\d+)\s*[:：]\s*(FOUND|NOT_FOUND|UNCERTAIN)\b(.*)$/i);
    if (!m) { if (line.trim()) bad.push(line.trim().slice(0, 90)); continue; }
    const id = Number(m[1]);
    const verdict = m[2].toUpperCase();
    const rest = m[3] || '';
    const ev = (rest.match(/evidence\s*=\s*([^|]*)/i) || [, '-'])[1].trim();
    const finding = (rest.match(/finding\s*=\s*([^|]*)/i) || [, ''])[1].trim();
    verdicts.set(id, { verdict, evidence: ev, finding });
  }
  return { taskId, verdicts, bad, txt };
}

const results = ARMS.map((a) => ({ ...a, parsed: parseArm(a.taskId) }));

// ground truth 分组的 id
const defectIds = labels.cases.filter((c) => c.kind === 'defect').map((c) => c.id);
const cleanIds = labels.cases.filter((c) => c.kind === 'clean').map((c) => c.id);

console.log('=== A/B 实验评分（语料 7 份：含缺陷 ' + defectIds.length + ' + 对照 ' + cleanIds.length + '）===');
console.log('  预登记假设：' + labels.hypothesis);
console.log('  判定规则：' + labels.decisionRule);

const summary = {};
for (const r of results) {
  const v = r.parsed.verdicts;
  const detection = defectIds.filter((id) => v.get(id)?.verdict === 'FOUND').length;
  const falseAlarm = cleanIds.filter((id) => v.get(id)?.verdict === 'FOUND').length;
  const uncertain = [...v.values()].filter((x) => x.verdict === 'UNCERTAIN').length;
  const missing = labels.cases.map((c) => c.id).filter((id) => !v.has(id)).length;
  summary[r.arm] = { detection, falseAlarm, uncertain, missing, parsedOk: !!v.size && !r.parsed.error };
  console.log(`\n  ── ${r.arm} 组（${r.label}）taskId=${r.taskId}`);
  if (r.parsed.error) console.log(`     ⚠ 解析问题: ${r.parsed.error}`);
  if (r.parsed.bad && r.parsed.bad.length) console.log(`     ⚠ 未识别行 ${r.parsed.bad.length} 条，例: ${r.parsed.bad[0]}`);
  console.log(`     命中 ${detection}/${defectIds.length}  误报 ${falseAlarm}/${cleanIds.length}  UNCERTAIN ${uncertain}  缺失 ${missing}`);
  for (const c of labels.cases) {
    const got = v.get(c.id);
    const mark = got ? (got.verdict === c.expected ? '✓' : '✗') : '—';
    console.log(`       ${mark} 案例${c.id} 期望=${c.expected.padEnd(9)} 实际=${(got?.verdict || 'MISSING').padEnd(9)} ${c.kind === 'defect' ? '[缺陷]' : '[对照]'} evidence=${(got?.evidence || '-').slice(0, 46)}`);
  }
}

console.log('\n=== 结论（按预登记规则）===');
const A = summary.A;
const B = summary.B;
if (!A?.parsedOk || !B?.parsedOk) {
  console.log('  ⚠ 至少一组无法解析 → 实验无效，需先修产物（不构成任何结论）。');
} else if (B.detection > A.detection && B.falseAlarm <= A.falseAlarm) {
  console.log(`  → 判定 B 更优：命中 ${A.detection}→${B.detection}，误报 ${A.falseAlarm}→${B.falseAlarm}。`);
} else if (B.detection === A.detection) {
  console.log(`  → 判定「该类别下协议无收益」（命中同为 ${A.detection}/${defectIds.length}；负结果也算结论）。`);
} else {
  console.log(`  → 未支持 H1：A 命中 ${A.detection}，B 命中 ${B.detection}，B 误报 ${B.falseAlarm}（A ${A.falseAlarm}）。`);
}
console.log('  注：n=7（缺陷 5 / 对照 2），属试点规模，只能检出大效应，不足以给出精确效应量。');

if (process.argv.includes('--json')) {
  const out = path.join(CC, 'ab-result.json');
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), summary, cases: labels.cases.map((c) => ({ id: c.id, kind: c.kind, expected: c.expected, A: results[0].parsed.verdicts.get(c.id) || null, B: results[1].parsed.verdicts.get(c.id) || null })) }, null, 2), 'utf8');
  console.log(`  → 已写 ${out}`);
}
