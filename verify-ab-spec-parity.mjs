// 守不变量：两组 spec 的**语料段落**必须逐字节相同（唯一变量只应是协议）
import fs from 'node:fs';

const grab = (p) => {
  const s = fs.readFileSync(p, 'utf8');
  const a = s.indexOf('================ 草稿语料');
  const b = s.indexOf('================ 语料结束');
  if (a < 0 || b < 0) return null;
  return s.slice(a, b + '================ 语料结束 ================'.length);
};

const A = grab('D:\\dsh relay test\\cc-specs\\ab-review-a.mjs');
const B = grab('D:\\dsh relay test\\cc-specs\\ab-review-b.mjs');
console.log(`  语料段落: A=${A ? A.length : 'null'} 字节  B=${B ? B.length : 'null'} 字节`);
console.log(`  逐字节相同 = ${A === B ? 'YES' : 'NO'}`);

// 也校验「约束/输出格式」共通段相同——注意：必须从 prompt 正文开始切片，
// 不能从文件开头（那会包含本就允许不同的 taskId / title / 头部注释）。上一版正是这么错的。
const common = (p) => {
  const s = fs.readFileSync(p, 'utf8');
  const start = s.indexOf('你是 dsh-web-relay 项目的');
  const i = s.indexOf('【评审协议');
  return start < 0 || i < 0 ? null : s.slice(start, i);
};
const cA = common('D:\\dsh relay test\\cc-specs\\ab-review-a.mjs');
const cB = common('D:\\dsh relay test\\cc-specs\\ab-review-b.mjs');
console.log(`  协议之前的共通段逐字节相同 = ${cA === cB ? 'YES' : 'NO'}（${cA ? cA.length : '?'} 字节）`);

// 协议之后到报告要求的部分也应相同
const tail = (p) => {
  const s = fs.readFileSync(p, 'utf8');
  const i = s.indexOf('================ 草稿语料');
  return i < 0 ? null : s.slice(i);
};
console.log(`  语料及其后逐字节相同 = ${tail('D:\\dsh relay test\\cc-specs\\ab-review-a.mjs') === tail('D:\\dsh relay test\\cc-specs\\ab-review-b.mjs') ? 'YES' : 'NO'}`);

process.exit(A === B && cA === cB ? 0 : 1);
