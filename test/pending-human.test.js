// ccfeat-20260918-pendinghuman: 「链条停下等人 → 唤醒主 agent」纯函数单测（真实模块 lib/pending-human.mjs）
// 运行：node --test test/pending-human.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePendingHuman, decidePendingHuman, pendingHandoffText } from '../lib/pending-human.mjs'

const goodEntry = { id: 'chain-abc|too-many-attempts', chainId: 'chain-abc', reason: 'too-many-attempts', taskId: 'ccfix-1', detail: '连续 3 次失败', acknowledgedAt: null }

// ---------- parsePendingHuman ----------

test('parsePendingHuman：合法 JSON → ok=true 且 entry 字段完整', () => {
  const r = parsePendingHuman(JSON.stringify(goodEntry))
  assert.equal(r.ok, true)
  assert.equal(r.error, null)
  assert.equal(r.entry.id, goodEntry.id)
  assert.equal(r.entry.chainId, goodEntry.chainId)
})

test('parsePendingHuman：带 BOM 也能解析（容错）', () => {
  const r = parsePendingHuman('﻿' + JSON.stringify(goodEntry))
  assert.equal(r.ok, true)
  assert.equal(r.entry.chainId, goodEntry.chainId)
})

test('parsePendingHuman：坏 JSON → ok=false 且绝不抛异常', () => {
  assert.doesNotThrow(() => {
    const r = parsePendingHuman('{ this is not json')
    assert.equal(r.ok, false)
    assert.equal(r.entry, null)
    assert.ok(r.error)
  })
})

test('parsePendingHuman：缺 id/chainId/reason → ok=false（不能拿半个信号去唤醒）', () => {
  assert.equal(parsePendingHuman(JSON.stringify({ reason: 'review-needed' })).ok, false)
  assert.equal(parsePendingHuman(JSON.stringify({ id: 'x', reason: 'review-needed' })).ok, false)
  assert.equal(parsePendingHuman(JSON.stringify({ id: 'x', chainId: 'c' })).ok, false)
})

test('parsePendingHuman：空字符串/非字符串输入 → ok=false 且不抛', () => {
  assert.equal(parsePendingHuman('').ok, false)
  assert.equal(parsePendingHuman('   ').ok, false)
  assert.equal(parsePendingHuman(undefined).ok, false)
  assert.equal(parsePendingHuman(null).ok, false)
})

test('parsePendingHuman：解析结果是数组/非对象 → ok=false', () => {
  assert.equal(parsePendingHuman('[1,2,3]').ok, false)
  assert.equal(parsePendingHuman('"just a string"').ok, false)
})

// ---------- decidePendingHuman ----------

test('decidePendingHuman：无效条目（null / 缺字段）→ none', () => {
  assert.equal(decidePendingHuman(null, { notifiedIds: [] }).decision, 'none')
  assert.equal(decidePendingHuman({ id: 'x' }, { notifiedIds: [] }).decision, 'none')
  assert.equal(decidePendingHuman(undefined, { notifiedIds: new Set() }).decision, 'none')
})

test('decidePendingHuman：已销账（acknowledgedAt 非空）→ none', () => {
  const d = decidePendingHuman({ ...goodEntry, acknowledgedAt: '2026-09-18T00:00:00Z' }, { notifiedIds: [] })
  assert.equal(d.decision, 'none')
})

test('decidePendingHuman：同 id 已在 notifiedIds → none（去重，防每 15 分钟吵一次）', () => {
  const d1 = decidePendingHuman({ ...goodEntry }, { notifiedIds: new Set([goodEntry.id]) })
  assert.equal(d1.decision, 'none')
  const d2 = decidePendingHuman({ ...goodEntry }, { notifiedIds: [goodEntry.id] })
  assert.equal(d2.decision, 'none')
})

test('decidePendingHuman：dryRun === true → would-wake（判定需要但不真唤醒）', () => {
  const d = decidePendingHuman({ ...goodEntry, dryRun: true }, { notifiedIds: [] })
  assert.equal(d.decision, 'would-wake')
})

test('decidePendingHuman：正常新条目 → wake', () => {
  const d = decidePendingHuman({ ...goodEntry }, { notifiedIds: [] })
  assert.equal(d.decision, 'wake')
})

test('decidePendingHuman：notifiedIds 缺省（未传）也不抛，视为空集合', () => {
  assert.doesNotThrow(() => {
    const d = decidePendingHuman({ ...goodEntry })
    assert.equal(d.decision, 'wake')
  })
})

// ---------- pendingHandoffText ----------

test('pendingHandoffText：非空且含 chainId / reason / taskId / 处理指引', () => {
  const txt = pendingHandoffText({ id: 'x', chainId: 'chain-xyz', reason: 'instrument-error', taskId: 'ccfix-9', detail: '验收脚本抛出异常' })
  assert.ok(txt.length > 0)
  assert.ok(txt.includes('chain-xyz'))
  assert.ok(txt.includes('instrument-error'))
  assert.ok(txt.includes('ccfix-9'))
  assert.ok(txt.includes('验收脚本抛出异常'))
  assert.match(txt, /销账|acknowledgeHumanSignal/)
})

test('pendingHandoffText：字段缺失时仍返回非空文本（占位说明，不抛）', () => {
  assert.doesNotThrow(() => {
    const txt = pendingHandoffText({})
    assert.ok(txt.length > 0)
  })
  assert.doesNotThrow(() => {
    const txt = pendingHandoffText(null)
    assert.ok(txt.length > 0)
  })
})
