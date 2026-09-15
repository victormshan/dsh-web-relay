// P3(v3.5.0) + V1-1: Architect 突破度门禁测试（纯函数镜像 lib/breakthrough-gate.js）
// 运行：node --test test/breakthrough-gate.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { breakthroughTypeOf, versionTypeOf, auditBreakthrough, evaluateBreakthroughPlan, evaluateVersionAdvance } from '../lib/breakthrough-gate.js'

test('breakthroughTypeOf：识别三种类型与来源字段（顶层/architect_vision）', () => {
  assert.equal(breakthroughTypeOf({ breakthrough_type: 'Incremental' }), 'incremental')
  assert.equal(breakthroughTypeOf({ breakthrough_type: 'STRUCTURAL' }), 'structural')
  assert.equal(breakthroughTypeOf({ architect_vision: { breakthrough_type: 'paradigm' } }), 'paradigm')
  assert.equal(breakthroughTypeOf({ title: '重构' }), null)
  assert.equal(breakthroughTypeOf(null), null)
})

test('versionTypeOf：含 breakthrough 的版本优先计为突破', () => {
  assert.equal(versionTypeOf([{ breakthrough_type: 'incremental' }, { breakthrough_type: 'paradigm' }]), 'breakthrough')
  assert.equal(versionTypeOf([{ breakthrough_type: 'incremental' }, { title: 'x' }]), 'incremental')
  assert.equal(versionTypeOf([{ title: 'x' }]), null)
})

test('auditBreakthrough：连续 2 个 Incremental 版本触发 warn；突破项重置', () => {
  const inc = [{ breakthrough_type: 'incremental' }]
  const v1 = auditBreakthrough(inc, 0)
  assert.equal(v1.streak, 1)
  assert.equal(v1.warn, null)
  const v2 = auditBreakthrough(inc, v1.streak)
  assert.equal(v2.streak, 2)
  assert.ok(v2.warn.includes('连续 2 个版本为 Incremental'))
  // 第三版含 paradigm → 重置
  const v3 = auditBreakthrough([{ breakthrough_type: 'paradigm' }], v2.streak)
  assert.equal(v3.streak, 0)
  assert.equal(v3.warn, null)
})

test('auditBreakthrough：unknown 版不计不重置（防误报）', () => {
  const r = auditBreakthrough([{ title: '探路' }], 1)
  assert.equal(r.streak, 1)
  assert.equal(r.warn, null)
})

test('source 含 P3 门禁标记（lib/breakthrough-gate.js + index.js）', () => {
  const b = fs.readFileSync(new URL('../lib/breakthrough-gate.js', import.meta.url), 'utf8')
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(b.includes('P3(v3.5.0)'))
  assert.ok(src.includes('auditBreakthrough'))
  assert.ok(src.includes('Architect 突破度门禁'))
})

// ---- V1-1: evaluateBreakthroughPlan 硬门禁 ----

const incStep = [{ breakthrough_type: 'incremental' }]
const structStep = [{ breakthrough_type: 'structural' }]

test('evaluateBreakthroughPlan：默认阈值 3，历史连增 2 次 + 本版 incremental = 3 → 拦截', () => {
  const r = evaluateBreakthroughPlan({ steps: incStep, history: ['incremental', 'incremental'] })
  assert.equal(r.gatePassed, false)
  assert.equal(r.consecutiveIncremental, 3)
  assert.equal(r.requiredType, 'structural')
  assert.equal(r.verdict, 'gate-blocked')
  assert.ok(r.reasons.length > 0)
})

test('evaluateBreakthroughPlan：历史连增 1 次 + 本版 incremental = 2 → 放行（未达默认阈值 3）', () => {
  const r = evaluateBreakthroughPlan({ steps: incStep, history: ['incremental'] })
  assert.equal(r.gatePassed, true)
  assert.equal(r.consecutiveIncremental, 2)
  assert.equal(r.requiredType, null)
  assert.equal(r.verdict, 'gate-passed')
  assert.deepEqual(r.reasons, [])
})

