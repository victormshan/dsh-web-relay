// 只替换指定步骤的合并器：保权威列表 1、3-7 逐字不变，仅用 AI 返回的同 id 步骤覆盖该步。
// 用法: node merge-step.mjs <currentSteps.json> <aiSteps.json> <stepId> <out.json>
import fs from 'node:fs';

const [curFile, aiFile, stepId, outFile] = process.argv.slice(2);
if (!curFile || !aiFile || !stepId || !outFile) {
  console.error('usage: node merge-step.mjs <currentSteps.json> <aiSteps.json> <stepId> <out.json>');
  process.exit(2);
}

const cur = JSON.parse(fs.readFileSync(curFile, 'utf8'));
const ai = JSON.parse(fs.readFileSync(aiFile, 'utf8'));
if (!Array.isArray(cur)) throw new Error('current 不是数组');
if (!Array.isArray(ai)) throw new Error('ai 不是数组');

const replacement = ai.find((s) => String(s.id) === String(stepId));
if (!replacement) {
  console.error(`AI 返回中没有 id=${stepId} 的步骤；AI 返回的 ids=[${ai.map((s) => s.id).join(',')}]`);
  process.exit(1);
}

// 归一化替换步（保留 id / depends_on 约束），其余字段取 AI 版本
const merged = {
  ...replacement,
  id: String(stepId),
  depends_on: Array.isArray(replacement.depends_on) && replacement.depends_on.length
    ? replacement.depends_on.map(String)
    : (cur.find((s) => String(s.id) === String(stepId))?.depends_on ?? []),
};

const out = cur.map((s) => (String(s.id) === String(stepId) ? { ...s, ...merged, id: String(stepId), status: s.status, notes: s.notes } : s));
fs.writeFileSync(outFile, JSON.stringify(out), 'utf8');

console.log(`merged step ${stepId}:`);
console.log('  title      = ' + String(merged.title).slice(0, 90));
console.log('  importance = ' + merged.importance + ' | review = ' + merged.review + ' | deps = [' + (merged.depends_on || []).join(',') + ']');
console.log('  acceptance = ' + String(merged.acceptance).slice(0, 110));
console.log('  artifacts  = ' + (Array.isArray(merged.artifacts) ? merged.artifacts.join(' | ') : '(无)'));
console.log('unchanged ids = [' + out.map((s) => s.id).join(',') + '] -> ' + outFile);
