// lib/task-ref.mjs 单测：统一任务身份（唯一来源）的规范形态与匹配语义。
// 为什么必须有（2026-09-20）：四类任务载体（cc 任务 / 三方协议迭代 / needs-human 信号 / 主 agent 自持）
// 此前各用一套 id 词汇，跨载体追责只能人肉对账，审计层只能 grep 散文认领对象（脆弱）。
// 本模块是"统一身份"的落点，故其契约必须由仓库自带套件持续守住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TASK_KINDS, KIND_INFO, makeRef, parseRef, isCanonicalRef, describeRef, sameRef } from '../lib/task-ref.mjs'

test('makeRef 产出规范形态；signal 必带代数', () => {
  assert.equal(makeRef('cc', 'ccab-1'), 'cc:ccab-1')
  assert.equal(makeRef('expr', 'expr-2026-09-13_17-36-07'), 'expr:expr-2026-09-13_17-36-07')
  assert.equal(makeRef('signal', 'audit', { generation: 3 }), 'signal:audit#g3')
  assert.equal(makeRef('signal', 'audit#g7', { generation: 1 }), 'signal:audit#g7', '已含 #gN 不重复追加')
  assert.equal(makeRef('main', 'tidy-docs'), 'main:tidy-docs')
})

test('makeRef 拒绝未知 kind 与空 id', () => {
  assert.throws(() => makeRef('bogus', 'x'), /未知 kind/)
  assert.throws(() => makeRef('cc', ''), /id 必填/)
  assert.throws(() => makeRef('cc', null), /id 必填/)
})

test('parseRef 解析规范 ref', () => {
  assert.deepEqual(parseRef('cc:t1'), { ok: true, kind: 'cc', id: 't1', generation: null, canonical: 'cc:t1', legacy: false, why: 'ok' })
  const s = parseRef('signal:a#g2')
  assert.equal(s.ok, true)
  assert.equal(s.generation, 2)
  assert.equal(s.id, 'a')
})

test('裸串归为 legacy：可识别但非规范（不得用于新写入）', () => {
  const r = parseRef('expr-2026-09-03_01-27-21')
  assert.equal(r.ok, false)
  assert.equal(r.legacy, true)
  assert.equal(r.id, 'expr-2026-09-03_01-27-21')
  assert.equal(isCanonicalRef('expr-2026-09-03_01-27-21'), false)
})

test('畸形输入不抛异常，只给 why', () => {
  assert.equal(parseRef('').why, 'empty')
  assert.equal(parseRef(null).ok, false)
  assert.equal(parseRef('signal:no-generation').ok, false)
  assert.match(parseRef('signal:no-generation').why, /#g<N>/)
  assert.equal(parseRef('bogus:x').why, 'unknown-kind:bogus')
})

test('sameRef 精确匹配，且跨 kind 不算同一对象（禁止模糊认领）', () => {
  assert.equal(sameRef('expr:a', 'expr:a'), true)
  assert.equal(sameRef('expr:a', 'expr:a-b'), false, '不得包含匹配')
  assert.equal(sameRef('cc:x', 'expr:x'), false, '同 id 不同 kind 不是同一对象')
  assert.equal(sameRef('expr:a', 'a'), true, 'legacy 裸串 id 逐字相等 → 认领（向后兼容历史信号）')
})

test('describeRef 给出 owner 与状态落点（消费方不必各写一套路径）', () => {
  const d = describeRef('expr:expr-1')
  assert.equal(d.kind, 'expr')
  assert.equal(d.owner, 'main-agent')
  assert.match(d.state, /experiments/)
  assert.ok(d.terminalStates.includes('done'))
  const c = describeRef('cc:t9')
  assert.equal(c.owner, 'cc')
  assert.match(c.state, /tasks/)
})

test('KIND_INFO 覆盖全部 kind（新增 kind 必须同时补信息，否则 describeRef 给不出落点）', () => {
  for (const k of TASK_KINDS) assert.ok(KIND_INFO[k], `缺 ${k} 的 KIND_INFO`)
  assert.equal(Object.keys(KIND_INFO).length, TASK_KINDS.length)
})