test('evaluateBreakthroughPlan：env DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL=2 覆盖阈值，2 次即拦截', () => {
  process.env.DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL = '2'
  try {
    const r = evaluateBreakthroughPlan({ steps: incStep, history: ['incremental'] })
    assert.equal(r.gatePassed, false)
    assert.equal(r.consecutiveIncremental, 2)
    assert.equal(r.verdict, 'gate-blocked')
  } finally {
    delete process.env.DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL
  }
})

test('evaluateBreakthroughPlan：本版含 structural → 放行且连增归零（即使历史已连增超限）', () => {
  const r = evaluateBreakthroughPlan({ steps: structStep, history: ['incremental', 'incremental', 'incremental'] })
  assert.equal(r.gatePassed, true)
  assert.equal(r.consecutiveIncremental, 0)
  assert.equal(r.requiredType, null)
  assert.equal(r.verdict, 'gate-passed')
  assert.deepEqual(r.reasons, [])
})

test('evaluateBreakthroughPlan：历史为空 + 本版 incremental → 连增 1，放行', () => {
  const r = evaluateBreakthroughPlan({ steps: incStep, history: [] })
  assert.equal(r.gatePassed, true)
  assert.equal(r.consecutiveIncremental, 1)
})

test('evaluateBreakthroughPlan：历史含 null/unknown 不重置不触发（跳过计入）', () => {
  const r = evaluateBreakthroughPlan({ steps: incStep, history: ['incremental', null, 'incremental'] })
  // 两次真正的 incremental + 本版 incremental = 3（null 被跳过，不清零也不计入次数）
  assert.equal(r.consecutiveIncremental, 3)
  assert.equal(r.gatePassed, false)
})

test('evaluateBreakthroughPlan：history 元素支持 {type} 对象形式', () => {
  const r = evaluateBreakthroughPlan({ steps: incStep, history: [{ type: 'incremental' }, { type: 'breakthrough' }] })
  // breakthrough 对象重置历史 → 仅本版 incremental 计 1
  assert.equal(r.consecutiveIncremental, 1)
  assert.equal(r.gatePassed, true)
})

test('evaluateBreakthroughPlan：reasons 含具体依据（连增次数与阈值）', () => {
  const r = evaluateBreakthroughPlan({ steps: incStep, history: ['incremental', 'incremental'] })
  assert.ok(r.reasons.some((x) => x.includes('3')))
  assert.ok(r.reasons.some((x) => x.includes('DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL')))
})

test('evaluateBreakthroughPlan：verdict 取值集合校验（gate-passed / gate-blocked）', () => {
  const passed = evaluateBreakthroughPlan({ steps: incStep, history: [] })
  const blocked = evaluateBreakthroughPlan({ steps: incStep, history: ['incremental', 'incremental'] })
  assert.equal(passed.verdict, 'gate-passed')
  assert.equal(blocked.verdict, 'gate-blocked')
})

test('evaluateBreakthroughPlan：全部未声明 breakthrough_type → 保守拦截 gate-needs-declaration', () => {
  const r = evaluateBreakthroughPlan({ steps: [{ title: '无声明步骤' }, { title: '另一步' }], history: [] })
  assert.equal(r.gatePassed, false)
  assert.equal(r.verdict, 'gate-needs-declaration')
  assert.equal(r.requiredType, 'structural')
  assert.ok(r.reasons[0].includes('未声明'))
})

test('evaluateBreakthroughPlan：全部未声明 + DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED=1 → 显式放行', () => {
  process.env.DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED = '1'
  try {
    const r = evaluateBreakthroughPlan({ steps: [{ title: '无声明步骤' }], history: [] })
    assert.equal(r.gatePassed, true)
    assert.equal(r.verdict, 'gate-passed-undeclared-allowed')
  } finally {
    delete process.env.DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED
  }
})

test('evaluateBreakthroughPlan：空 steps 数组不触发"未声明"保守拦截（防误报）', () => {
  const r = evaluateBreakthroughPlan({ steps: [], history: [] })
  assert.equal(r.gatePassed, true)
  assert.equal(r.verdict, 'gate-passed')
})

