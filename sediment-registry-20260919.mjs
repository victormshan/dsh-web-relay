// 追加两条能力登记（幂等）到 docs/capabilities/registry.yaml，并保持可机验的 verification 块。
import fs from 'node:fs';

const P = 'D:\\dsh-web-relay\\docs\\capabilities\\registry.yaml';
const DOC = 'docs/execution-grounded-gates.md';
let s = fs.readFileSync(P, 'utf8');

const block = ({ id, name, category, scope, trigger, docText, lessonId }) => [
  `- id: ${id}`,
  `  name: ${name}`,
  `  category: ${category}`,
  `  scope: ${scope}`,
  `  source: ${DOC}`,
  `  trigger: ${trigger}`,
  '  conflicts: []',
  '  verification:',
  `    - file-exists: ${DOC}`,
  '    - content-contains:',
  `        file: ${DOC}`,
  `        text: "${docText}"`,
  '    - content-contains:',
  '        file: docs/main-agent-lessons.json',
  `        text: "${lessonId}"`,
  '  lastVerified: 2026-09-19',
  '  status: approved',
  '  version: 1',
  '',
].join('\n');

const entries = [
  {
    id: 'execution-grounded-gates',
    name: '执行接地门禁体系（③④⑤⑥ + 周期审计 + 变异负控 + 退出码语义）',
    category: 'tool',
    scope: 'dsh-web-relay-verification',
    trigger: '需要判定「产物是否通过 / 宿主是否已加载新代码」，或为新门禁定纪律时',
    docText: '四层审计',
    lessonId: 'L-2026-0919-075',
  },
  {
    id: 'pending-human-escalation',
    name: '无人值守升级通路（需要人介入信号 → 唤醒主 agent → 销账；含稳定键去重与主槽+队列）',
    category: 'workflow',
    scope: 'dsh-web-relay-unattended',
    trigger: '链条停下等人 / 周期审计失败 / 需要无人值守下自动叫醒主 agent 时',
    docText: '稳定键',
    lessonId: 'L-2026-0919-078',
  },
];

const added = [];
for (const e of entries) {
  if (s.includes(`- id: ${e.id}`)) continue;
  s = s.trimEnd() + '\n\n' + block(e);
  added.push(e.id);
}
fs.writeFileSync(P, s.trimEnd() + '\n', 'utf8');
console.log(added.length ? `已追加：${added.join(', ')}` : '两条均已存在（幂等跳过）');
console.log('registry 现有条目：' + (s.match(/^- id: /gm) || []).length);
