// 独立裁判：把两臂在 specific 两例上的答案**匿名化**后交给外部 AI（/ask，不吃 cc 配额）盲评。
// 目的：token 匹配器已实测产生假阴性（S 案例2、D 案例1/2 均属语义命中却判 ✗），
//       故需要一台与被测执行体独立的"仪器"来校准——否则等于用坏尺子量长度还照数字下结论。
// 纪律：① 匿名化（裁判不知道哪份属哪臂）；② 裁判只拿到 ground truth 与答案，不拿到假设方向；
//       ③ 结果作为**事后敏感性分析**，不替换预登记指标，两者分歧照实报。
import fs from 'node:fs';

const CC = 'D:\\cc-tasks';
const labels = JSON.parse(fs.readFileSync(CC + '\\genexp-labels.json', 'utf8'));

const readAlt = (taskId) => {
  const p = `${CC}\\tasks\\${taskId}\\out\\report.md`;
  const t = fs.readFileSync(p, 'utf8');
  const a = t.indexOf('GEN-RESULT-BEGIN');
  const b = t.indexOf('GEN-RESULT-END');
  const block = t.slice(a, b);
  const out = new Map();
  for (const part of block.split(/CASE\s*(\d+)\s*[:：]/).slice(1).reduce((acc, _, i, arr) => (i % 2 === 0 ? [...acc, [arr[i], arr[i + 1]]] : acc), [])) {
    const id = Number(part[0]);
    const alt = (part[1].match(/ALTERNATIVE\s*[:：]\s*([^\n]*)/i) || [, ''])[1].trim();
    const risk = (part[1].match(/RISK\s*[:：]\s*([^\n]*)/i) || [, ''])[1].trim();
    out.set(id, { alt, risk });
  }
  return out;
};

const S = readAlt('ccgen-20260916-prop-s');
const D = readAlt('ccgen-20260916-prop-d');

// 匿名化：同一案例内的两份答案随机顺序（映射记录在案，不告知裁判）
const specific = labels.cases.filter((c) => c.genericity === 'specific');
const mapping = [];
const blocks = specific.map((c) => {
  const pairs = [
    { arm: 'S', ...S.get(c.id) },
    { arm: 'D', ...D.get(c.id) },
  ];
  // 交替顺序，避免"总是第一份"的偏置
  const ordered = c.id % 2 === 0 ? [pairs[1], pairs[0]] : pairs;
  const tags = ['甲', '乙'];
  const lines = ordered.map((p, i) => {
    mapping.push({ caseId: c.id, tag: tags[i], arm: p.arm });
    return `【案例 ${c.id} · 答案${tags[i]}】\n  推荐做法：${p.alt}\n  自述最可能失效之处：${p.risk}`;
  });
  return `=== 案例 ${c.id}：${c.title} ===\n【该情境下"经事件验证过的关键洞察"（评分基准，请只据此评分）】\n${c.truth}\n\n${lines.join('\n\n')}`;
});

const prompt = `你是独立的方案评审裁判。下面给出 2 个工程情境，每个情境有 2 份匿名答案（甲/乙），以及该情境下"经事后事件验证过的关键洞察"作为评分基准。

请对**每一份答案**判定：它是否抓住了该基准中的**关键洞察**（0=未抓住 / 1=抓住）。标准从严：只有实质命中才算 1，措辞不同但语义等价应算 1，泛泛而谈（如"要注意一致性"）算 0。

${blocks.join('\n\n')}

【输出格式（严格，逐行，勿加其它内容）】
CASE 1 甲: 0|1 | 理由=<一句话>
CASE 1 乙: 0|1 | 理由=<一句话>
CASE 2 甲: 0|1 | 理由=<一句话>
CASE 2 乙: 0|1 | 理由=<一句话>

最后一行给出：VERDICT: <两案例合计，甲得分 vs 乙得分>`;

fs.writeFileSync(CC + '\\judge-prompt.txt', prompt, 'utf8');
fs.writeFileSync(CC + '\\judge-mapping.json', JSON.stringify({ mapping, note: '映射不告知裁判；用于事后把甲/乙还原成 S/D' }, null, 2), 'utf8');
console.log(`  已生成裁判提示词（${Buffer.byteLength(prompt, 'utf8')} 字节）与匿名映射`);
console.log('  匿名映射（不外泄）：' + mapping.map((m) => `案例${m.caseId}-${m.tag}=${m.arm}`).join('  '));