// ---- V1-1: 声明可达性回归——证明 breakthrough_type 经 normalizeStep 归一化后仍可被门禁看到 ----
// 镜像 lib/index.js 的 normalizeStep 字段契约（同 test/restructure-schema.test.js 的既有做法），
// 而非重复实现门禁判定逻辑：normalizeStep 自 v3.7.0 P1 起已透传 breakthrough_type（lib/index.js
// L1257-1258），归一化后该字段不会丢失，门禁可正确求值（而非静默读到 null 导致失效）。
function normalizeStepLike(raw, index) {
  const id = raw && raw.id != null ? raw.id : (index + 1)
  return {
    id: String(id),
    title: String((raw && raw.title) || `步骤 ${id}`),
    breakthrough_type: (raw && raw.breakthrough_type != null) ? String(raw.breakthrough_type) : null,
    architect_vision: (raw && raw.architect_vision && typeof raw.architect_vision === 'object') ? raw.architect_vision : null,
    architect: (raw && raw.architect && typeof raw.architect === 'object') ? raw.architect : null,
    status: 'pending'
  }
}

test('声明可达性回归：含 breakthrough_type 的原始 step 经 normalizeStep 归一化后仍能被门禁看到', () => {
  const rawSteps = [{ id: '1', title: 'S1', breakthrough_type: 'structural' }, { id: '2', title: 'S2' }]
  const normalized = rawSteps.map((s, i) => normalizeStepLike(s, i))
  assert.equal(normalized[0].breakthrough_type, 'structural')
  // 门禁对归一化后的数组求值，应识别出 structural 突破项（非静默失效）
  const r = evaluateBreakthroughPlan({ steps: normalized, history: ['incremental', 'incremental', 'incremental'] })
  assert.equal(r.gatePassed, true)
  assert.equal(r.consecutiveIncremental, 0)
  assert.equal(r.verdict, 'gate-passed')
})

test('声明可达性回归：restructure 接入点用原始 newSteps 审计，与归一化后结果一致（无输入分歧）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 门禁调用点存在且紧跟在悬空依赖校验之后、写盘之前
  assert.ok(src.includes("evaluateBreakthroughPlan({ steps: newSteps, history: historyBridge })"))
  assert.ok(src.includes("error: 'breakthrough-gate'"))
  // 过期注释已修正：不应再断言"normalizeStep 会丢弃 breakthrough_type"
  assert.ok(!src.includes('normalizeStep 会丢弃 breakthrough_type'))
})

test('/ask 绕过路径已堵上：askHandler 对 parsedSteps 执行 auditBreakthrough 并落盘 incrementalStreak', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(src.includes('askBreakthrough = auditBreakthrough(parsedSteps, 0)'))
  assert.ok(src.includes('incrementalStreak: askBreakthrough.streak'))
})

// ---- V2-2: evaluateVersionAdvance 版间门×突破度联动（纯函数，无 IO/无网络） ----

test('evaluateVersionAdvance：连续 Incremental 达上限 → advance=false，requiredType=structural，handoffNote 含关键词', () => {
  const r = evaluateVersionAdvance({
    steps: [{ title: '无声明的收尾步骤' }],
    state: { iterations: 5, currentIteration: 2, incrementalStreak: 3 },
    max: 3
  })
  assert.equal(r.advance, false)
  assert.equal(r.verdict, 'blocked-needs-breakthrough')
  assert.equal(r.requiredType, 'structural')
  assert.equal(r.consecutiveIncremental, 3)
  assert.ok(r.handoffNote.includes('structural') || r.handoffNote.includes('Structural'))
  assert.ok(r.handoffNote.includes('paradigm') || r.handoffNote.includes('Paradigm'))
  assert.ok(r.handoffNote.includes('连续 Incremental') || r.handoffNote.includes('Incremental'))
})

test('evaluateVersionAdvance：本版含 structural → advance=true，streak 归零（即使落盘 streak 已超阈值）', () => {
  const r = evaluateVersionAdvance({
    steps: [{ breakthrough_type: 'structural' }],
    state: { iterations: 5, currentIteration: 2, incrementalStreak: 5 },
    max: 3
  })
  assert.equal(r.advance, true)
  assert.equal(r.verdict, 'advance')
  assert.equal(r.consecutiveIncremental, 0)
  assert.equal(r.requiredType, null)
  assert.equal(r.handoffNote, null)
})

