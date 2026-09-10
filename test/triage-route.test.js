/**
 * triage-route.js 单测（P0-1 场景路由分流）。
 * 规则依据：2026-09-10 架构征询两方（外部 AI web-gemini + Claude Code）建议交集。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { decideHybridRoute, renderRouteDecision, TRIAGE_DEFAULTS } from '../lib/triage-route.js'

// ---- 硬边界：任何情况都不派 cc ----

test('triage: 需要 GUI/浏览器 → 阻断（cc 无此能力）', () => {
  const d = decideHybridRoute({ kind: 'implement', changedFiles: 5, needsGui: true })
  assert.equal(d.useHybrid, false)
  assert.equal(d.confidence, 'high')
  assert.ok(d.blockers.some((b) => b.includes('GUI')))
})

test('triage: 需要跨会话状态收敛 → 阻断（cc 无 --resume 无记忆）', () => {
  const d = decideHybridRoute({ kind: 'implement', changedFiles: 4, needsCrossSession: true })
  assert.equal(d.useHybrid, false)
  assert.ok(d.blockers.some((b) => b.includes('跨会话')))
})

test('triage: 需要主 agent 专属工具 → 阻断（cc 白名单仅三工具）', () => {
  const d = decideHybridRoute({ kind: 'understand', needsHostOnlyTools: true })
  assert.equal(d.useHybrid, false)
  assert.ok(d.blockers.some((b) => b.includes('专属工具')))
})

test('triage: 预估超 900s → 阻断（应先拆分）', () => {
  const d = decideHybridRoute({ kind: 'implement', changedFiles: 6, estimatedSeconds: 1200 })
  assert.equal(d.useHybrid, false)
  assert.ok(d.blockers.some((b) => b.includes('900')))
})

// ---- 豁免：不必派（固定开销不划算）----

test('triage: 单文件小改 → 不派（避免 4-8 分钟固定开销）', () => {
  const d = decideHybridRoute({ kind: 'implement', changedFiles: 1 })
  assert.equal(d.useHybrid, false)
  assert.ok(d.reasons.some((r) => r.includes('局部小改')))
})

test('triage: 纯配置/环境探路 → 不派', () => {
  const dConfig = decideHybridRoute({ kind: 'config', changedFiles: 5 })
  assert.equal(dConfig.useHybrid, false)
  assert.ok(dConfig.reasons.some((r) => r.includes('纯配置')))
  const dProbe = decideHybridRoute({ kind: 'probe' })
  assert.equal(dProbe.useHybrid, false)
})

// ---- 启用：两方专家交集的默认启用场景 ----

test('triage: 实现类跨模块（≥3 文件）→ 派 cc', () => {
  const d = decideHybridRoute({ kind: 'implement', changedFiles: 3 })
  assert.equal(d.useHybrid, true)
  assert.ok(['high', 'medium'].includes(d.confidence))
  assert.ok(d.reasons.some((r) => r.includes('跨模块')))
})

test('triage: 静态代码诊断（understand）→ 派 cc', () => {
  const d = decideHybridRoute({ kind: 'understand', changedFiles: 0 })
  assert.equal(d.useHybrid, true)
  assert.ok(d.reasons.some((r) => r.includes('静态代码诊断')))
})

test('triage: 代码评审（review）→ 派 cc', () => {
  const d = decideHybridRoute({ kind: 'review', changedFiles: 2 })
  assert.equal(d.useHybrid, true)
  assert.ok(d.reasons.some((r) => r.includes('代码级评审')))
})

test('triage: AutoIteration 多版本（iterations>1）→ 派 cc', () => {
  const d = decideHybridRoute({ kind: 'implement', changedFiles: 5, iterations: 6 })
  assert.equal(d.useHybrid, true)
  assert.equal(d.confidence, 'high') // 多依据 → high
})

test('triage: 多方案裁决（alternatives>1）→ 派 cc', () => {
  const d = decideHybridRoute({ kind: 'implement', changedFiles: 4, alternativesCount: 3 })
  assert.equal(d.useHybrid, true)
  assert.ok(d.reasons.some((r) => r.includes('多方案裁决')))
})

// ---- 合成与边界 ----

test('triage: 硬边界优先于启用条件（有依据但被阻断仍不派）', () => {
  const d = decideHybridRoute({ kind: 'understand', changedFiles: 5, iterations: 3, needsGui: true })
  assert.equal(d.useHybrid, false)
  assert.ok(d.blockers.length > 0)
})

test('triage: 无任何信号 → 保守不派（confidence low）', () => {
  const d = decideHybridRoute({})
  assert.equal(d.useHybrid, false)
  assert.equal(d.confidence, 'low')
  assert.deepEqual(d.blockers, [])
})

test('triage: 阈值可覆盖（multiFileMinFiles=5）', () => {
  const d = decideHybridRoute({ kind: 'implement', changedFiles: 3 }, { multiFileMinFiles: 5 })
  // 3 文件 > smallChangeMaxFiles(1) 但 < 5 → 仍有多文件依据
  assert.equal(d.useHybrid, true)
  const d2 = decideHybridRoute({ kind: 'implement', changedFiles: 3 }, { multiFileMinFiles: 5, smallChangeMaxFiles: 3 })
  assert.equal(d2.useHybrid, false) // 3 文件被视为小改 → 豁免
})

test('triage: renderRouteDecision 输出可读结论', () => {
  const hybrid = decideHybridRoute({ kind: 'understand' })
  assert.ok(renderRouteDecision(hybrid).startsWith('route=hybrid(cc)'))
  const local = decideHybridRoute({ kind: 'config' })
  assert.ok(renderRouteDecision(local).startsWith('route=local'))
  assert.ok(renderRouteDecision(null).includes('未判定'))
})

test('triage: 默认阈值常量与 runner 契约一致（900s）', () => {
  assert.equal(TRIAGE_DEFAULTS.ccTimeoutSeconds, 900)
  assert.equal(TRIAGE_DEFAULTS.multiFileMinFiles, 3)
})
