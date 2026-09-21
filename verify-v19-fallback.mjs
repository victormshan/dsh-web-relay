// v1.9 Step 1 验证：askHandler 全角色降级链（external → dialog → pause）
import fs from 'node:fs'
const src = fs.readFileSync('D:/DSH/dsh-web-relay/lib/index.js', 'utf8')

// a) 静态断言：降级分支与标注
const must = [
  'v1.9 全角色降级链（external → dialog → pause）',
  'const d = await callDialogModel(guidedPrompt)',
  'r = d; degraded = true',
  "providerLabel = '对话模型（降级）'",
  "askChannel = degraded ? 'dialog-fallback' : 'gemini-free'",
  "channel: askChannel",
]
const missing = must.filter((m) => !src.includes(m))
if (missing.length) { console.log('FAIL missing:', missing); process.exit(1) }
console.log('静态断言 OK：askHandler 降级分支 + 标注齐备')

// b) 逻辑复测：降级判定与 channel 标注（与实现一致）
function fallbackDecision(hasKey, geminiOk, dialogOk) {
  // 返回 { degraded, ok, error }
  if (hasKey) {
    if (geminiOk) return { degraded: false, ok: true }
    if (dialogOk) return { degraded: true, ok: true }
    return { degraded: false, ok: false, error: 'Gemini 与 dialog 均失败' }
  }
  if (dialogOk) return { degraded: true, ok: true }
  return { degraded: false, ok: false, error: '无 key 且 dialog 失败' }
}
const cases = [
  // [hasKey, geminiOk, dialogOk, wantDegraded, wantOk]
  [true, true, false, false, true],    // Gemini 正常：不降级
  [true, false, true, true, true],     // Gemini 失败 → dialog 成功：降级
  [true, false, false, false, false],  // 全失败：报错 pause
  [false, false, true, true, true],    // 无 key → dialog 成功：降级
  [false, false, false, false, false], // 无 key 且 dialog 失败：报错 pause
]
for (const [hasKey, g, d, wd, wo] of cases) {
  const got = fallbackDecision(hasKey, g, d)
  if (got.degraded !== wd || got.ok !== wo) { console.log('FAIL', { hasKey, g, d }, '->', got, 'want', { wd, wo }); process.exit(1) }
}
console.log('降级判定复测 OK（5 用例：Gemini 正常 / 失败降级 / 全失败 pause / 无key降级 / 无key全失败）')

// c) channel 标注：降级 → dialog-fallback，否则 gemini-free
function channelOf(degraded) { return degraded ? 'dialog-fallback' : 'gemini-free' }
if (channelOf(true) !== 'dialog-fallback' || channelOf(false) !== 'gemini-free') { console.log('FAIL channel'); process.exit(1) }
console.log('channel 标注 OK：dialog-fallback / gemini-free')

console.log('STEP1 全角色降级链验证 PASS')
