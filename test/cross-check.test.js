/**
 * cross-check.js 单测（P2-1 双通道交叉校验仲裁）。
 * 依据：架构征询两方共识——high 步骤两条独立外部通道结论冲突时升级人工，不自动判定。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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

// ---- 接线回归（claude-code 审核 xc3 发现的事故类：参数漏传 → 开关静默失效）----
// 事故复盘：/steps/auto-review 的批量分支（batchStepIds）只传 6 个参数，遗漏第 7 参
// enableCrossCheck → shouldCrossCheck(step, undefined) 恒 false → 凡走批量接口的高权重步骤，
// 双通道交叉校验（含"结论冲突升人工"的安全网）静默失效；单步分支一直正确 → 差异极难被单步实测发现。
// 本用例锁死"两个调用点都必须传该开关"，防止同类漏参回归。

/** 提取 src 中所有 `await <name>(...)` 调用点的完整实参文本（括号配对，支持跨行）。 */
function awaitCallSites(src, name) {
  const sites = []
  const re = new RegExp(`await\\s+${name}\\s*\\(`, 'g')
  let m
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('(', m.index)
    let depth = 0
    let end = -1
    for (let i = open; i < src.length; i += 1) {
      const ch = src[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    if (end > open) sites.push(src.slice(m.index, end + 1))
  }
  return sites
}

test('接线：obtainReviewVerdict 的每个调用点（透传点 + 批量点）都传 enableCrossCheck', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const sites = awaitCallSites(src, 'obtainReviewVerdict')
  assert.ok(sites.length >= 2, `预期至少 2 个调用点（reviewOneStep 内透传 + 批量路径），实际 ${sites.length}`)
  for (const s of sites) {
    assert.ok(
      s.includes('enableCrossCheck'),
      `调用点遗漏 enableCrossCheck（该路径交叉校验会静默失效）：\n${s.slice(0, 240)}`,
    )
  }
})

test('接线：两条请求级入口（单步 reviewOneStep + 批量 mapLimit）都传 payload.enableCrossCheck', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 单步入口：路由处理器里 reviewOneStep(...) 的调用点
  const single = awaitCallSites(src, 'reviewOneStep')
  assert.equal(single.length, 1, `预期 1 个 reviewOneStep 调用点，实际 ${single.length}`)
  assert.match(single[0], /payload\.enableCrossCheck\s*===\s*true/, '单步入口未传请求级 enableCrossCheck')
  // 批量入口：批量分支内的 obtainReviewVerdict 调用点（用批量分支标记定位，避免依赖行号）
  const batchStart = src.indexOf('batchStepIds.length > 0')
  assert.ok(batchStart > 0, '未找到批量审核分支标记 batchStepIds.length > 0')
  const batchSites = awaitCallSites(src.slice(batchStart), 'obtainReviewVerdict')
  assert.ok(batchSites.length >= 1, '批量分支内未找到 obtainReviewVerdict 调用点')
  for (const s of batchSites) {
    assert.match(s, /payload\.enableCrossCheck\s*===\s*true/, `批量入口未传请求级 enableCrossCheck：\n${s.slice(0, 240)}`)
  }
})
