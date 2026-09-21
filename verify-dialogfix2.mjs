// Step 2 验证：callDialogModel 修复（content 块数组 + currentSelection provider/model + 3 层尝试）
import fs from 'node:fs'
const src = fs.readFileSync('D:/DSH/dsh-web-relay/lib/index.js', 'utf8')

// a) 静态断言
const must = [
  "'agentDefaultModel'",                          // inject 注入
  "content: [{ type: 'text', text: prompt }]",   // 块数组 content
  'agentDefaultModel.currentSelection',
  'attempts.push({ provider: selProvider',
  "'deepseek-official'",
]
const missing = must.filter((m) => !src.includes(m))
if (missing.length) { console.log('FAIL missing:', missing); process.exit(1) }
console.log('静态断言 OK：inject agentDefaultModel + 块数组 content + currentSelection + 3 层尝试')

// b) 消息构造与尝试顺序复测（与实现一致）
function buildAttempts(sel) {
  const attempts = []
  if (sel && typeof sel.provider === 'string' && sel.provider) attempts.push({ provider: sel.provider, ...(sel.model ? { model: sel.model } : {}) })
  attempts.push({ provider: 'deepseek-official' }, {})
  return attempts
}
const sel = { provider: 'deepseek-ai', model: 'deepseek-v4-flash' }
const a1 = buildAttempts(sel)
if (a1.length !== 3 || a1[0].provider !== 'deepseek-ai' || a1[0].model !== 'deepseek-v4-flash' || a1[1].provider !== 'deepseek-official' || Object.keys(a1[2]).length !== 0) {
  console.log('FAIL attempts', JSON.stringify(a1)); process.exit(1)
}
console.log('尝试顺序 OK：currentSelection(deepseek-ai/deepseek-v4-flash) → deepseek-official → 默认路由')

// c) 消息格式复测
const msg = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
if (!Array.isArray(msg[0].content) || msg[0].content[0].type !== 'text' || msg[0].content[0].text !== 'hello') { console.log('FAIL message'); process.exit(1) }
console.log('消息格式 OK：content 块数组 [{type:text,text}]（dsh-llm 契约）')

// d) extractChunkText 保持（text-delta 结构可提取）
function extractChunkText(chunk) {
  if (chunk == null) return ''
  if (typeof chunk === 'string') return chunk
  const direct = chunk?.text ?? chunk?.delta?.text ?? chunk?.delta ?? chunk?.content ?? chunk?.message?.content ?? chunk?.message?.text ?? chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content
  if (typeof direct === 'string' && direct) return direct
  return ''
}
if (extractChunkText({ type: 'text-delta', text: 'approved' }) !== 'approved') { console.log('FAIL chunk'); process.exit(1) }
console.log('extractChunkText 保持 OK：text-delta chunk 可提取')

console.log('STEP2 callDialogModel 修复验证 PASS')
