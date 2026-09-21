// 设计2 生成器：散文反证（P） vs 可执行反例（E）—— 判定者是**执行探针**，不是模型。
//
// 与第一/二轮的区别（问题不同，务必分清）：
//   前两轮问「哪一臂的**方案文本**更贴近关键洞察」→ 需要模型裁判 → 遭遇风格混杂与自偏好。
//   本轮问「在必须交出**可执行修复**的任务里，要求反证方提交**可执行反例**是否比写**散文批判**产出更好的修复」
//     → 判定由隐藏探针**执行**给出：无模型裁判、无风格通道、无自偏好（这正是评估端最干净的形式）。
//
// 唯一变量 = 反证阶段的产出要求（步骤2 一段话）；其余（三案例、症状、输出格式、约束）逐字节相同。
import fs from 'node:fs';
import { MODULES } from './exec-cases.mjs';

const N = Number(process.argv[2] || 8);   // 每臂轮数

const casesBlock = [1, 2, 3].map((id) => {
  const m = MODULES[id];
  return `【案例 ${id}】${m.title}
必须保留的导出：${m.exports}
症状：${m.symptom}
带 bug 的现有源码：
\`\`\`js
${m.buggySource}\`\`\``;
}).join('\n\n');

const OUTPUT_FORMAT = `【必须输出机器可读块】报告 out/report.md 中必须包含如下块（严格使用下面的分隔行，逐案例按序）：

===EXEC-FIX 1 BEGIN===
<案例 1 修复后的**完整模块源码**（纯代码，不要 markdown 围栏）>
===EXEC-FIX 1 END===
===EXEC-FIX 2 BEGIN===
<案例 2 修复后的完整模块源码>
===EXEC-FIX 2 END===
===EXEC-FIX 3 BEGIN===
<案例 3 修复后的完整模块源码>
===EXEC-FIX 3 END===

块内只放代码（保持导出名不变、可直接被 import 运行）。块之后可另附简短说明。`;

const COMMON = `你是 dsh-web-relay 项目组的资深工程师。下面给出 3 个**带缺陷的自包含模块**及其症状。请逐个定位根因并给出**修复后的完整模块源码**。

工作目录外不要改动任何文件；你可以自由地在 /tmp 下写临时脚本用于验证（推荐）。

【硬性要求】
- 修复后必须**保持原有导出名与调用签名**（探针会按原接口调用）。
- 输出必须包含上文的机器可读分隔行，块内**只放代码**。
- **完成后必须写入完成标记 done.flag**（路径见任务契约）——只写产物不写标记会被判为失败。

${OUTPUT_FORMAT}

================ 案例 ================

${casesBlock}

================ 案例结束 ================`;

const PROTOCOL_P = `【工作方式（P 组：散文反证）】
1) 先按你的直觉给出每个案例的修复方案。
2) **反证**：以反证者身份，用**散文**说明你的修复在什么情况下会失效（指出失效场景即可）。
3) 依据第 2 步的结论，输出最终修复后的完整源码。`;

const PROTOCOL_E = `【工作方式（E 组：可执行反例）】
1) 先按你的直觉给出每个案例的修复方案。
2) **反证**：以反证者身份，**必须写出一个可执行的 Node.js 复现脚本并真的运行它**，
   用**真实输出**证明你的修复在什么情况下会失效（或证明它成立）。
   若你无法构造出可执行的反例，必须在该案例的说明里明确写 NO_REPRO 并说明卡在哪一步——
   **不允许用散文代替可执行反例**。
3) 依据第 2 步的实测结论，输出最终修复后的完整源码。`;

function buildPrompt(protocol) { return `${COMMON}\n\n${protocol}`; }

function buildSpec({ arm, round, protocol }) {
  const taskId = `ccexec-20260917-${arm.toLowerCase()}${String(round).padStart(2, '0')}`;
  return `// 设计2（${arm} 组第 ${round} 轮）：由 gen-exec-specs.mjs 生成，请勿手改。同臂各轮 prompt 逐字节相同。
export const task = {
  taskId: '${taskId}',
  kind: 'implement',
  title: '设计2 ${arm}${String(round).padStart(2, '0')}：三模块缺陷修复（执行判定）',
  refs: [],
  anchors: [
    { file: 'lib/index.js', pattern: 'const healthHeavyEmpty = () => ({', note: '仓库存在性锚点（仅用于门禁）' },
  ],
  acceptance: 'out/report.md 含三段 ===EXEC-FIX n BEGIN/END=== 块，块内为可 import 的完整模块源码且导出名不变；必须写 done.flag；不得改动仓库任何文件（写入范围为空）。',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  writeScope: [],
  prompt: \`${buildPrompt(protocol).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\`,
};
`;
}

const SPEC = 'D:\\dsh relay test\\cc-specs';
const pP = buildPrompt(PROTOCOL_P);
const pE = buildPrompt(PROTOCOL_E);
const items = [];
for (let r = 1; r <= N; r++) {
  const t = String(r).padStart(2, '0');
  fs.writeFileSync(`${SPEC}\\exec-p${t}.mjs`, buildSpec({ arm: 'P', round: r, protocol: PROTOCOL_P }), 'utf8');
  fs.writeFileSync(`${SPEC}\\exec-e${t}.mjs`, buildSpec({ arm: 'E', round: r, protocol: PROTOCOL_E }), 'utf8');
  // 交错排列，使两臂共享同一时间/配额压力
  items.push(`    { label: 'P 第 ${r} 轮（散文反证）', spec: 'cc-specs/exec-p${t}.mjs', taskId: 'ccexec-20260917-p${t}' },`);
  items.push(`    { label: 'E 第 ${r} 轮（可执行反例）', spec: 'cc-specs/exec-e${t}.mjs', taskId: 'ccexec-20260917-e${t}' },`);
}
fs.writeFileSync('D:\\dsh relay test\\cc-chains\\v8-exec.mjs',
  `// v8-exec 链条（由 gen-exec-specs.mjs 生成）：${N} 轮 × 2 臂 = ${items.length} 项，交错排列。\n` +
  `// 判定由隐藏探针**执行**给出（probes/run-probe.mjs），无模型裁判。\n` +
  `export const chain = {\n  id: 'v8-exec',\n  items: [\n${items.join('\n')}\n  ],\n};\n`, 'utf8');

fs.writeFileSync('D:\\cc-tasks\\exec-labels.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  question: '要求反证方提交**可执行反例**（E）是否比要求其写**散文批判**（P）产出更好的修复？',
  hypothesis: 'H1: E 组的隐藏探针通过率高于 P 组；H0: 无差异',
  primaryMetric: '隐藏探针通过率（每轮 3 案例 × 8 轮 = 24 次/臂），判定由执行给出',
  decisionRule: '仅当 E 通过率 > P 且置换检验 p<0.05 才判 E 更优；否则判"无可检出差异"',
  secondaryMetrics: ['E 组 NO_REPRO 出现次数（机制遵守度）', '两臂报告长度（风格对照）'],
  cases: [1, 2, 3].map((id) => ({ id, title: MODULES[id].title, exports: MODULES[id].exports, symptom: MODULES[id].symptom })),
  armPrompts: { P: pP.length, E: pE.length },
}, null, 2), 'utf8');

console.log(`  已生成 ${N} 轮 × 2 臂 = ${items.length} 份 spec + 链条 cc-chains/v8-exec.mjs`);
console.log(`  prompt 长度: P=${pP.length}  E=${pE.length}（差异 = 协议段）`);
console.log('  标签 → D:\\cc-tasks\\exec-labels.json');
