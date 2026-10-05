/**
 * bridge-poll.js 单测（v4.9.3 web-gemini 停滞/failed 早退判定）。
 * 纯函数 + 注入时钟，不触碰网络。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyBridgeTask, BRIDGE_STALL_MS_DEFAULT, BRIDGE_PENDING_MS_DEFAULT, fetchWithTokenRetry, bridgeProcessingTimeoutMsFor, bridgeStallMsFor, bridgeDeadlineMsFor, classifyBridgeErrorCode } from '../lib/bridge-poll.js'

test('bridge-poll: done + answer → 成功返回 answer', () => {
  const v = classifyBridgeTask({ status: 'done', answer: 'PROBE-OK' })
  assert.equal(v.state, 'done')
  assert.equal(v.answer, 'PROBE-OK')
})

test('bridge-poll: done 但无 answer → waiting（不把空回复当成功）', () => {
  const v = classifyBridgeTask({ status: 'done', answer: '' })
  assert.equal(v.state, 'waiting')
})

test('bridge-poll: failed → 立即失败 + 携带扩展诊断', () => {
  const v = classifyBridgeTask({ status: 'failed', error: '未找到输入框' })
  assert.equal(v.state, 'failed')
  assert.ok(v.error.includes('未找到输入框'))
})

test('bridge-poll: failed 无诊断 → 仍失败（不白等超时）', () => {
  const v = classifyBridgeTask({ status: 'failed', error: '' })
  assert.equal(v.state, 'failed')
  assert.ok(v.error.includes('未提供诊断'))
})

test('bridge-poll: pending → waiting（扩展尚未取任务）', () => {
  assert.equal(classifyBridgeTask({ status: 'pending' }).state, 'waiting')
})

test('bridge-poll: processing 未超停滞阈值 → waiting（继续轮询）', () => {
  const now = 1_000_000
  const v = classifyBridgeTask({ status: 'processing' }, { processingSince: now - 30_000, now, stallMs: 90_000 })
  assert.equal(v.state, 'waiting')
})

test('bridge-poll: processing 超停滞阈值 → stalled（任务泄漏提前失败）', () => {
  const now = 1_000_000
  const v = classifyBridgeTask({ status: 'processing' }, { processingSince: now - 95_000, now, stallMs: 90_000 })
  assert.equal(v.state, 'stalled')
  assert.ok(v.error.includes('停滞'))
  assert.ok(v.error.includes('95s'))
})

test('bridge-poll: processing 但无起始时间戳 → waiting（保守，不误判）', () => {
  const v = classifyBridgeTask({ status: 'processing' }, { processingSince: null, now: 1_000_000, stallMs: 90_000 })
  assert.equal(v.state, 'waiting')
})

test('bridge-poll: null/非对象任务 → waiting（容错）', () => {
  assert.equal(classifyBridgeTask(null).state, 'waiting')
  assert.equal(classifyBridgeTask(undefined).state, 'waiting')
  assert.equal(classifyBridgeTask('x').state, 'waiting')
})

test('bridge-poll: 默认停滞阈值 = 90s（content waitReply 60s+5s 兜底之上留余量）', () => {
  assert.equal(BRIDGE_STALL_MS_DEFAULT, 90000)
  const now = 1_000_000
  // 89s → 仍等；91s → 停滞（默认阈值边界）
  assert.equal(classifyBridgeTask({ status: 'processing' }, { processingSince: now - 89_000, now }).state, 'waiting')
  assert.equal(classifyBridgeTask({ status: 'processing' }, { processingSince: now - 91_000, now }).state, 'stalled')
})

test('bridge-poll: 未知状态 → waiting（前向兼容扩展新状态）', () => {
  assert.equal(classifyBridgeTask({ status: 'queued' }).state, 'waiting')
})

// ---- stab1_2 实测新增：pending 无人认领（扩展无 Gemini 标签页时不取任务）----
test('bridge-poll: pending 超无人认领阈值 → unavailable（提前失败不白等 300s）', () => {
  const now = 1_000_000
  const v = classifyBridgeTask({ status: 'pending' }, { pendingSince: now - 65_000, now })
  assert.equal(v.state, 'unavailable')
  assert.ok(v.error.includes('无人认领'))
  assert.ok(v.error.includes('65s'))
  assert.ok(v.error.includes('gemini.google.com'))  // 给出可诊断原因
})

test('bridge-poll: pending 未超阈值 → waiting（正常等待扩展拾取）', () => {
  const now = 1_000_000
  assert.equal(classifyBridgeTask({ status: 'pending' }, { pendingSince: now - 20_000, now }).state, 'waiting')
})

test('bridge-poll: pending 但无起点时间戳 → waiting（保守，不误判）', () => {
  assert.equal(classifyBridgeTask({ status: 'pending' }, { pendingSince: null, now: 1_000_000 }).state, 'waiting')
})

test('bridge-poll: 默认无人认领阈值 60s（扩展 1s 轮询，60s 无认领即异常）', () => {
  assert.equal(BRIDGE_PENDING_MS_DEFAULT, 60000)
  const now = 1_000_000
  assert.equal(classifyBridgeTask({ status: 'pending' }, { pendingSince: now - 59_000, now }).state, 'waiting')
  assert.equal(classifyBridgeTask({ status: 'pending' }, { pendingSince: now - 61_000, now }).state, 'unavailable')
})

test('bridge-poll: processing 优先于 pending 判定（状态互斥不干扰）', () => {
  const now = 1_000_000
  // 同时给两个起点（实际不会发生）：processing 分支先生效
  const v = classifyBridgeTask({ status: 'processing' }, { processingSince: now - 95_000, pendingSince: now - 95_000, now })
  assert.equal(v.state, 'stalled')
})

// ---- v4.12.2: bridge token 轮换自愈（fetchWithTokenRetry）----

function fakeBridge(statuses) {
  // 依次返回给定状态码；记录每次请求携带的 token
  const calls = []
  let token = 'stale'
  let invalidations = 0
  const auth = {
    getHeaders: async () => ({ 'x-dsh-bridge-token': token }),
    invalidate: () => { invalidations++; token = 'fresh' },
  }
  const doFetch = async (headers) => {
    calls.push(headers['x-dsh-bridge-token'])
    return { status: statuses[Math.min(calls.length - 1, statuses.length - 1)] }
  }
  return { auth, doFetch, calls, invalidations: () => invalidations }
}

test('token 轮换：首个 401 → 清缓存重取 token 重试一次 → 200，自愈', async () => {
  const b = fakeBridge([401, 200])
  const res = await fetchWithTokenRetry(b.doFetch, b.auth)
  assert.equal(res.status, 200)
  assert.deepEqual(b.calls, ['stale', 'fresh'], '重试必须带新取的 token')
  assert.equal(b.invalidations(), 1)
})

test('真实密钥不一致：重试后仍 401 → 只重试一次，返回 401 交由调用方原文报错', async () => {
  const b = fakeBridge([401, 401, 401])
  const res = await fetchWithTokenRetry(b.doFetch, b.auth)
  assert.equal(res.status, 401)
  assert.equal(b.calls.length, 2, '不得无限重试')
  assert.equal(b.invalidations(), 1)
})

test('非 401（200/404/500）不重试、不清缓存', async () => {
  for (const status of [200, 404, 500]) {
    const b = fakeBridge([status])
    const res = await fetchWithTokenRetry(b.doFetch, b.auth)
    assert.equal(res.status, status)
    assert.equal(b.calls.length, 1)
    assert.equal(b.invalidations(), 0)
  }
})

test('网络异常原样抛出（由调用方既有 catch 处理），不吞错', async () => {
  const auth = { getHeaders: async () => ({}), invalidate: () => { throw new Error('不应调用') } }
  await assert.rejects(fetchWithTokenRetry(async () => { throw new Error('ECONNREFUSED') }, auth), /ECONNREFUSED/)
})

test('接线：index.js 所有带 token 的 bridge 请求都经 bridgeFetch（不再直接拼 bridgeHeaders）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.equal((src.match(/await bridgeHeaders\(\)/g) || []).length, 0, '不应再有直接使用 bridgeHeaders() 的请求')
  for (const ep of ['/create-task', '/task-result/', '/stats']) {
    assert.ok(new RegExp('bridgeFetch\\(`\\$\\{BRIDGE_BASE\\}' + ep.replace(/\//g, '\\/')).test(src), `${ep} 应经 bridgeFetch`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 2026-10-05 review-gate 交接 §3：宿主停滞阈值/整体 deadline 必须按提示长度缩放
// 背景：dsh-web-gemini-ext 0.4.3 起四层超时随长度缩放（6000 字符合法处理 150–230s），
//       而宿主固定 90s 判停滞 ⇒ 把正常处理误判为故障并触发重发（"标签页卡死/NO_RESPONSE"放大器）。
// ═══════════════════════════════════════════════════════════════════════════

test('[交接§3 必需] 6000 字符任务 processing 120s → **不得**判 stalled（阈值已按长度放大）', () => {
  const len = 6000
  const stallMs = bridgeStallMsFor(len, BRIDGE_STALL_MS_DEFAULT)
  assert.ok(stallMs > 120000, `6000 字符的停滞阈值应 >120s，实际 ${stallMs}ms`)
  const t0 = 1_000_000
  const v = classifyBridgeTask({ status: 'processing' }, { processingSince: t0, now: t0 + 120000, stallMs })
  assert.equal(v.state, 'waiting', '处理 120s 属合法区间，必须继续等而不是判停滞')
})

test('6000 字符：阈值应 ≥ 扩展自己的 processing 超时（≈229s）', () => {
  const len = 6000
  const extTimeout = bridgeProcessingTimeoutMsFor(len)
  const stallMs = bridgeStallMsFor(len, BRIDGE_STALL_MS_DEFAULT)
  assert.ok(extTimeout >= 220000 && extTimeout <= 240000, `扩展侧 processing 超时应在 220–240s，实际 ${extTimeout}ms`)
  assert.ok(stallMs >= extTimeout, '宿主判停滞不得早于扩展自己能等的最长时间')
})

test('阈值按长度单调不减（短提示不会被放大过头：仍不小于 env 基线）', () => {
  const short = bridgeStallMsFor(10, BRIDGE_STALL_MS_DEFAULT)
  const long = bridgeStallMsFor(20000, BRIDGE_STALL_MS_DEFAULT)
  assert.ok(short >= BRIDGE_STALL_MS_DEFAULT, '短提示也要保留基线，不得低于 90s')
  assert.ok(long > short, '长提示阈值必须更大')
})

test('env 覆盖不得把阈值调到低于扩展能等的时长（取 max，防覆盖后重新误判）', () => {
  const tiny = bridgeStallMsFor(6000, 10000)
  assert.ok(tiny >= bridgeProcessingTimeoutMsFor(6000), 'env 给小值时也必须被扩展超时抬起')
})

test('整体 deadline 不小于扩展 processing 超时，且不缩短既有 300s 基线', () => {
  assert.ok(bridgeDeadlineMsFor(10) >= 300000, '短提示仍保持既有 300s 基线')
  assert.ok(bridgeDeadlineMsFor(20000) > 300000, '长提示 deadline 应放大')
  assert.ok(bridgeDeadlineMsFor(6000) >= bridgeProcessingTimeoutMsFor(6000) + 30000, '应含最后一次轮询余量')
})

test('超时链四处一致（ext 三处 + 宿主这一处，逐字）：函数与常量都必须在', () => {
  const ext = 'D:/dsh/dsh-web-gemini-ext'
  const host = readFileSync(new URL('../lib/bridge-poll.js', import.meta.url), 'utf8')
  const want = ['sendSettleMsFor', 'replyMaxMsFor', 'contentBudgetMsFor', 'backgroundTimeoutMsFor', 'bridgeProcessingTimeoutMsFor', 'SEND_CANDIDATES_MAX']
  for (const w of want) assert.ok(host.includes(w), `宿主 bridge-poll.js 缺少 ${w}`)
  assert.match(host, /@timeouts-begin/, '必须保留 @timeouts 块的起止标记（便于两处比对）')
  // 若 ext 副本在本机，则比对 @timeouts 块（不同机部署时该断言自动跳过，不误报）。
  // 归一化说明（两项都只影响"暴露方式/说明文字"，不影响任何超时数值）：
  //   ① 去注释——宿主这份带"为什么宿主也要有一份"的交接说明，ext 那份没有；
  //   ② 去 `export `——宿主**必须**导出 bridgeProcessingTimeoutMsFor 给自己消费，ext 是局部函数。
  // 剩下的即超时链本体：任何数值或结构改动都会让这条断言失败。
  try {
    const bg = readFileSync(`${ext}/background.js`, 'utf8')
    const norm = (t) => {
      const m = t.match(/@timeouts-begin([\s\S]*?)@timeouts-end/)
      if (!m) return null
      // ① 去掉 begin 标记行本身——两处对它的说明文字本就不同（ext 写"三处必须逐字一致"，
      //    宿主写"与 ext 三处一致、此处为第四处"）；② 去注释；③ 去 export。
      const body = m[1].replace(/^[^\n]*\n/, '')
      return body.replace(/\/\/[^\n]*/g, '').replace(/\bexport\s+/g, '').replace(/\s+/g, '')
    }
    const a = norm(host); const b = norm(bg)
    assert.ok(a && b, '两处都应存在 @timeouts 块')
    assert.equal(a, b, '@timeouts 的超时链本体必须与 ext 的 background.js 一致（注释/export 已归一化）')
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 2026-10-05 交接 §2：INPUT_BUSY 可重试、INPUT_STUCK 需人工
// ═══════════════════════════════════════════════════════════════════════════

