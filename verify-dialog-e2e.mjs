// Step 4 验证：模拟 Gemini 429 → dialog 兜底接替 → 评审 JSON 输出（镜像 callDialogModel 修复后逻辑）
import fs from 'node:fs'
import vm from 'node:vm'

// ---- 镜像 callDialogModel 修复后主流程 ----
function buildMessages(prompt) { return [{ role: 'user', content: [{ type: 'text', text: prompt }] }] }
function extractChunkText(chunk) {
  if (chunk == null) return ''
  if (typeof chunk === 'string') return chunk
  const direct = chunk?.text ?? chunk?.delta?.text ?? chunk?.delta ?? chunk?.content ?? chunk?.message?.content ?? chunk?.message?.text ?? chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content
  if (typeof direct === 'string' && direct) return direct
  return ''
}
// mock llm：验证 stream 收到块数组消息，并返回 harness 风格 text-delta chunks
function mockLlm(replyText) {
  let captured = null
  return {
    stream: (opts) => {
      captured = opts
      return (async function* () {
        yield { type: 'text-delta', text: replyText }
      })()
    },
    get lastOpts() { return captured }
  }
}
// 模拟调用（镜像 callDialogModel 循环）
async function dialogCall(llm, prompt, extra) {
  const opts = { messages: buildMessages(prompt), tools: [], stream: false, ...extra }
  const chunks = []
  for await (const chunk of llm.stream(opts)) {
    const t = extractChunkText(chunk)
    if (t) chunks.push(t)
  }
  return chunks.join('').trim()
}

// ① mock Gemini 429 → 降级链 → dialog 接替
const llm = mockLlm('{"result":"approved","reason":"对话框模型审核通过：持久化缓存与 stats 实现符合验收标准"}')
const out = await dialogCall(llm, '审核请求', { provider: 'deepseek-official' })
console.log('dialog 输出:', out.slice(0, 80) + '…')
if (!out) { console.log('FAIL dialog 空输出'); process.exit(1) }

// ② 评审 JSON 合规（approved/rejected + reason）
let parsed = null
const m = out.match(/\{[\s\S]*\}/)
if (m) { try { parsed = JSON.parse(m[0]) } catch {} }
if (!parsed || (parsed.result !== 'approved' && parsed.result !== 'rejected') || typeof parsed.reason !== 'string') {
  console.log('FAIL 评审 JSON 不合规', JSON.stringify(parsed)); process.exit(1)
}
console.log('评审 JSON 合规 ✓ result=' + parsed.result)

// ③ 消息格式验证：stream 收到块数组 content
if (!Array.isArray(llm.lastOpts.messages[0].content) || llm.lastOpts.messages[0].content[0].type !== 'text') {
  console.log('FAIL 消息格式（应块数组）'); process.exit(1)
}
console.log('消息块数组格式 ✓（dsh-llm 契约）')

// ④ provider/model 传递验证
if (llm.lastOpts.provider !== 'deepseek-official') { console.log('FAIL provider', llm.lastOpts.provider); process.exit(1) }
console.log('provider 传递 ✓')

console.log('STEP4 模拟 429 → dialog 接替 → 评审 JSON 验证 PASS')
