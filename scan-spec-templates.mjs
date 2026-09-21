// 扫描 cc-specs 下所有规格的 prompt 模板内是否残留裸反引号或嵌套 ${}（二者都会破坏模板字面量）
// 2026-09-15 修复两处：
//  ① **动态扫描**：原实现硬编码 7 个文件名，而我新加的规格（含真正出过反引号事故的 fix-swarm-parse.mjs）
//     根本不在列表里 → 扫描通过但毫无保证。现改为扫描 cc-specs/*.mjs 全部文件。
//  ② 新增 anchors 提示：实现类规格建议声明 anchors（check-spec 会校验其真实性）；
//     该提示**不计入「需要修复的规格数」**，以免改红回归套件里的 `= 0` 断言。
// 注意：裸反引号**不一定会让 node --check 失败**——模板串被提前闭合仍是合法 JS，错误只在运行时
// （ReferenceError）或语义截断上暴露。这正是本扫描器存在的理由（教训 071）。
import fs from 'node:fs';

const DIR = 'cc-specs';
let files;
try {
  files = fs.readdirSync(DIR).filter((f) => f.endsWith('.mjs')).sort();
} catch {
  console.log(`  ${DIR} 目录不可读`);
  process.exit(2);
}

let bad = 0;
let noAnchors = 0;
for (const f of files) {
  let s;
  try { s = fs.readFileSync(`${DIR}/${f}`, 'utf8'); } catch { console.log('  ' + f.padEnd(32) + ' 不存在'); continue; }
  const start = s.indexOf('prompt: `');
  const end = s.lastIndexOf('`,');
  const inner = (start >= 0 && end > start) ? s.slice(start + 9, end) : '';
  // 只计**未转义**的反引号（\` 在模板字面量里是合法的字面量，不是终止符）；${ 同理
  const ticks = (inner.match(/(?<!\\)`/g) || []).length;
  const nested = (inner.match(/(?<!\\)\$\{/g) || []).length;
  const ok = ticks === 0 && nested === 0;
  if (!ok) bad++;
  const hasAnchors = /^\s*anchors\s*:/m.test(s);
  if (!hasAnchors) noAnchors++;
  console.log('  ' + f.padEnd(32) + ' prompt字节=' + String(Buffer.byteLength(inner, 'utf8')).padStart(5)
    + ' 裸反引号=' + ticks + ' 嵌套${}=' + nested + ' anchors=' + (hasAnchors ? '有' : '无')
    + (ok ? '' : '  ← 需修'));
}
console.log(`  → 需要修复的规格数 = ${bad}`);
console.log(`  → 未声明 anchors 的规格数 = ${noAnchors}（提示项，不计入上一条；实现类规格建议声明，见 check-spec.mjs --selftest-anchors）`);