test('错误码分类：INPUT_BUSY → 可重试（不必人工）', () => {
  const c = classifyBridgeErrorCode('INPUT_BUSY: 输入框已有未发送内容（疑似用户正在输入…）')
  assert.equal(c.code, 'INPUT_BUSY')
  assert.equal(c.retryable, true)
  assert.equal(c.needsHuman, false)
})

test('错误码分类：INPUT_STUCK → 需人工（刷新 Gemini 标签页），且不可重试', () => {
  const c = classifyBridgeErrorCode('INPUT_STUCK: 自身残留提示无法清除 | 前30="..."')
  assert.equal(c.code, 'INPUT_STUCK')
  assert.equal(c.retryable, false)
  assert.equal(c.needsHuman, true)
})

test('[NEG] 错误码分类：SEND_FAIL / 未知 → 不可重试（防把真实故障重试成风暴）', () => {
  assert.equal(classifyBridgeErrorCode('SEND_FAIL: 输入框=contenteditable').retryable, false)
  assert.equal(classifyBridgeErrorCode('SEND_FAIL: …').needsHuman, false)
  assert.equal(classifyBridgeErrorCode('something else').code, null)
  assert.equal(classifyBridgeErrorCode('').retryable, false)
  assert.equal(classifyBridgeErrorCode(null).retryable, false)
})

