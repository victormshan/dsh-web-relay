// 变异验证：把 sliceHandlerSource 的 lastIndexOf 临时改回缺陷版 indexOf，
// 确认新增的「端到端契约」测试**确实会失败**（证明它是有效守卫而非摆设），随后必定还原。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const FILE = 'D:/dsh-web-relay/lib/selfcheck.mjs';
const original = fs.readFileSync(FILE, 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const before = sha(original);

const MUT = 's.lastIndexOf(defAnchor)';
const BUG = 's.indexOf(defAnchor)';
if (!original.includes(MUT)) { console.error('未找到待变异的片段，脚本需更新'); process.exit(2); }

let mutatedFailed = null;
try {
  fs.writeFileSync(FILE, original.replace(MUT, BUG), 'utf8');
  console.log('  [变异] 已把 lastIndexOf 改为 indexOf（复原缺陷形态）');
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'D:/dsh-web-relay/test/selfcheck.test.js'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const failMatch = /# fail (\d+)/.exec(out);
  const passMatch = /# pass (\d+)/.exec(out);
  const failedNames = out.split('\n').filter((l) => l.startsWith('not ok')).map((l) => l.trim());
  mutatedFailed = { exit: r.status, pass: passMatch ? passMatch[1] : '?', fail: failMatch ? failMatch[1] : '?', failedNames };
  console.log(`  [变异] 结果: exit=${r.status} pass=${mutatedFailed.pass} fail=${mutatedFailed.fail}`);
  for (const n of failedNames.slice(0, 4)) console.log('    ' + n.slice(0, 120));
} finally {
  fs.writeFileSync(FILE, original, 'utf8');
  const after = sha(fs.readFileSync(FILE, 'utf8'));
  console.log(`  [还原] sha ${before} → ${after} → ${before === after ? '一致 ✅' : '不一致 ❌'}`);
}

console.log('\n  === 结论 ===');
// 有效守卫 = 变异成缺陷实现后，**至少有一条守卫用例失败**。
// 注意：端到端契约用例（对真实 lib/index.js）在本次修复后**不会**因该变异而失败——
// 因为切片逻辑已搬离 lib/index.js，真实文件里不再有「锚点字面量」这个 decoy（这是根因层面的消除）。
// 真正对该变异敏感的是「切片守卫」用例（合成 decoy+真实定义）。两者职责不同，别混淆。
const failedNames = (mutatedFailed && mutatedFailed.failedNames) || [];
const selfMatchGuard = failedNames.some((n) => n.includes('切片守卫'));
const e2eGuard = failedNames.some((n) => n.includes('端到端契约'));
console.log(`  「切片守卫」是否捕获该变异 → ${selfMatchGuard ? '是 ✅' : '否 ❌'}`);
console.log(`  「端到端契约」是否捕获该变异 → ${e2eGuard ? '是' : '否（预期，真实文件已无 decoy；它守的是字段漂移/改名）'}`);
console.log(`  变异版总体: exit=${mutatedFailed ? mutatedFailed.exit : '?'} pass=${mutatedFailed ? mutatedFailed.pass : '?'} fail=${mutatedFailed ? mutatedFailed.fail : '?'}`);
const ok = selfMatchGuard && mutatedFailed && mutatedFailed.fail !== '0';
console.log(`  RESULT: ${ok ? 'PASS（守卫有效，且已自动还原）' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
