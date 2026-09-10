/**
 * cross-check.js 单测（P2-1 双通道交叉校验仲裁）。
 * 依据：架构征询两方共识——high 步骤两条独立外部通道结论冲突时升级人工，不自动判定。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { crossCheckVerdicts, shouldCrossCheck, CROSS_CHECK_STATES } from '../lib/cross-check.js'

test('cross-check: 双方 approved → consensus-approved（不升级）', () => {
  const xc = crossCheckVerdicts({ verdict: 'approved', reason: 'A 侧依据' }, { verdict: 'approved', reason: 'B 侧依据' })
  assert.equal(xc.state, 'consensus-approved')
  assert.equal(xc.result, 'approved')
  assert.equal(xc.escalate, false)
  assert.ok(xc.reason.includes('双通道一致'))
  assert.ok(xc.reason.includes('A 侧依据'))
})

test('cross-check: 双方 rejected → consensus-rejected（不升级）', () => {
  const xc = crossCheckVerdicts({ verdict: 'rejected', reason: 'A' }, { verdict: 'rejected', reason: 'B' })
  assert.equal(xc.state, 'consensus-rejected')
  assert.equal(xc.result, 'rejected')
  assert.equal(xc.escalate, false)
})

test('cross-check: 结论冲突（一 approved 一 rejected）→ escalate-conflict（升级人工）', () => {
  const xc = crossCheckVerdicts({ verdict: 'approved', reason: '外部 AI 认为达标' }, { verdict: 'rejected', reason: 'cc 发现缺陷' })
  assert.equal(xc.state, 'escalate-conflict')
  assert.equal(xc.result, null)
  assert.equal(xc.escalate, true)
  assert.ok(xc.reason.includes('冲突'))
  assert.ok(xc.reason.includes('升级人工'))
  // 双方理由都要保留供人工裁决
  assert.ok(xc.reason.includes('外部 AI 认为达标'))
  assert.ok(xc.reason.includes('cc 发现缺陷'))
})

test('cross-check: 次通道无结论 → escalate-unusable（不得单方采信）', () => {
  const xc = crossCheckVerdicts({ verdict: 'approved', reason: 'A' }, null)
  assert.equal(xc.state, 'escalate-unusable')
  assert.equal(xc.escalate, true)
  assert.ok(xc.reason.includes('claude-code'))
})

test('cross-check: 次通道结论无法识别（unknown）→ escalate-unusable', () => {
  const xc = crossCheckVerdicts({ verdict: 'approved', reason: 'A' }, { verdict: 'unknown', reason: '读不懂' })
  assert.equal(xc.state, 'escalate-unusable')
  assert.equal(xc.escalate, true)
})

test('cross-check: 主通道无结论 → escalate-unusable', () => {
  const xc = crossCheckVerdicts(null, { verdict: 'approved', reason: 'B' })
  assert.equal(xc.state, 'escalate-unusable')
  assert.ok(xc.reason.includes('外部 AI'))
})

test('cross-check: 支持 result 字段别名（cc 侧 verdict/result 双写法）', () => {
  const xc = crossCheckVerdicts({ result: 'approved', reason: 'A' }, { result: 'approved', reason: 'B' })
  assert.equal(xc.state, 'consensus-approved')
})

test('cross-check: 大小写不敏感（APPROVED）', () => {
  const xc = crossCheckVerdicts({ verdict: 'APPROVED', reason: 'A' }, { verdict: 'approved', reason: 'B' })
  assert.equal(xc.state, 'consensus-approved')
})

test('cross-check: 自定义通道标签出现在理由中', () => {
  const xc = crossCheckVerdicts({ verdict: 'approved' }, { verdict: 'rejected' }, { primaryLabel: 'Gemini', secondaryLabel: 'Claude' })
  assert.ok(xc.reason.includes('Gemini'))
  assert.ok(xc.reason.includes('Claude'))
})

test('cross-check: state 常量导出齐全', () => {
  assert.deepEqual([...CROSS_CHECK_STATES], ['consensus-approved', 'consensus-rejected', 'escalate-conflict', 'escalate-unusable'])
})

// ---- shouldCrossCheck ----

test('shouldCrossCheck: 仅 enableCrossCheck=true 且 importance=high 才启用', () => {
  assert.equal(shouldCrossCheck({ importance: 'high' }, true), true)
  assert.equal(shouldCrossCheck({ importance: 'high' }, false), false)     // 开关未开
  assert.equal(shouldCrossCheck({ importance: 'medium' }, true), false)    // 非 high
  assert.equal(shouldCrossCheck({ importance: 'low' }, true), false)
  assert.equal(shouldCrossCheck({}, true), false)                          // 未声明 importance
  assert.equal(shouldCrossCheck(null, true), false)                        // 容错
})
