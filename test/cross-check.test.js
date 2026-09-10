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

// ---- 2026-09-10 语义修正（双通道复核发现的缺陷）：unusable 拆分为主/次通道 ----
// 次通道不可用 = "通道故障"，应降级采信主通道并标注（不误升级人工）；
// 主通道不可用 = "没有可采信结论"，必须人工。

test('cross-check: 次通道无结论 → degrade-unusable-secondary（采信主通道 + 标注未交叉校验）', () => {
  const xc = crossCheckVerdicts({ verdict: 'approved', reason: '主通道依据' }, null)
  assert.equal(xc.state, 'degrade-unusable-secondary')
  assert.equal(xc.escalate, false)          // 不升级人工（区分"故障"与"冲突"）
  assert.equal(xc.degraded, true)
  assert.equal(xc.result, 'approved')       // 采信主通道结论
  assert.ok(xc.reason.includes('交叉校验未完成'))
  assert.ok(xc.reason.includes('claude-code'))
  assert.ok(xc.reason.includes('主通道依据'))
})

test('cross-check: 次通道结论无法识别（unknown）→ 同样降级采信主通道', () => {
  const xc = crossCheckVerdicts({ verdict: 'rejected', reason: 'A' }, { verdict: 'unknown', reason: '读不懂' })
  assert.equal(xc.state, 'degrade-unusable-secondary')
  assert.equal(xc.escalate, false)
  assert.equal(xc.result, 'rejected')
})

test('cross-check: 主通道无结论 → escalate-unusable-primary（必须人工，不得单方采信）', () => {
  const xc = crossCheckVerdicts(null, { verdict: 'approved', reason: 'B' })
  assert.equal(xc.state, 'escalate-unusable-primary')
  assert.equal(xc.escalate, true)
  assert.equal(xc.result, null)
  assert.ok(xc.reason.includes('外部 AI'))
  assert.ok(xc.reason.includes('不得由单方结论自动采信'))
})

test('cross-check: 主次通道同时无结论 → 判主通道（escalate）优先', () => {
  const xc = crossCheckVerdicts(null, null)
  assert.equal(xc.state, 'escalate-unusable-primary')
  assert.equal(xc.escalate, true)
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

test('cross-check: state 常量导出齐全（含 unusable 主/次拆分）', () => {
  assert.deepEqual([...CROSS_CHECK_STATES], [
    'consensus-approved', 'consensus-rejected',
    'escalate-conflict', 'escalate-unusable-primary', 'degrade-unusable-secondary',
  ])
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
