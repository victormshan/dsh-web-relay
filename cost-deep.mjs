// 精细实测：step-value 开发阶段（expr-2026-08-25_02-09-32）的成本拆解
import { parseSessionLog } from 'file:///D:/dsh relay test/step-value/lib/index.js'

const logPath = 'C:/Users/Administrator/.dsh/sessions/--D-dsh~0020relay~0020test--/session-a0a01dfa-1c88-4c91-8cbd-25b4d70274c2/session.jsonl.zstd'
const session = await parseSessionLog(logPath, { maxFrames: 0, maxBytes: 0 })
const turns = session.turnsList

// step-value 开发阶段：2026-08-25T02:09:32 (任务创建) 到 02:31:43 (finalize)
// turn.time 是毫秒时间戳
const tStart = Date.parse('2026-08-25T02:09:32Z')
const tEnd = Date.parse('2026-08-25T02:31:43Z')
const dev = turns.filter((t) => t.time >= tStart && t.time <= tEnd)
console.log('step-value 开发阶段 turns:', dev.length)

let cost = 0, inp = 0, out = 0, cache = 0, reason = 0
for (const t of dev) { cost += t.costUSD || 0; inp += t.tokens?.input || 0; out += t.tokens?.output || 0; cache += t.tokens?.cacheRead || 0; reason += t.tokens?.reasoning || 0 }
console.log(`阶段成本: $${cost.toFixed(6)} (CNY ${(cost*7.2).toFixed(4)}) | input=${inp} output=${out} cacheRead=${cache} reasoning=${reason}`)

// 找含"打回/重提"关键词的 turn（审核/重提轮次）
const rejTurns = turns.filter((t) => t.time >= tStart && t.time <= tEnd + 600000)
// 用消息内容？turnsList 不含 text。改为按时间窗粗分：
// 审核发生在 02:20-02:22（Step1/2 打回+重提）、02:26-02:27（Step3 审核）、02:31（Step4+finalize）
const buckets = [
  ['Step1/2 打回重提 (02:19-02:23)', 1787696340000, 1787696580000], // 02:19:00-02:23:00
  ['Step2 重提+审核 (02:21-02:25)', 1787696460000, 1787696700000],
  ['Step3 审核 (02:26-02:28)', 1787696760000, 1787696880000],
  ['Step4+finalize (02:28-02:32)', 1787696880000, 1787697120000],
]
for (const [name, a, b] of buckets) {
  const seg = turns.filter((t) => t.time >= a && t.time <= b)
  let c = 0, n = 0
  for (const t of seg) { c += t.costUSD || 0; n++ }
  console.log(`${name}: ${n} turns, $${c.toFixed(6)}`)
}

// 大 input turn（打包/重提轮次，input 最高）
const sorted = dev.slice().sort((a, b) => (b.tokens?.input || 0) - (a.tokens?.input || 0))
console.log('\n=== 开发阶段 input 最大的 8 个 turn ===')
for (const t of sorted.slice(0, 8)) {
  console.log(`turn=${t.turn} step=${t.step} input=${t.tokens?.input} out=${t.tokens?.output} cache=${t.tokens?.cacheRead} reason=${t.tokens?.reasoning} cost=$${(t.costUSD||0).toFixed(6)} time=${new Date(t.time).toISOString().slice(11,19)}`)
}
