// 把 cc-chain.mjs 里内联的额度判据替换为对唯一模块的再导出（带后置断言）。
import fs from 'node:fs';

const p = 'D:\\dsh relay test\\cc-chain.mjs';
let s = fs.readFileSync(p, 'utf8');
const before = s.length;

if (s.includes("from './quota-classify.mjs'")) {
  console.log('已收敛（幂等跳过）');
} else {
  const startMark = 'export function parseQuotaResetsAt(text) {';
  const endMark = 'export function shortcutCapMs(kind) {';
  const i = s.indexOf(startMark);
  const j = s.indexOf(endMark);
  if (i < 0 || j < 0) { console.error('✗ 锚点未找到，拒绝盲改'); process.exit(1); }
  const after = s.indexOf('\n}\n', j);
  if (after < 0) { console.error('✗ 找不到 shortcutCapMs 结束位置'); process.exit(1); }
  const removed = s.slice(i, after + 3);
  const replacement = [
    '// 判据已**收敛到唯一模块** quota-classify.mjs（2026-09-19）：本文件不再自带实现，只做再导出，',
    '// 以免"同一判断多处实现"再次漂移（该模块头部注释记录了五处副本与 weekly limit 事故的来龙去脉）。',
    'export { parseQuotaResetsAt, classifyQuotaProbe, shortcutCapMs };',
    '',
  ].join('\n');
  s = s.slice(0, i) + replacement + s.slice(after + 3);
  const anchor = "import { pathToFileURL } from 'node:url';";
  const imp = "import { parseQuotaResetsAt, classifyQuotaProbe, shortcutCapMs } from './quota-classify.mjs';";
  if (!s.includes(imp)) {
    if (!s.includes(anchor)) { console.error('✗ 找不到 import 锚点'); process.exit(1); }
    s = s.replace(anchor, `${anchor}\n${imp}`);
  }
  fs.writeFileSync(p, s, 'utf8');
  console.log(`已替换：删除内联实现 ${removed.length} 字节 → 改为再导出`);
}

const out = fs.readFileSync(p, 'utf8');
const problems = [];
if (!out.includes("from './quota-classify.mjs'")) problems.push('未引入唯一模块');
if (/export function parseQuotaResetsAt/.test(out)) problems.push('内联实现仍在（未删除）');
if (/export function classifyQuotaProbe/.test(out)) problems.push('内联 classifyQuotaProbe 仍在');
if (/export function shortcutCapMs/.test(out)) problems.push('内联 shortcutCapMs 仍在');
if (!/export \{ parseQuotaResetsAt, classifyQuotaProbe, shortcutCapMs \};/.test(out)) problems.push('再导出缺失');
if (out.length > before) problems.push(`体量反而变大：${before} → ${out.length}`);
if (problems.length) { console.error('✗ 后置断言失败：\n- ' + problems.join('\n- ')); process.exit(1); }
console.log(`✓ 后置断言通过（体量 ${before} → ${out.length}）`);
