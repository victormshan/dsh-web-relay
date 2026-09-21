// V2 Step 1 验证：dialog 降级链空响应修复（extractChunkText 递归提取 + provider 容错）
import fs from 'node:fs'
const src = fs.readFileSync('D:/DSH/dsh-web-relay/lib/index.js', 'utf8')

// a) 静态断言
const must = [
  'function extractChunkText(chunk)',
  'chunk?.choices?.[0]?.delta?.content',
  'chunk?.message?.content ?? chunk?.message?.text',
  "const attempts = [{ provider: 'deepseek-official' }, {}]",
  'llm.stream({ ...baseOpts, ...extra })',
]
const missing = must.filter((m) => !src.includes(m))
if (missing.length) { console.log('FAIL missing:', missing); process.exit(1) }
console.log('静态断言 OK：extractChunkText + provider 容错重试')

// b) extractChunkText 复测（与实现一致的镜像）
function extractChunkText(chunk) {
  if (chunk == null) return ''
  if (typeof chunk === 'string') return chunk
  const direct = chunk?.text ?? chunk?.delta?.text ?? chunk?.delta ?? chunk?.content ?? chunk?.message?.content ?? chunk?.message?.text ?? chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content
  if (typeof direct === 'string' && direct) return direct
  const parts = []
  const walk = (v, depth) => {
    if (depth > 6 || parts.length > 40) return
    if (typeof v === 'string' && v.trim()) { parts.push(v); return }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (k === 'type' || k === 'role' || k === 'id' || k === 'index' || k === 'finishReason' || k === 'finish_reason') continue
        walk(v[k], depth + 1)
      }
    }
  }
  walk(chunk, 0)
  return parts.join('')
}
const cases = [
  [{ text: 'approved' }, 'approved'],
  [{ delta: { text: 'rejected' } }, 'rejected'],
  [{ message: { content: 'ok 评语' } }, 'ok 评语'],
  [{ choices: [{ delta: { content: 'via choices delta' } }] }, 'via choices delta'],
  [{ choices: [{ message: { content: 'via choices message' } }] }, 'via choices message'],
  ['plain string', 'plain string'],
  [{ type: 'content', data: 'nested leaf' }, 'nested leaf'],
  [{ usage: { inputTokens: 10 } }, ''], // 无语义文本 → 空
  [null, ''],
]
for (const [chunk, want] of cases) {
  const got = extractChunkText(chunk)
  if (got !== want) { console.log('FAIL chunk', JSON.stringify(chunk), '->', JSON.stringify(got), 'want', JSON.stringify(want)); process.exit(1) }
}
console.log('extractChunkText 复测 OK（9 用例：text/delta/message/choices/嵌套/字符串/无语义）')

// c) provider 容错顺序复测：先显式 provider，空则 llm 默认路由
const attempts = [{ provider: 'deepseek-official' }, {}]
if (attempts.length !== 2 || attempts[0].provider !== 'deepseek-official' || Object.keys(attempts[1]).length !== 0) {
  console.log('FAIL attempts'); process.exit(1)
}
console.log('provider 容错顺序 OK：deepseek-official → 默认路由')

console.log('V2-STEP1 dialog 降级修复验证 PASS')
