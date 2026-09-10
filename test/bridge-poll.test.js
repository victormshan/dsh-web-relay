/**
 * bridge-poll.js 单测（v4.9.3 web-gemini 停滞/failed 早退判定）。
 * 纯函数 + 注入时钟，不触碰网络。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyBridgeTask, BRIDGE_STALL_MS_DEFAULT, BRIDGE_PENDING_MS_DEFAULT } from '../lib/bridge-poll.js'

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
