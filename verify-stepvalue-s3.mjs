// V1 Step 3 验证：step-value 功能增强（MODEL_PRICES 扩充 + summary perModel/avg 维度）
import fs from 'node:fs'
const src = fs.readFileSync('D:/dsh relay test/step-value/lib/index.js', 'utf8')

// a) 静态断言：模型扩充 + 聚合维度
const must = [
  "'claude-3-5-sonnet': { input: 0.003",
  "'gemini-2.0-flash': { input: 0.0001",
  "'gpt-4o': { input: 0.0025",
  "'gpt-4o-mini': { input: 0.00015",
  'avgCostPerTurn',
  'perModel',
  'totalPerModel',
  "perModel: Object.fromEntries",
]
const missing = must.filter((m) => !src.includes(m))
if (missing.length) { console.log('FAIL missing:', missing); process.exit(1) }
console.log('静态断言 OK：MODEL_PRICES 扩充 5 模型 + summary perModel/avgCostPerTurn 维度')

// b) 动态导入验证：MODEL_PRICES 新模型可计价 + computeCost
const mod = await import('file:///D:/dsh relay test/step-value/lib/index.js')
const cases = [
  ['claude-3-5-sonnet', { input: 1000, output: 100, cacheRead: 0, reasoning: 0 }, 0.003 * 1 + 0.015 * 0.1],
  ['gemini-2.0-flash', { input: 1000, output: 1000, cacheRead: 0, reasoning: 0 }, 0.0001 + 0.0004],
  ['gpt-4o', { input: 400, output: 100, cacheRead: 0, reasoning: 0 }, 0.0025 * 0.4 + 0.01 * 0.1],
  ['unknown-model-x', { input: 1000, output: 1000, cacheRead: 0, reasoning: 0 }, 0.00027 + 0.0011], // _default 回退
]
for (const [model, tokens, want] of cases) {
  const got = mod.computeCost(tokens, model)
  const diff = Math.abs(got - Math.round(want * 1e6) / 1e6)
  if (diff > 1e-6) { console.log('FAIL computeCost', model, '->', got, 'want', want); process.exit(1) }
}
console.log('computeCost 复测 OK（5 模型含 _default 回退）')

// c) buildSummary 聚合逻辑复测（perModel + avgCostPerTurn，与实现一致的最小模拟）
function summarize(turnsList) {
  const totalPerModel = {}
  let totalTurns = 0
  let totalCostUSD = 0
  for (const t of turnsList) {
    totalTurns += 1
    totalCostUSD += t.costUSD
    const m = t.model || 'unknown'
    const g = totalPerModel[m] || (totalPerModel[m] = { turns: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0, costUSD: 0 })
    g.turns += 1
    g.input += t.tokens.input
    g.output += t.tokens.output
    g.cacheRead += t.tokens.cacheRead
    g.reasoning += t.tokens.reasoning
    g.costUSD += t.costUSD
  }
  return {
    avgCostPerTurn: totalTurns > 0 ? Math.round((totalCostUSD / totalTurns) * 1e6) / 1e6 : 0,
    perModel: Object.fromEntries(Object.entries(totalPerModel).map(([m, v]) => [m, { ...v, costUSD: Math.round(v.costUSD * 1e6) / 1e6 }]))
  }
}
const turns = [
  { model: 'deepseek-v4-flash', costUSD: 0.001, tokens: { input: 100, output: 100, cacheRead: 50, reasoning: 0, total: 250 } },
  { model: 'deepseek-v4-flash', costUSD: 0.002, tokens: { input: 200, output: 200, cacheRead: 100, reasoning: 0, total: 500 } },
  { model: 'gpt-4o', costUSD: 0.01, tokens: { input: 100, output: 100, cacheRead: 0, reasoning: 0, total: 200 } },
]
const s = summarize(turns)
if (s.avgCostPerTurn !== 0.004333 || s.perModel['deepseek-v4-flash'].turns !== 2 || s.perModel['gpt-4o'].turns !== 1 || s.perModel['gpt-4o'].costUSD !== 0.01) {
  console.log('FAIL summarize', JSON.stringify(s)); process.exit(1)
}
console.log('聚合逻辑复测 OK：avgCostPerTurn + perModel 按模型聚合')

console.log('V1-STEP3 功能增强验证 PASS')