test('classifyBridgeTask：failed 时把错误码分类一并返回（供调用方决定重试/人工）', () => {
  const busy = classifyBridgeTask({ status: 'failed', error: 'INPUT_BUSY: 输入框已有未发送内容' })
  assert.equal(busy.state, 'failed')
  assert.equal(busy.retryable, true)
  const stuck = classifyBridgeTask({ status: 'failed', error: 'INPUT_STUCK: 自身残留无法清除' })
  assert.equal(stuck.needsHuman, true)
})

test('源码契约：index.js 的 webGeminiAsk 必须对可重试错误重试、对 INPUT_STUCK 提示人工', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /MAX_ATTEMPTS = 4/, '重试上限应为 4 次（首试 + 3 重试）')
  assert.match(src, /RETRY_DELAY_MS = 5000/, '重试间隔应 ≥5s')
  assert.match(src, /last\.retryable === true && attempt < MAX_ATTEMPTS/, '只对可重试错误重试')
  assert.match(src, /INPUT_STUCK 为扩展自身残留无法清除，重试无效/, 'INPUT_STUCK 必须给出人工处置提示')
  assert.match(src, /bridgeStallMsFor\(len, BRIDGE_STALL_MS\)/, '停滞阈值必须按提示长度传入')
  assert.match(src, /bridgeDeadlineMsFor\(len\)/, '整体 deadline 必须按提示长度计算')
})
