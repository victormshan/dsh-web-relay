// 把审计层数文案从"四层审计"改为"分层审计"（层数已由 4 变 5，硬编码层数就是下一条过时文案）。
// 同步处理 registry 的 content-contains 断言，避免改文案后机验失败。
import fs from 'node:fs';

const edits = [
  ['D:\\dsh relay test\\audit-all.mjs', [['四层审计全部通过', '分层审计全部通过（③④⑤⑥⑦）'], ['四层审计', '分层审计']]],
  ['D:\\dsh relay test\\run-audit-signal.mjs', [['四层审计', '分层审计']]],
  ['D:\\dsh relay test\\regression-post-restart.mjs', [['四层审计入口自检', '分层审计入口自检']]],
  ['D:\\dsh relay test\\verify-claims.mjs', [['四层审计', '分层审计']]],
  ['D:\\cc-tasks\\run-audit.cmd', [['(6) claims replay', '(6) claims replay  (7) sediment (registry+lessons schema)']]],
];

for (const [file, pairs] of edits) {
  let s;
  try { s = fs.readFileSync(file, 'utf8'); } catch { console.log(`跳过（读不到）：${file}`); continue; }
  const before = s;
  for (const [from, to] of pairs) s = s.split(from).join(to);
  if (s !== before) { fs.writeFileSync(file, s, 'utf8'); console.log(`已改：${file}`); }
  else console.log(`无变化：${file}`);
}

// 文档与 registry 的断言必须同步（断言里原本含"四层审计"）
const DOC = 'D:\\dsh-web-relay\\docs\\execution-grounded-gates.md';
let d = fs.readFileSync(DOC, 'utf8');
const dBefore = d;
d = d.split('四层审计（③④⑤⑥）').join('分层审计（③④⑤⑥⑦；2026-09-19 起由 4 层扩为 5 层）');
d = d.split('四层审计').join('分层审计');
if (d !== dBefore) { fs.writeFileSync(DOC, d, 'utf8'); console.log('已改：docs/execution-grounded-gates.md'); }

const REG = 'D:\\dsh-web-relay\\docs\\capabilities\\registry.yaml';
let r = fs.readFileSync(REG, 'utf8');
const rBefore = r;
r = r.split('text: "四层审计"').join('text: "分层审计"');
r = r.split('执行接地门禁体系（③④⑤⑥ + 周期审计', '执行接地门禁体系（③④⑤⑥⑦ + 周期审计').join('执行接地门禁体系（③④⑤⑥⑦ + 周期审计');
if (r !== rBefore) { fs.writeFileSync(REG, r, 'utf8'); console.log('已改：docs/capabilities/registry.yaml（断言同步为 分层审计）'); }

// runbook §8 也提到了四层审计
const RB = 'D:\\dsh-web-relay\\docs\\main-agent-runbook-v0.1.md';
let b = fs.readFileSync(RB, 'utf8');
const bBefore = b;
b = b.split('四层审计').join('分层审计');
if (b !== bBefore) { fs.writeFileSync(RB, b, 'utf8'); console.log('已改：docs/main-agent-runbook-v0.1.md'); }
console.log('完成');