test('evaluateVersionAdvance：历史为空（incrementalStreak=0）→ 放行推进', () => {
  const r = evaluateVersionAdvance({
    steps: [{ title: '首版探路' }],
    state: { iterations: 3, currentIteration: 1, incrementalStreak: 0 },
    max: 3
  })
  assert.equal(r.advance, true)
  assert.equal(r.verdict, 'advance')
  assert.equal(r.consecutiveIncremental, 0)
})

test('evaluateVersionAdvance：全 unknown/null steps 不触发额外拦截（沿用落盘 streak，未过阈值即放行）', () => {
  const r = evaluateVersionAdvance({
    steps: [{ title: '无声明' }, { breakthrough_type: null }],
    state: { iterations: 4, currentIteration: 2, incrementalStreak: 1 },
    max: 3
  })
  assert.equal(r.advance, true)
  assert.equal(r.consecutiveIncremental, 1)
  assert.equal(r.requiredType, null)
})

test('evaluateVersionAdvance：达到 iterations 上限 → verdict=final-iteration 且 advance=true（收口行为不变，忽略 streak）', () => {
  const r = evaluateVersionAdvance({
    steps: [{ title: '无声明' }],
    state: { iterations: 3, currentIteration: 3, incrementalStreak: 9 },
    max: 3
  })
  assert.equal(r.advance, true)
  assert.equal(r.verdict, 'final-iteration')
  assert.equal(r.requiredType, null)
  assert.deepEqual(r.reasons, [])
})

test('evaluateVersionAdvance：iterations<=1（单版任务）→ verdict=single-iteration 且 advance=true', () => {
  const r = evaluateVersionAdvance({
    steps: [{ title: '无声明' }],
    state: { iterations: 1, currentIteration: 1, incrementalStreak: 9 },
    max: 3
  })
  assert.equal(r.advance, true)
  assert.equal(r.verdict, 'single-iteration')
})

test('evaluateVersionAdvance：reasons 含可读依据（连增次数与阈值均可读）', () => {
  const r = evaluateVersionAdvance({
    steps: [{ title: '无声明' }],
    state: { iterations: 5, currentIteration: 1, incrementalStreak: 3 },
    max: 3
  })
  assert.equal(r.advance, false)
  assert.ok(r.reasons.some((x) => x.includes('3')))
  assert.ok(r.reasons.some((x) => x.includes('DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL')))
})

test('evaluateVersionAdvance：max 显式入参可覆盖默认阈值（不读 env，纯函数注入）', () => {
  const blocked = evaluateVersionAdvance({ steps: [], state: { iterations: 5, currentIteration: 1, incrementalStreak: 2 }, max: 2 })
  assert.equal(blocked.advance, false)
  const passed = evaluateVersionAdvance({ steps: [], state: { iterations: 5, currentIteration: 1, incrementalStreak: 2 }, max: 3 })
  assert.equal(passed.advance, true)
})

test('evaluateVersionAdvance：同一 state 重复调用结果一致（幂等，不产生副作用）', () => {
  const input = { steps: [{ title: 'x' }], state: { iterations: 5, currentIteration: 2, incrementalStreak: 3 }, max: 3 }
  const r1 = evaluateVersionAdvance(input)
  const r2 = evaluateVersionAdvance(input)
  assert.deepEqual(r1, r2)
})

test('版间门接入点：lib/index.js 在 status===done 分支调用 evaluateVersionAdvance，且 blocked 分支落盘 breakthroughBlocked 并保持 currentIteration 不变', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(src.includes('evaluateVersionAdvance({ steps: updated.steps, state: updated, max: btMax })'))
  assert.ok(src.includes('updated.breakthroughBlocked = {'))
  assert.ok(src.includes('breakthroughBlocked: data.breakthroughBlocked || null'))
  assert.ok(src.includes('breakthroughBlocked: state.breakthroughBlocked || null'))
})
