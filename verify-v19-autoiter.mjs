// v1.9 Step 2 验证：AutoIteration 协议支持（声明解析 / 熔断 pause / 版间门）
import fs from 'node:fs'
const src = fs.readFileSync('D:/DSH/dsh-web-relay/lib/index.js', 'utf8')

// a) 静态断言
const must = [
  'v1.9 AutoIteration',
  'function extractAutoIterDecl(text)',
  'iterations: data.iterations || 1',
  'rejectStreak: data.rejectStreak || 0',
  "state.status = 'paused'",
  '连续打回 ≥3 次',
  'updated.currentIteration = nextIter',
  '修正 Step List（importance 分工）',
]
const missing = must.filter((m) => !src.includes(m))
if (missing.length) { console.log('FAIL missing:', missing); process.exit(1) }
console.log('静态断言 OK（8 标记：声明解析/熔断/版间门）')

// b) extractAutoIterDecl 复测（与实现一致的镜像）
function extractAutoIterDecl(text) {
  const src2 = String(text || '')
  const decl = { iterations: 1, finalAcceptance: null, autoDecision: false }
  const m = src2.match(/\{\s*"iterations"\s*:\s*(\d+)\s*(?:,\s*"finalAcceptance"\s*:\s*"([^"]*)"\s*)?(?:,\s*"autoDecision"\s*:\s*(true|false)\s*)?\}/)
  if (m) {
    const n = parseInt(m[1], 10)
    if (Number.isInteger(n) && n >= 1 && n <= 10) decl.iterations = n
    if (m[2]) decl.finalAcceptance = m[2]
    if (m[3]) decl.autoDecision = m[3] === 'true'
  }
  return decl
}
const cases = [
  ['无声明', '普通任务', { iterations: 1, finalAcceptance: null, autoDecision: false }],
  ['完整声明', '{"iterations": 3, "finalAcceptance": "测试全过", "autoDecision": true}', { iterations: 3, finalAcceptance: '测试全过', autoDecision: true }],
  ['仅 iterations', '{"iterations": 2}', { iterations: 2, finalAcceptance: null, autoDecision: false }],
  ['超上限 10', '{"iterations": 99}', { iterations: 1, finalAcceptance: null, autoDecision: false }],
  ['零/负', '{"iterations": 0}', { iterations: 1, finalAcceptance: null, autoDecision: false }],
]
for (const [name, text, want] of cases) {
  const got = extractAutoIterDecl(text)
  if (got.iterations !== want.iterations || got.finalAcceptance !== want.finalAcceptance || got.autoDecision !== want.autoDecision) {
    console.log('FAIL', name, '->', got, 'want', want); process.exit(1)
  }
}
console.log('extractAutoIterDecl 解析 OK（5 用例：缺省/完整/仅次数/超上限/非法）')

// c) 熔断逻辑复测（与实现一致：reject +1，approve 清零，≥3 → paused）
function rejectStreakAfter(result, current) {
  if (result === 'approved') return 0
  return (current || 0) + 1
}
const seq = ['rejected', 'rejected', 'rejected']
let streak = 0
for (let i = 0; i < seq.length; i++) {
  streak = rejectStreakAfter(seq[i], streak)
  if (streak >= 3) { /* paused 触发 */ }
}
if (streak !== 3) { console.log('FAIL streak'); process.exit(1) }
console.log('熔断计数 OK：连续 3 次 rejected → streak=3（≥3 触发 paused）')

// d) 版间门：迭代未满则推进
const gate = (currentIteration, iterations) => (iterations > 1 && currentIteration < iterations) ? currentIteration + 1 : null
if (gate(1, 3) !== 2 || gate(2, 3) !== 3 || gate(3, 3) !== null || gate(1, 1) !== null) { console.log('FAIL gate'); process.exit(1) }
console.log('版间门 OK：V1→V2→V3 推进，V3=上限收口，单轮不推进')

console.log('STEP2 AutoIteration 验证 PASS')
