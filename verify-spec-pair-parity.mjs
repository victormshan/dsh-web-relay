// 通用「spec 对」不变量校验：两组 spec 的语料/约束段落必须逐字节相同，唯一变量只应是协议。
// 用法: node verify-spec-pair-parity.mjs <a.mjs> <b.mjs> [语料起点标记] [语料终点标记]
// 说明：本脚本是 verify-ab-spec-parity.mjs 的通用化版本（后者写死了 A/B 的标记），
//       用于同时守住 A/B 实验与生成类实验的「唯一变量」不变量。
import fs from 'node:fs';

// 协议段落起点标记（第 5 个参数）：不同实验的协议标题不同，**不得写死**——
// 上一版把 '【工作方式' 写死，导致同一脚本校验 A/B（协议标题为 '【评审协议'）时误报 FAIL。
const [aPath, bPath, beginMark = '================ 情境', endMark = '================ 情境结束', protoMark = '【工作方式'] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error('用法: node verify-spec-pair-parity.mjs <a.mjs> <b.mjs> [语料起点标记] [语料终点标记]');
  process.exit(2);
}
const read = (p) => fs.readFileSync(p, 'utf8');

// 语料段（含终点标记整段）
const corpus = (p) => {
  const s = read(p);
  const i = s.indexOf(beginMark);
  const j = s.indexOf(endMark);
  if (i < 0 || j < 0) return null;
  return s.slice(i, j + endMark.length);
};
// 协议之前（从 prompt 正文开始，避开允许不同的 taskId/title/头注释）
const common = (p) => {
  const s = read(p);
  const i = s.indexOf('你是 dsh-web-relay 项目');
  const j = s.indexOf(protoMark);
  return i < 0 || j < 0 ? null : s.slice(i, j);
};
// 语料及其后（报告要求等）
const tail = (p) => {
  const s = read(p);
  const i = s.indexOf(beginMark);
  return i < 0 ? null : s.slice(i);
};

const cA = corpus(aPath);
const cB = corpus(bPath);
const kA = common(aPath);
const kB = common(bPath);
const tA = tail(aPath);
const tB = tail(bPath);

const rows = [
  ['语料段落逐字节相同', cA !== null && cA === cB, `${cA ? cA.length : 'null'} B vs ${cB ? cB.length : 'null'} B`],
  ['协议前共通段逐字节相同', kA !== null && kA === kB, `${kA ? kA.length : 'null'} B vs ${kB ? kB.length : 'null'} B`],
  ['语料及其后逐字节相同', tA !== null && tA === tB, `${tA ? tA.length : 'null'} B vs ${tB ? tB.length : 'null'} B`],
];
let bad = 0;
for (const [name, ok, detail] of rows) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}（${detail}）`);
  if (!ok) bad++;
}
console.log(`  → ${bad ? '不变量被破坏，实验不可比' : '唯一变量确认只有协议段落'}`);
process.exit(bad ? 1 : 0);
