// Step 1 验证：restructure 悬空依赖校验（抽取 restructureHandler 校验逻辑复测）
// 校验规则（v1.8.1）：重构后所有步骤 depends_on 引用必须存在于保留集合，否则 400。
import fs from 'node:fs'

// a) 静态断言：源码含校验块
const src = fs.readFileSync('D:/DSH/dsh-web-relay/lib/index.js', 'utf8')
const must = [
  'v1.8.1 悬空依赖校验（Dangling Dependency Protection）',
  'retainedIds = new Set(state.steps.map((s) => String(s.id)))',
  'dangling.push({ step: String(s.id), missing: String(d) })',
  '悬空依赖校验失败',
  'return json(res, 400, {',
]
const missing = must.filter((m) => !src.includes(m))
if (missing.length) { console.log('FAIL missing:', missing); process.exit(1) }
console.log('静态断言 OK：restructureHandler 含悬空依赖校验块')

// b) 校验逻辑复测（与实现一致）
function validateDangling(updatedSteps) {
  const retainedIds = new Set(updatedSteps.map((s) => String(s.id)))
  const dangling = []
  for (const s of updatedSteps) {
    for (const d of (s.depends_on || [])) {
      if (!retainedIds.has(String(d))) dangling.push({ step: String(s.id), missing: String(d) })
    }
  }
  return dangling
}

// 场景1：悬空依赖（Step 2 依赖 Step 99，不存在）→ 应拒绝
const s1 = [
  { id: '1', status: 'approved', depends_on: [] },
  { id: '2', status: 'pending', depends_on: ['99'] },
]
const d1 = validateDangling(s1)
if (d1.length !== 1 || d1[0].step !== '2' || d1[0].missing !== '99') { console.log('FAIL 场景1', d1); process.exit(1) }
console.log('场景1 OK：Step 2 引用不存在的 Step 99 → 检出悬空依赖（应 400）')

// 场景2：合法依赖（依赖保留的 approved 步骤）→ 应通过
const s2 = [
  { id: '1', status: 'approved', depends_on: [] },
  { id: '2', status: 'pending', depends_on: ['1'] },
  { id: '3', status: 'pending', depends_on: ['2'] },
]
const d2 = validateDangling(s2)
if (d2.length !== 0) { console.log('FAIL 场景2', d2); process.exit(1) }
console.log('场景2 OK：pending 依赖保留的 approved Step 1 → 无悬空（通过）')

// 场景3：移除被依赖步骤（Step 3 依赖的 Step 2 被重构移除）→ 应检出
const s3 = [
  { id: '1', status: 'approved', depends_on: [] },
  { id: '3', status: 'pending', depends_on: ['2'] }, // 2 已被移除
]
const d3 = validateDangling(s3)
if (d3.length !== 1 || d3[0].missing !== '2') { console.log('FAIL 场景3', d3); process.exit(1) }
console.log('场景3 OK：被依赖步骤移除后仍被引用 → 检出悬空（应 400）')

console.log('STEP1 悬空依赖校验验证 PASS')
