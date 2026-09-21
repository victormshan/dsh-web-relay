// 修复被诊断模式污染的 chain-state.chainId，并验证诊断模式不再改写归属
import fs from 'node:fs';
import path from 'node:path';

const CC = 'D:\\cc-tasks';
const STATE = path.join(CC, 'chain-state.json');
const BAK = path.join(CC, 'chain-state.v1-v3.json');
const A4B_LABEL = 'A4b /health-check 接线 ccChainStats + 自检契约 + 文档 + 耗时实测';

const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
console.log('=== 修复前 ===');
console.log(`  chainId=${s.chainId} index=${s.index} completedAt=${s.completedAt}`);
const keys = Object.keys(s.items || {});
console.log(`  item 键=${keys.join(' | ')}`);

if (s.chainId !== 'v4-a4b' && keys.includes(A4B_LABEL)) {
  s.chainId = 'v4-a4b';
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8');
  console.log('  → 已把 chainId 修正回 v4-a4b（项与 index 本就是 v4-a4b 的，仅归属被写错）');
} else {
  console.log('  → 无需修复');
}

const after = JSON.parse(fs.readFileSync(STATE, 'utf8'));
console.log('=== 修复后 ===');
console.log(`  chainId=${after.chainId} index=${after.index} completedAt=${after.completedAt}`);

console.log('=== 备份文件是否完好（换链条未发生，故不该被覆盖）===');
if (fs.existsSync(BAK)) {
  const b = JSON.parse(fs.readFileSync(BAK, 'utf8'));
  console.log(`  chain-state.v1-v3.json: chainId=${b.chainId} index=${b.index} completedAt=${b.completedAt} 项数=${Object.keys(b.items || {}).length}`);
} else {
  console.log('  缺失 chain-state.v1-v3.json');
}
