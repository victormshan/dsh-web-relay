/**
 * review-audit.js 单测（P1-1 降级率审计）。
 * 场景依据：AutoIteration 6 版迭代实测 dialog 13/23 ≈ 57%（超 30% 阈值）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { auditReviewSources, renderAuditLine, classifyReviewer, REVIEW_AUDIT_DEFAULTS } from '../lib/review-audit.js'

const mk = (id, reviewedBy) => ({ id, title: `Step ${id}`, reviewedBy })

test('audit: classifyReviewer 分类正确（含 claude-code 与缺省 external）', () => {
  assert.equal(classifyReviewer({ reviewedBy: 'dialog' }), 'dialog')
  assert.equal(classifyReviewer({ reviewedBy: 'manual' }), 'manual')
  assert.equal(classifyReviewer({ reviewedBy: 'mainagent' }), 'mainagent')
  assert.equal(classifyReviewer({ reviewedBy: 'claude-code' }), 'claude-code')
  assert.equal(classifyReviewer({ reviewedBy: 'external' }), 'external')
  assert.equal(classifyReviewer({}), 'external')       // 缺省视为外部 AI
  assert.equal(classifyReviewer(null), 'external')     // 容错
})

test('audit: AutoIteration 6 版实测分布（dialog 13/23 ≈ 57%）→ warn', () => {
  const steps = [
    ...Array.from({ length: 7 }, (_, i) => mk(`e${i}`, 'external')),
    ...Array.from({ length: 13 }, (_, i) => mk(`d${i}`, 'dialog')),
    ...Array.from({ length: 3 }, (_, i) => mk(`m${i}`, 'mainagent')),
  ]
  const a = auditReviewSources(steps)
  assert.equal(a.total, 23)
  assert.equal(a.counts.dialog, 13)
  assert.equal(a.flagged, true)
  assert.equal(a.level, 'warn')  // 有 external 成功 → warn（非 risk）
  assert.ok(a.message.includes('57%'))
})

test('audit: dialog 占比超阈值且外部通道成功 0 步 → risk', () => {
  const steps = [mk('1', 'dialog'), mk('2', 'dialog'), mk('3', 'mainagent'), mk('4', 'dialog')]
  const a = auditReviewSources(steps)
  assert.equal(a.level, 'risk')
  assert.ok(a.message.includes('成功 0 步'))
  assert.ok(a.message.includes('人工抽查'))
})

test('audit: claude-code 成功计入外部通道（不触发 risk）', () => {
  const steps = [mk('1', 'claude-code'), mk('2', 'dialog'), mk('3', 'dialog'), mk('4', 'dialog')]
  const a = auditReviewSources(steps)
  assert.equal(a.counts['claude-code'], 1)
  assert.equal(a.level, 'warn')  // 有外部（cc）成功
})

test('audit: dialog 占比未超阈值 → ok，无告警', () => {
  const steps = [mk('1', 'external'), mk('2', 'external'), mk('3', 'dialog'), mk('4', 'external'), mk('5', 'external')]
  const a = auditReviewSources(steps)
  assert.equal(a.flagged, false)
  assert.equal(a.level, 'ok')
  assert.equal(a.dialogRatio, 0.2)
  assert.ok(a.message.includes('正常'))
})

test('audit: 恰好等于阈值不告警（> 而非 >=）', () => {
  // 3/10 = 30% 恰好等于阈值 → 不告警
  const steps = [
    ...Array.from({ length: 7 }, (_, i) => mk(`e${i}`, 'external')),
    ...Array.from({ length: 3 }, (_, i) => mk(`d${i}`, 'dialog')),
  ]
  const a = auditReviewSources(steps)
  assert.equal(a.dialogRatio, 0.3)
  assert.equal(a.flagged, false)
})

test('audit: 样本不足（<3 步）不评估', () => {
  const a = auditReviewSources([mk('1', 'dialog'), mk('2', 'dialog')])
  assert.equal(a.flagged, false)
  assert.equal(a.level, 'ok')
  assert.ok(a.message.includes('样本不足'))
})

test('audit: manual 计入降级率（degradedRatio）', () => {
  const steps = [mk('1', 'manual'), mk('2', 'manual'), mk('3', 'external'), mk('4', 'external')]
  const a = auditReviewSources(steps)
  assert.equal(a.degradedRatio, 0.5)
  assert.equal(a.dialogRatio, 0)
})

test('audit: 空数组/非数组容错', () => {
  assert.equal(auditReviewSources([]).total, 0)
  assert.equal(auditReviewSources(null).total, 0)
  assert.equal(auditReviewSources(undefined).level, 'ok')
})

test('audit: 阈值可覆盖（dialogRatioWarn=0.5）', () => {
  const steps = [mk('1', 'external'), mk('2', 'dialog'), mk('3', 'external')]
  // 1/3 ≈ 33%：默认阈值 0.3 → 超阈告警
  assert.equal(auditReviewSources(steps).flagged, true)
  // 放宽到 0.5 → 不告警
  assert.equal(auditReviewSources(steps, { dialogRatioWarn: 0.5 }).flagged, false)
  assert.equal(REVIEW_AUDIT_DEFAULTS.dialogRatioWarn, 0.3)
})

test('renderAuditLine: 仅告警时返回非空，正常时为空串', () => {
  const okAudit = auditReviewSources([mk('1', 'external'), mk('2', 'external'), mk('3', 'external')])
  assert.equal(renderAuditLine(okAudit), '')
  const warnAudit = auditReviewSources([mk('1', 'dialog'), mk('2', 'dialog'), mk('3', 'dialog')])
  assert.ok(renderAuditLine(warnAudit).includes('审核降级审计'))
  assert.equal(renderAuditLine(null), '')
})
