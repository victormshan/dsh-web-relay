// 用 step-value 解析本次会话（step-value 开发全过程）的开销分布
import { parseSessionLog } from 'file:///D:/dsh relay test/step-value/lib/index.js'

const logPath = 'C:/Users/Administrator/.dsh/sessions/--D-dsh~0020relay~0020test--/session-a0a01dfa-1c88-4c91-8cbd-25b4d70274c2/session.jsonl.zstd'
const session = await parseSessionLog(logPath, { maxFrames: 0, maxBytes: 0 })
const turns = session.turnsList
console.log('会话:', session.title || session.id, '| turns:', turns.length)

// 聚合
let totalIn = 0, totalOut = 0, totalCache = 0, totalReason = 0, totalCost = 0
const byTurn = new Map()
for (const t of turns) {
  totalIn += t.tokens?.input || 0
  totalOut += t.tokens?.output || 0
  totalCache += t.tokens?.cacheRead || 0
  totalReason += t.tokens?.reasoning || 0
  totalCost += t.costUSD || 0
  const k = t.turn ?? '?'
  if (!byTurn.has(k)) byTurn.set(k, { in: 0, out: 0, cache: 0, reason: 0, cost: 0, steps: 0 })
  const b = byTurn.get(k)
  b.in += t.tokens?.input || 0; b.out += t.tokens?.output || 0; b.cache += t.tokens?.cacheRead || 0
  b.reason += t.tokens?.reasoning || 0; b.cost += t.costUSD || 0; b.steps++
}
console.log(`\n=== 总开销 ===`)
console.log(`tokens: input=${totalIn} output=${totalOut} cacheRead=${totalCache} reasoning=${totalReason}`)
console.log(`costUSD=${totalCost.toFixed(6)} costCNY=${(totalCost * 7.2).toFixed(6)}`)
console.log(`\n=== 每 Turn 开销（前 25 个 turn）===`)
const sorted = [...byTurn.entries()].sort((a, b) => b[1].cost - a[1].cost)
console.log('Turn | steps | in | out | cache | reason | costUSD')
for (const [k, b] of sorted.slice(0, 25)) {
  console.log(`${String(k).padEnd(5)}| ${String(b.steps).padEnd(5)}| ${String(b.in).padEnd(8)}| ${String(b.out).padEnd(8)}| ${String(b.cache).padEnd(8)}| ${String(b.reason).padEnd(8)}| ${b.cost.toFixed(6)}`)
}
// cacheRead 占比
console.log(`\ncacheRead 占总 token: ${((totalCache / (totalIn + totalOut + totalCache + totalReason || 1)) * 100).toFixed(1)}%`)
console.log(`reasoning 占比: ${((totalReason / (totalIn + totalOut + totalCache + totalReason || 1)) * 100).toFixed(1)}%`)
console.log(`output 占比: ${((totalOut / (totalIn + totalOut + totalCache + totalReason || 1)) * 100).toFixed(1)}%`)
