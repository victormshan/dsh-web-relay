// 构建 /steps/restructure 的 payload（用 node 序列化，避开 PowerShell ConvertTo-Json 的数组退化坑）
// 用法: node build-restructure-payload.mjs <steps.json> <out.json> <exprId> <workspacePath>
import fs from 'node:fs';

const [stepsFile, outFile, exprId, workspacePath] = process.argv.slice(2);
if (!stepsFile || !outFile || !exprId || !workspacePath) {
  console.error('usage: node build-restructure-payload.mjs <steps.json> <out.json> <exprId> <workspacePath>');
  process.exit(2);
}

const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
if (!Array.isArray(steps)) {
  console.error('steps 不是数组，实际类型: ' + typeof steps);
  process.exit(1);
}

// 归一化：补齐 normalizeStep 期望的字段，避免服务端字段缺失导致的静默默认值
const normalized = steps.map((s, i) => ({
  id: String(s.id ?? i + 1),
  title: String(s.title ?? ''),
  detail: String(s.detail ?? ''),
  review: typeof s.review === 'boolean' ? s.review : false,
  reviewSpecified: typeof s.review === 'boolean',
  acceptance: String(s.acceptance ?? ''),
  artifacts: Array.isArray(s.artifacts) ? s.artifacts.map(String) : [],
  depends_on: Array.isArray(s.depends_on) ? s.depends_on.map(String) : [],
  parallel_group: s.parallel_group ?? null,
  alternatives: Array.isArray(s.alternatives) ? s.alternatives : [],
  importance: ['high', 'medium', 'low'].includes(s.importance) ? s.importance : null,
  breakthrough_type: s.breakthrough_type ?? null,
  architect_vision: s.architect_vision ?? null,
  architect: s.architect ?? null,
}));

const payload = { workspacePath, exprId, steps: normalized };
fs.writeFileSync(outFile, JSON.stringify(payload), 'utf8');

const ids = normalized.map((s) => s.id);
console.log(`steps=${normalized.length} ids=[${ids.join(',')}] -> ${outFile}`);
