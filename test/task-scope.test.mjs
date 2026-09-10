/**
 * task-scope.mjs 单测（CC 任务范围评估器）。
 *
 * 校准基准（2026-09-10 实测，来自 dsh-web-relay 混合架构真实派发）：
 *   A. RCA 任务：5 问 + 4 方案评估 + 3 产物 + 5 refs + 要求核实源码/给补丁 → **900s 超时无产物**
 *   B. 架构征询任务：6 问 + 2 产物 + 8 refs（回答简短）→ **258s 成功**
 *   C. v2 校验器实现：1 个模块 + 1 测试 → **222s 成功**
 * 断言以行为（level）+ 常量推导为主，避免参数微调导致测试碎裂。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assessTaskScope,
  recommendSplit,
  RISKY_THRESHOLD_SECONDS,
  TOO_BIG_THRESHOLD_SECONDS,
  BASELINE_IMPLEMENT_SECONDS,
  BASELINE_ANALYSIS_SECONDS,
  SECONDS_PER_QUESTION,
  SECONDS_PER_ARTIFACT,
  SECONDS_PER_EVAL_ITEM,
  SECONDS_PER_REFS_CHUNK,
  REFS_CHUNK_SIZE,
  SECONDS_PER_DEEP_ACTION,
} from '../lib/task-scope.mjs'

// ---- 实测校准 ----

test('实测校准 A：RCA 型重任务（核实+方案评估+补丁+3 产物）→ too-big', () => {
  const task = {
    kind: 'understand',
    prompt: '请回答：1) 核实根因 2) 完整中断面 3) 方案评估（A/B/C/D 四方案）4) 验收方式 5) 最小改动集？要求逐条核对源码并给出可应用补丁。产出 out/rca.md、out/patch-watchdog.md、out/verify-checklist.md',
    expectArtifacts: ['rca.md', 'patch-watchdog.md', 'verify-checklist.md'],
    refs: ['a', 'b', 'c', 'd', 'e'],
  }
  const r = assessTaskScope(task)
  assert.equal(r.level, 'too-big', `期望 too-big，实际 ${r.level}/${r.estimatedSeconds}s`)
  assert.ok(r.estimatedSeconds > TOO_BIG_THRESHOLD_SECONDS)
  assert.ok(r.reasons.some((x) => x.includes('深度动作')))  // 深度动作词因子被触发
  assert.ok(r.suggestion.includes('拆分'))
})

test('实测校准 B：架构征询型任务（6 问 + 2 产物 + 8 refs）→ 不得误判 too-big（实测 258s 成功）', () => {
  const task = {
    kind: 'understand',
    prompt: '请回答：1) 总判断 2) 自我边界 3) 失败模式 4) 成本与延迟 5) 对协议的建议 6) 最少改动集？',
    expectArtifacts: ['advisory.md', 'verdict.json'],
    refs: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
  }
  const r = assessTaskScope(task)
  assert.notEqual(r.level, 'too-big', `不得判 too-big（实测成功），实际 ${r.level}/${r.estimatedSeconds}s`)
  assert.ok(['ok', 'risky'].includes(r.level))
})

test('实测校准 C：简单实现任务（1 模块 + 1 测试）→ ok', () => {
  const task = { kind: 'implement', prompt: '实现 lib/foo.mjs 与其单测', expectArtifacts: ['foo.mjs', 'foo.test.mjs'], refs: ['x'] }
  const r = assessTaskScope(task)
  assert.equal(r.level, 'ok')
  assert.ok(r.estimatedSeconds < RISKY_THRESHOLD_SECONDS)
})

// ---- 深度动作词因子 ----

test('深度动作词：仅"问题多但回答简单"不应触发深度因子（不误判）', () => {
  const many = { kind: 'understand', prompt: '1) A 2) B 3) C 4) D 5) E 6) F 7) G', expectArtifacts: [], refs: [] }
  const r = assessTaskScope(many)
  assert.ok(!r.reasons.some((x) => x.includes('深度动作')), '无深度动作词时不应出现该项')
})

test('深度动作词：含"核实/评估/补丁/实现/交叉验证"逐项累加', () => {
  const base = { kind: 'understand', prompt: '请说明现状', expectArtifacts: [], refs: [] }
  const withDeep = { kind: 'understand', prompt: '请核实源码、逐条核对并评估方案，给出补丁', expectArtifacts: [], refs: [] }
  const a = assessTaskScope(base)
  const b = assessTaskScope(withDeep)
  assert.ok(b.estimatedSeconds > a.estimatedSeconds)
  assert.ok(b.reasons.some((x) => x.includes('深度动作')))
})

// ---- 边界 ----

test('边界：等级由阈值严格大于判定（构造恰好等于阈值的任务）', () => {
  // 用"分析类基线 + N 份产物"凑到恰好等于 risky 阈值（差值需被 SECONDS_PER_ARTIFACT 整除）
  const diff = RISKY_THRESHOLD_SECONDS - BASELINE_ANALYSIS_SECONDS
  const n = Math.floor(diff / SECONDS_PER_ARTIFACT)
  const exact = { kind: 'understand', prompt: 'x', expectArtifacts: Array.from({ length: n }, (_, i) => `a${i}.md`), refs: [] }
  const r = assessTaskScope(exact)
  // 断言等级语义：不超阈值即不 risky（即使凑不到精确等值，也验证单调性）
  assert.ok(r.estimatedSeconds <= RISKY_THRESHOLD_SECONDS)
  assert.equal(r.level, 'ok')

  const over = { kind: 'understand', prompt: 'x', expectArtifacts: Array.from({ length: n + 1 }, (_, i) => `a${i}.md`), refs: [] }
  const r2 = assessTaskScope(over)
  assert.ok(r2.estimatedSeconds > RISKY_THRESHOLD_SECONDS)
  assert.equal(r2.level, 'risky')
  // 严格大于才 too-big
  const justOver = { kind: 'understand', prompt: 'x', expectArtifacts: [], refs: [] }
  const big = assessTaskScope({ ...justOver, expectArtifacts: Array.from({ length: 12 }, (_, i) => `b${i}.md`) })
  assert.ok(big.estimatedSeconds > TOO_BIG_THRESHOLD_SECONDS)
  assert.equal(big.level, 'too-big')
})

test('边界：分析类基线高于实现类（同一任务 kind 不同判级可不同）', () => {
  const arts = ['a.md', 'b.md', 'c.md']
  const asImpl = assessTaskScope({ kind: 'implement', prompt: 'x', expectArtifacts: arts, refs: [] })
  const asUnd = assessTaskScope({ kind: 'understand', prompt: 'x', expectArtifacts: arts, refs: [] })
  assert.equal(asUnd.estimatedSeconds - asImpl.estimatedSeconds, BASELINE_ANALYSIS_SECONDS - BASELINE_IMPLEMENT_SECONDS)
})

test('边界：refs 按每 3 个一组计（不足一组不计）', () => {
  const mk = (n) => assessTaskScope({ kind: 'implement', prompt: 'x', expectArtifacts: [], refs: Array.from({ length: n }, (_, i) => `r${i}`) })
  const two = mk(2), three = mk(3)
  assert.equal(two.estimatedSeconds, BASELINE_IMPLEMENT_SECONDS, '2 个 refs 不足一组不加分')
  assert.equal(three.estimatedSeconds - two.estimatedSeconds, SECONDS_PER_REFS_CHUNK)
})

test('边界：问题数与评估项各自计权（组合叠加）', () => {
  const a = assessTaskScope({ kind: 'implement', prompt: '问题？', expectArtifacts: [], refs: [] })
  assert.equal(a.estimatedSeconds, BASELINE_IMPLEMENT_SECONDS + SECONDS_PER_QUESTION)
  const b = assessTaskScope({ kind: 'implement', prompt: '1) x', expectArtifacts: [], refs: [] })
  assert.equal(b.estimatedSeconds, BASELINE_IMPLEMENT_SECONDS + SECONDS_PER_EVAL_ITEM)
})

// ---- recommendSplit ----

test('recommendSplit：too-big 且产物 ≥2 → 按产物逐份拆分（≤4 块）', () => {
  const task = {
    kind: 'understand',
    prompt: '请核实源码并逐条核对，评估方案并给出补丁',
    expectArtifacts: ['a.md', 'b.md', 'c.md'],
    refs: [],
  }
  assert.equal(assessTaskScope(task).level, 'too-big')
  const s = recommendSplit(task)
  assert.equal(s.needed, true)
  assert.equal(s.chunks.length, 3)
  assert.ok(s.chunks[0].title.includes('a.md'))
})

test('recommendSplit：too-big 但产物 <2 → 退化为诊断/实现两块', () => {
  const task = { kind: 'understand', prompt: '请核实源码、逐条核对、评估方案、给出补丁、交叉验证并实现修复', expectArtifacts: [], refs: [] }
  assert.equal(assessTaskScope(task).level, 'too-big')
  const s = recommendSplit(task)
  assert.equal(s.needed, true)
  assert.equal(s.chunks.length, 2)
  assert.ok(s.chunks[0].focus.includes('不落地'))
})

test('recommendSplit：非 too-big → needed=false 且 chunks 为空', () => {
  const s = recommendSplit({ kind: 'implement', prompt: '小改一处', expectArtifacts: [], refs: [] })
  assert.deepEqual(s, { needed: false, chunks: [] })
})

// ---- 容错 ----

test('容错：空 task / 缺字段 / 非数组字段均不抛错', () => {
  assert.equal(assessTaskScope().level, 'ok')
  assert.equal(assessTaskScope({}).level, 'ok')
  assert.equal(assessTaskScope({ kind: 'implement' }).level, 'ok')
  assert.equal(assessTaskScope({ kind: 'implement', expectArtifacts: 'oops', refs: null }).level, 'ok')
  assert.equal(recommendSplit(null).needed, false)
})

test('契约：阈值与 runner.sh 900s 上限保持保守余量', () => {
  assert.equal(TOO_BIG_THRESHOLD_SECONDS, 600)
  assert.equal(RISKY_THRESHOLD_SECONDS, 420)
  assert.ok(TOO_BIG_THRESHOLD_SECONDS < 900)
  assert.ok(SECONDS_PER_DEEP_ACTION > 0 && SECONDS_PER_QUESTION > 0)
})
