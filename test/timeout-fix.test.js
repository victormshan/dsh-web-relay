import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '..', 'lib', 'index.js'), 'utf8')
// v4.12.3: 超时链的纯函数在 bridge-poll.js（按长度缩放），断言那里比匹配 index.js 字面量可靠
const bridgePollSrc = readFileSync(join(__dirname, '..', 'lib', 'bridge-poll.js'), 'utf8')

test('v3.2.6: dialog 通道超时 60s → 300s（长回答不再被 abort 截断）', () => {
  const m = src.match(/signal: AbortSignal\.timeout\((\d+)\)[\s\S]{0,120}?v3\.2\.6: 长回答根治/)
  // 直接检查 callDialogModel 的 baseOpts 超时
  const dialogBlock = src.match(/async function callDialogModel\(prompt\)[\s\S]{0,1200}?AbortSignal\.timeout\((\d+)\)/)
  assert.ok(dialogBlock, 'callDialogModel 中应存在 AbortSignal.timeout')
  assert.equal(Number(dialogBlock[1]), 300000, 'dialog 通道超时应为 300000ms（5 分钟）')
})

test('v3.2.6: claude 通道超时 120s → 300s', () => {
  const claudeBlock = src.match(/provider: 'anthropic'[\s\S]{0,600}?AbortSignal\.timeout\((\d+)\)/)
  assert.ok(claudeBlock, 'claude 通道应存在 AbortSignal.timeout')
  assert.equal(Number(claudeBlock[1]), 300000, 'claude 通道超时应为 300000ms（5 分钟）')
})

// v4.12.3（2026-10-05 review-gate 交接 §3）修订说明——**旧断言为何不再成立**：
//   旧断言匹配源码字面量 `async function webGeminiAsk(prompt, timeoutMs = 300000)`。
//   本次改动把整体 deadline 改为**按提示长度缩放**（`bridgeDeadlineMsFor(len)`，其默认下限仍是 300000），
//   参数 `timeoutMs` 因此成为死参数并已移除 ⇒ 字面签名不复存在。
//   语义没有被削弱，反而更强：不再允许调用方传一个比扩展能等时长更短的 deadline。
//   故这里改断言**性质**而非字面量：① 基线不缩短（bridgeDeadlineMsFor 的默认下限 300000 仍生效）；
//   ② webGeminiAsk 内部确实走缩放后的 deadline 与缩放后的停滞阈值。
test('v3.2.6 → v4.12.3: web-gemini 整体 deadline 基线不小于 300s，且已改为按提示长度缩放', () => {
  const m = src.match(/async function webGeminiAsk\(prompt\)/)
  assert.ok(m, 'webGeminiAsk 签名应为 (prompt)（timeoutMs 死参数已移除）')
  assert.match(src, /bridgeDeadlineMsFor\(len\)/, '整体 deadline 必须按提示长度计算（含 ≥300s 的下限）')
  assert.match(src, /bridgeStallMsFor\(len, BRIDGE_STALL_MS\)/, '停滞阈值必须按提示长度计算')
  // 下限仍在 bridge-poll.js 的纯函数里，直接断言它（比匹配字面量更可靠）
  assert.match(bridgePollSrc, /bridgeDeadlineMsFor\(promptLen, minMs = 300000\)/, 'deadline 的默认下限应为 300000ms')
})

test('v3.2.6: extractChunkText 跳过 reason/error/code/message 键（abort 错误文本不再混入正文）', () => {
  const m = src.match(/k === 'finish_reason'[\s\S]{0,120}?k === 'reason' \|\| k === 'error' \|\| k === 'code' \|\| k === 'message'/)
  assert.ok(m, 'extractChunkText 的 walk 应跳过 reason/error/code/message 键')
})

test('v3.2.6: dialog 循环拦截 error/aborted chunk 并立即返回（不拼接错误文本）', () => {
  const dialogLoop = src.match(/async function callDialogModel\(prompt\)[\s\S]{0,1800}?chunk\.type === 'error' \|\| chunk\.type === 'aborted'\)[\s\S]{0,200}?return \{ ok: false, error: String\(chunk\.error \|\| chunk\.message/)
  assert.ok(dialogLoop, 'dialog 循环应拦截 error/aborted chunk 并立即返回失败')
})

test('v3.2.6: claude 循环拦截 error/aborted chunk 并 break（不再拼接错误文本）', () => {
  const claudeLoop = src.match(/provider: 'anthropic'[\s\S]{0,1000}?chunk\.type === 'error' \|\| chunk\.type === 'aborted'\)[\s\S]{0,200}?break/)
  assert.ok(claudeLoop, 'claude 循环应拦截 error/aborted chunk 并 break')
})

test('版本号跟踪 package.json（v4.12.3——合成夹具 synthetic 标记 + bridge token 轮换自愈 + deploy.ps1 编码修复）', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.version, '4.12.3')
})
