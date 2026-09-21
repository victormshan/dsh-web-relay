// 修正 registry.yaml 中无法被 verify-capabilities.mjs 正确解析的转义引号断言：
//   text: "\"compat\""  →  text: harnessLine
// 原因：该校验脚本的 YAML 解析不处理转义引号，会把断言读成单个反斜杠。
import fs from 'node:fs';

const target = 'D:/dsh-web-relay/docs/capabilities/registry.yaml';
const from = 'text: "\\"compat\\""';
const to = 'text: harnessLine';

let cur = fs.readFileSync(target, 'utf8');
if (!cur.includes(from)) {
  console.log('PATTERN-NOT-FOUND — 无需修正（或已被修过）');
  process.exit(0);
}
cur = cur.replace(from, to);
fs.writeFileSync(target, cur, 'utf8');
console.log(`fixed: ${from} -> ${to}`);
