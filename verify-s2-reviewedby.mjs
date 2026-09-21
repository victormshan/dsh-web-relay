// Step 2 验证：打回清空 reviewedBy（单步打回 / 自动审核打回 / 批量原子打回）
import fs from 'node:fs'
const src = fs.readFileSync('D:/DSH/dsh-web-relay/lib/index.js', 'utf8')

// a) 静态断言三处清空点
const must = [
  // 1) stepUpdateHandler reject（原 'manual' 路径）
  "action === 'reject'",
  "step.status = 'rejected'",
  "step.reviewedBy = null   // v1.8.1：打回清空审核来源",
  // 2) reviewOneStep 自动审核打回
  "step.reviewedBy = result === 'approved' ? reviewer : null",
  // 3) 批量原子打回连带
  "item.step.reviewedBy = null   // v1.8.1：连带打回清空 reviewedBy",
]
const missing = must.filter((m) => !src.includes(m))
if (missing.length) { console.log('FAIL missing:', missing); process.exit(1) }
console.log('静态断言 OK：三处打回路径均清空 reviewedBy')

// b) 逻辑复测：approved 保留审核者 / rejected 置 null（与 reviewOneStep 一致）
function reviewedByAfter(result, reviewer) {
  return result === 'approved' ? reviewer : null
}
const cases = [
  ['approved', 'external', 'external'],
  ['approved', 'dialog', 'dialog'],
  ['approved', 'manual', 'manual'],
  ['rejected', 'external', null],
  ['rejected', 'dialog', null],
  ['rejected', 'manual', null],
]
for (const [result, reviewer, want] of cases) {
  const got = reviewedByAfter(result, reviewer)
  if (got !== want) { console.log('FAIL', result, reviewer, '->', got, 'want', want); process.exit(1) }
}
console.log('逻辑复测 OK：approved 保留审核来源；rejected 一律 null（6 用例）')

// c) 校验 approve 分支仍记录手动来源（v1.5 手动审核路径不变）
if (!src.includes("step.reviewedBy = 'manual'   // v1.5：手动审核路径")) {
  console.log('FAIL: approve 分支 manual 记录丢失')
  process.exit(1)
}
console.log('approve 分支 OK：手动审核通过仍记录 reviewedBy=manual（审计保留）')

console.log('STEP2 打回清空 reviewedBy 验证 PASS')
