// 把 registry 的机验断言从「四层审计」改为「分层审计」（与文档新措辞一致）。
//
// ⚠ 这是对上一版脚本的**重做**：上一版里我写了 `s.split(a, b).join(...)`（把替换串当成 split 的 limit 参数）
//   → limit 被强制转成 NaN → split 返回空数组 → join 后把整个 registry.yaml **清空**（495 行 → 0 行，靠 git 还原）。
//   教训：批量文本手术必须**带后置断言**（行数/条目数不能凭空减少），否则"改坏"会以"成功退出"的形式发生。
import fs from 'node:fs';

const REG = 'D:\\dsh-web-relay\\docs\\capabilities\\registry.yaml';
const DOC = 'D:\\dsh-web-relay\\docs\\execution-grounded-gates.md';

const pre = (p) => {
  const s = fs.readFileSync(p, 'utf8');
  return { lines: s.split('\n').length, ids: (s.match(/^- id: /gm) || []).length, size: s.length };
};

const before = { reg: pre(REG), doc: pre(DOC) };
console.log('前置：registry 行数=%d 条目=%d', before.reg.lines, before.reg.ids);

let r = fs.readFileSync(REG, 'utf8');
r = r.split('text: "四层审计"').join('text: "分层审计"');
fs.writeFileSync(REG, r, 'utf8');

let d = fs.readFileSync(DOC, 'utf8');
d = d.split('分层审计（③④⑤⑥⑦；2026-09-19 起由 4 层扩为 5 层）').join('分层审计（③④⑤⑥⑦；2026-09-19 起由 4 层扩为 5 层）'); // 保持
fs.writeFileSync(DOC, d, 'utf8');

const after = { reg: pre(REG), doc: pre(DOC) };
console.log('后置：registry 行数=%d 条目=%d', after.reg.lines, after.reg.ids);

// 后置断言：条目数不得变化；行数不得凭空减少；文件不得为空
const problems = [];
if (after.reg.ids !== before.reg.ids) problems.push(`registry 条目数变化：${before.reg.ids} → ${after.reg.ids}`);
if (after.reg.lines < before.reg.lines - 1) problems.push(`registry 行数异常减少：${before.reg.lines} → ${after.reg.lines}`);
if (after.reg.size < 1000) problems.push(`registry 体积异常（${after.reg.size} 字节）`);
if (after.doc.size < 1000) problems.push(`文档体积异常（${after.doc.size} 字节）`);
if (problems.length) { console.error('✗ 后置断言失败：\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('✓ 后置断言通过（条目数与体量未被破坏）');
