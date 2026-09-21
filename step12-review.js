// 主 agent：Step 1/2 完成 → review + 写轨迹
const fs = require('fs')
const base = 'D:/dsh relay test'
const exprId = 'expr-2026-08-25_02-09-32'
const now = new Date().toISOString()

const p = `${base}/web-relay/experiments/${exprId}.steps.json`
const st = JSON.parse(fs.readFileSync(p, 'utf8'))
for (const s of st.steps) {
  if (s.id === '1' || s.id === '2') {
    s.status = 'review'
    s.notes = s.notes || []
    s.notes.push({ role: 'mainagent', at: now, action: 'complete', text: `Step ${s.id} 完成（并行 subagent），提交审核` })
  }
}
st.updatedAt = now
fs.writeFileSync(p, JSON.stringify(st, null, 2), 'utf8')
console.log('Step 1/2 → review')

const tp = `${base}/web-relay/traces/${exprId}.md`
let t = fs.readFileSync(tp, 'utf8')
const entry = `## [主 agent] ${now}

Step 1 执行完成（后端费用解析与统计 API）—— PASS
- step-value/lib/index.js（516 行）：三 API（/summary /tree /step-details）+ 价格表（MODEL_PRICES 按 DeepSeek 官方定价 USD/1K + USD_TO_CNY=7.2）
- 解析 ~/.dsh/sessions 下 session.jsonl.zstd（多帧 zstd + JSONL），提取 assistant/message 的 usage/model/turn，60s 缓存
- 真实验证：工作区解码正确；604 个 turn；样例 turn=1 step=1 deepseek-v4-flash costUSD=0.002457；全局 4 工作区 27 会话 3800 turns totalCostUSD=87.37

Step 2 执行完成（i18n 词汇表）—— PASS
- step-value/lib/i18n.js：zh/en 29 键完全对称，区分 API Turn 与 Task Step

v1.6 并发：Step 1/2（组 step_value_prep）由 2 个并行 subagent 完成，提交审核。`
t = t.trimEnd() + '\n\n' + entry + '\n'
fs.writeFileSync(tp, t, 'utf8')
console.log('轨迹已写')
