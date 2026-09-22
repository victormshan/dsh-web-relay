// v4.9.2: 心跳自查信号扫描单测（真实模块 lib/heartbeat-scan.js）
// 运行：node --test test/heartbeat-scan.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { scanExprSignals, scanPendingSignals, exprFingerprint, evaluateWakeOutcomes, shouldSuppressWake, shouldWakeOnStepTransition, coalesceWake, buildWakeKey, WAKE_COALESCE_MS_DEFAULT } from '../lib/heartbeat-scan.js'

const now = Date.now()
const base = (over) => ({
  exprId: 'expr-2026-09-07_08-00-00',
  status: 'open', phase: 'executing', autoReview: true, finalized: false,
  updatedAt: new Date(now - 60000).toISOString(),
  activeSteps: [], steps: [], ...over
})

test('scanExprSignals：无待办 → 空信号', () => {
  const st = base({ status: 'done', finalized: true, steps: [{ id: 'a', status: 'approved' }] })
  assert.deepEqual(scanExprSignals(st, { now }).signals, [])
})

// ---- stab2_3: 已归档 expr 不产生心跳信号（防反复打扰）----
test('scanExprSignals：已归档测试 expr（isTest+done）即使残留 rejected/review 步骤也不报信号', () => {
  // 实测场景：归档测试快照时只改了 expr 级 status/finalized/isTest，步骤仍残留 rejected/review
  // → 每轮心跳都报 rejected-pending/review-pending，反复打扰主 agent（实测一轮报 4 个）
  const st = base({ isTest: true, status: 'done', finalized: true, steps: [{ id: 'ccv1', status: 'rejected' }, { id: 'xc1', status: 'review' }] })
  assert.deepEqual(scanExprSignals(st, { now }).signals, [])
})

test('scanExprSignals：finalized 的 expr 不报信号（即使步骤非 approved）', () => {
  const st = base({ finalized: true, status: 'done', steps: [{ id: 'a', status: 'rejected' }] })
  assert.deepEqual(scanExprSignals(st, { now }).signals, [])
})

test('scanExprSignals：未归档 expr 仍正常报信号（过滤不过度）', () => {
  const st = base({ isTest: false, status: 'open', finalized: false, steps: [{ id: 'a', status: 'rejected' }] })
  assert.ok(scanExprSignals(st, { now }).signals.includes('rejected-pending'))
  // isTest=true 但仍在执行（未收口）→ 照样报信号
  const running = base({ isTest: true, status: 'executing', finalized: false, activeSteps: ['a'], steps: [{ id: 'a', status: 'executing' }] })
  assert.ok(scanExprSignals(running, { now, staleMs: 1 }).signals.length > 0)
})

test('review-pending：有 review 状态步骤', () => {
  const st = base({ steps: [{ id: 'r1', title: '待审', status: 'review' }] })
  const r = scanExprSignals(st, { now })
  assert.ok(r.signals.includes('review-pending'))
  assert.ok(r.detail[0].includes('r1'))
})

test('rejected-pending：有 rejected 步骤', () => {
  const st = base({ steps: [{ id: 'x1', status: 'rejected' }] })
  const r = scanExprSignals(st, { now })
  assert.ok(r.signals.includes('rejected-pending'))
})

test('executing-stale：executing 且超阈值无进展', () => {
  const st = base({
    status: 'executing',
    updatedAt: new Date(now - 3600000).toISOString(), // 1h 前
    steps: [{ id: 'e1', status: 'executing' }]
  })
  const r = scanExprSignals(st, { now, staleMs: 1200000 })
  assert.ok(r.signals.includes('executing-stale'))
})

test('executing 未超阈值 → 无 stale 信号', () => {
  const st = base({
    status: 'executing',
    updatedAt: new Date(now - 60000).toISOString(),
    steps: [{ id: 'e1', status: 'executing' }]
  })
  assert.ok(!scanExprSignals(st, { now, staleMs: 1200000 }).signals.includes('executing-stale'))
})

test('finalize-pending：全 approved 未收口', () => {
  const st = base({ steps: [{ id: 'a', status: 'approved' }, { id: 'b', status: 'approved' }] })
  const r = scanExprSignals(st, { now })
  assert.ok(r.signals.includes('finalize-pending'))
})

test('resume-circuit-paused：续跑熔断 paused', () => {
  const st = base({ status: 'paused', stopReason: '宿主重启续跑熔断：…', steps: [{ id: 'a', status: 'executing' }] })
  const r = scanExprSignals(st, { now })
  assert.ok(r.signals.includes('resume-circuit-paused'))
})

test('scanPendingSignals：只返回有信号的 expr 且保序', () => {
  const a = base({ exprId: 'expr-1', steps: [{ id: 'r', status: 'review' }] })
  const b = base({ exprId: 'expr-2', status: 'done', finalized: true, steps: [{ id: 'a', status: 'approved' }] })
  const c = base({ exprId: 'expr-3', steps: [{ id: 'x', status: 'rejected' }] })
  const out = scanPendingSignals([a, b, c], { now })
  assert.deepEqual(out.map((x) => x.exprId), ['expr-1', 'expr-3'])
})

test('maxAgeMs：陈旧 expr（updatedAt 超龄）不产生信号', () => {
  const old = base({
    updatedAt: new Date(now - 10 * 86400000).toISOString(), // 10 天前
    steps: [{ id: 'r', title: '旧任务待审', status: 'review' }]
  })
  const r = scanExprSignals(old, { now, maxAgeMs: 172800000 }) // 48h 窗口
  assert.deepEqual(r.signals, [])
})

test('maxAgeMs：窗口内待办仍报信号', () => {
  const fresh = base({ steps: [{ id: 'r', title: '新待审', status: 'review' }] })
  const r = scanExprSignals(fresh, { now, maxAgeMs: 172800000 })
  assert.ok(r.signals.includes('review-pending'))
})

test('scanExprSignals：无效输入容错', () => {
  assert.deepEqual(scanExprSignals(null).signals, [])
  assert.deepEqual(scanExprSignals({}).signals, [])
})

// ---- ccfeat-20260915-unclaimed: unclaimed-pending（可执行但无人认领）----

test('unclaimed-pending：pending + 依赖已 approved + updatedAt 超阈值 → 报信号（含步骤 id）', () => {
  const st = base({
    status: 'open',
    updatedAt: new Date(now - 3600000).toISOString(), // 1h 前，超默认 30 分钟阈值
    steps: [
      { id: 6, title: '前置步骤', status: 'approved' },
      { id: 7, title: '被漏掉的步骤', status: 'pending', depends_on: [6] }
    ]
  })
  const r = scanExprSignals(st, { now })
  assert.ok(r.signals.includes('unclaimed-pending'))
  assert.ok(r.detail.some((d) => d.includes('7') && d.includes('被漏掉的步骤')))
})

test('unclaimed-pending：pending + 依赖已 approved 但 updatedAt 未超阈值 → 不报', () => {
  const st = base({
    status: 'open',
    updatedAt: new Date(now - 60000).toISOString(), // 1 分钟前，未超默认 30 分钟阈值
    steps: [
      { id: 6, title: '前置步骤', status: 'approved' },
      { id: 7, title: '待认领', status: 'pending', depends_on: [6] }
    ]
  })
  const r = scanExprSignals(st, { now })
  assert.ok(!r.signals.includes('unclaimed-pending'))
})

test('unclaimed-pending：pending 但依赖尚未 approved → 不报', () => {
  const st = base({
    status: 'open',
    updatedAt: new Date(now - 3600000).toISOString(),
    steps: [
      { id: 6, title: '前置步骤', status: 'executing' },
      { id: 7, title: '还不能做', status: 'pending', depends_on: [6] }
    ]
  })
  const r = scanExprSignals(st, { now })
  assert.ok(!r.signals.includes('unclaimed-pending'))
})

test('unclaimed-pending：已 finalized / 已归档 → 不报（前置守卫仍生效）', () => {
  const finalized = base({
    status: 'done', finalized: true,
    updatedAt: new Date(now - 3600000).toISOString(),
    steps: [
      { id: 6, status: 'approved' },
      { id: 7, status: 'pending', depends_on: [6] }
    ]
  })
  assert.ok(!scanExprSignals(finalized, { now }).signals.includes('unclaimed-pending'))

  const archivedTest = base({
    isTest: true, status: 'done', finalized: false,
    updatedAt: new Date(now - 3600000).toISOString(),
    steps: [
      { id: 6, status: 'approved' },
      { id: 7, status: 'pending', depends_on: [6] }
    ]
  })
  assert.ok(!scanExprSignals(archivedTest, { now }).signals.includes('unclaimed-pending'))
})

test('unclaimed-pending：依赖已满足但步骤是 executing 或 review → 不报（分别由既有信号负责）', () => {
  const executing = base({
    status: 'open',
    updatedAt: new Date(now - 3600000).toISOString(),
    steps: [
      { id: 6, status: 'approved' },
      { id: 7, status: 'executing', depends_on: [6] }
    ]
  })
  assert.ok(!scanExprSignals(executing, { now }).signals.includes('unclaimed-pending'))

  const review = base({
    status: 'open',
    updatedAt: new Date(now - 3600000).toISOString(),
    steps: [
      { id: 6, status: 'approved' },
      { id: 7, status: 'review', depends_on: [6] }
    ]
  })
  const r = scanExprSignals(review, { now })
  assert.ok(!r.signals.includes('unclaimed-pending'))
  assert.ok(r.signals.includes('review-pending'))
})

test('unclaimed-pending：unclaimedMs 可经 opts 注入覆盖（传 1000 立即触发），默认值为 1800000', () => {
  const st = base({
    status: 'open',
    updatedAt: new Date(now - 2000).toISOString(), // 2s 前
    steps: [
      { id: 6, status: 'approved' },
      { id: 7, status: 'pending', depends_on: [6] }
    ]
  })
  // 默认阈值（30 分钟）下不触发
  assert.ok(!scanExprSignals(st, { now }).signals.includes('unclaimed-pending'))
  // 注入 unclaimedMs:1000（1 秒）后立即触发
  assert.ok(scanExprSignals(st, { now, unclaimedMs: 1000 }).signals.includes('unclaimed-pending'))
})

test('unclaimed-pending：depends_on 缺失/空数组视为无依赖，天然满足', () => {
  const st = base({
    status: 'open',
    updatedAt: new Date(now - 3600000).toISOString(),
    steps: [{ id: 1, title: '首步骤', status: 'pending' }]
  })
  const r = scanExprSignals(st, { now })
  assert.ok(r.signals.includes('unclaimed-pending'))
})

test('unclaimed-pending：全部步骤已 approved 时仍只报 finalize-pending（不被 unclaimed-pending 吞并）', () => {
  const st = base({
    status: 'open',
    updatedAt: new Date(now - 3600000).toISOString(),
    steps: [{ id: 1, status: 'approved' }, { id: 2, status: 'approved' }]
  })
  const r = scanExprSignals(st, { now })
  assert.ok(r.signals.includes('finalize-pending'))
  assert.ok(!r.signals.includes('unclaimed-pending'))
})

// ---- ccfeat-20260915-wakeledger: exprFingerprint / evaluateWakeOutcomes ----

const stFor = (over) => base({
  steps: [{ id: 1, status: 'executing', reviewedBy: null, notes: [{ at: new Date(now - 5000).toISOString(), action: 'start' }] }],
  ...over
})

test('exprFingerprint：步骤状态变化 → 指纹不同', () => {
  const a = stFor({ steps: [{ id: 1, status: 'executing', notes: [] }] })
  const b = stFor({ steps: [{ id: 1, status: 'review', notes: [] }] })
  assert.notEqual(exprFingerprint(a), exprFingerprint(b))
})

test('exprFingerprint：新增 note（status 不变）→ 指纹不同', () => {
  const notesA = [{ at: new Date(now - 5000).toISOString(), action: 'start' }]
  const notesB = [...notesA, { at: new Date(now - 1000).toISOString(), action: 'progress' }]
  const a = stFor({ steps: [{ id: 1, status: 'executing', notes: notesA }] })
  const b = stFor({ steps: [{ id: 1, status: 'executing', notes: notesB }] })
  assert.notEqual(exprFingerprint(a), exprFingerprint(b))
})

test('exprFingerprint：收口（finalize）→ 指纹不同', () => {
  const before = stFor({ status: 'open', finalized: false, steps: [{ id: 1, status: 'approved', notes: [] }] })
  const after = stFor({ status: 'done', finalized: true, steps: [{ id: 1, status: 'approved', notes: [] }] })
  assert.notEqual(exprFingerprint(before), exprFingerprint(after))
})

test('exprFingerprint：同一状态两次调用 → 指纹相同（稳定）', () => {
  const st = stFor({})
  assert.equal(exprFingerprint(st), exprFingerprint(st))
  // 深拷贝出的等价对象也应得到相同指纹（指纹只取决于状态内容，不取决于对象身份）
  assert.equal(exprFingerprint(st), exprFingerprint(JSON.parse(JSON.stringify(st))))
})

test('exprFingerprint：无效输入容错（返回空串，不抛错）', () => {
  assert.equal(exprFingerprint(null), '')
  assert.equal(exprFingerprint(undefined), '')
  assert.equal(exprFingerprint({}), exprFingerprint({}))
})

test('evaluateWakeOutcomes：状态变了 → changed', () => {
  const st0 = stFor({ steps: [{ id: 1, status: 'executing', notes: [] }] })
  const entry = { exprs: [{ exprId: st0.exprId, fingerprint: exprFingerprint(st0) }], outcomes: {} }
  const st1 = stFor({ steps: [{ id: 1, status: 'approved', notes: [] }] })
  const out = evaluateWakeOutcomes(entry, [st1])
  assert.equal(out[st0.exprId], 'changed')
})

test('evaluateWakeOutcomes：状态没变 → unchanged', () => {
  const st0 = stFor({ steps: [{ id: 1, status: 'executing', notes: [] }] })
  const entry = { exprs: [{ exprId: st0.exprId, fingerprint: exprFingerprint(st0) }], outcomes: {} }
  const out = evaluateWakeOutcomes(entry, [st0])
  assert.equal(out[st0.exprId], 'unchanged')
})

test('evaluateWakeOutcomes：expr 已不存在 → gone', () => {
  const st0 = stFor({})
  const entry = { exprs: [{ exprId: st0.exprId, fingerprint: exprFingerprint(st0) }], outcomes: {} }
  const out = evaluateWakeOutcomes(entry, [])
  assert.equal(out[st0.exprId], 'gone')
})

test('evaluateWakeOutcomes：fail-open——畸形 entry（缺 exprs / 非法字段）不抛错', () => {
  assert.doesNotThrow(() => evaluateWakeOutcomes(null, []))
  assert.doesNotThrow(() => evaluateWakeOutcomes({}, []))
  assert.doesNotThrow(() => evaluateWakeOutcomes({ exprs: 'not-an-array' }, []))
  assert.doesNotThrow(() => evaluateWakeOutcomes({ exprs: [null, 42, { noExprId: true }] }, []))
  assert.deepEqual(evaluateWakeOutcomes({}, []), {})
  assert.deepEqual(evaluateWakeOutcomes({ exprs: [null, 42, { noExprId: true }] }, 'not-an-array'), {})
})

// ---- ccfeat-20260915-wakeledger: 台账上限 20 条（镜像 lib/index.js heartbeatTick 内 wakeLedger.push
// + splice 逻辑——该逻辑是 apply() 闭包内状态，不可直接 import，故以镜像函数复测；
// 与 test/artifacts-update.test.js 对 apply() 闭包内逻辑的既有测试方式一致）----
function pushLedgerCapped(ledger, entry, cap = 20) {
  ledger.push(entry)
  if (ledger.length > cap) ledger.splice(0, ledger.length - cap)
  return ledger
}

test('唤醒台账容量上限 20 条：第 21 条挤掉最旧', () => {
  let ledger = []
  for (let i = 0; i < 21; i++) {
    pushLedgerCapped(ledger, { at: i, exprs: [], signals: [], sessionId: 's', agentWoken: true, reason: null, outcomes: {} })
  }
  assert.equal(ledger.length, 20)
  assert.equal(ledger[0].at, 1) // 第 0 条（最旧）被挤掉
  assert.equal(ledger[ledger.length - 1].at, 20)
})

// ---- ccfeat-20260915-wakeledger: 源码契约（顺序守卫）——heartbeatTick 内结算调用必须早于
// 「if (pending.length === 0) return」，否则「无新待办」的轮次永远不会结算台账 ----
test('源码契约：lib/index.js heartbeatTick 内结算调用位置早于 pending===0 的 early return', () => {
  const indexPath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const src = readFileSync(indexPath, 'utf8')
  const fnStart = src.indexOf('async function heartbeatTick')
  assert.ok(fnStart >= 0, '应能定位 heartbeatTick 函数定义')
  // heartbeatTick 之后到下一个顶层块（GC 定时化注释）之间即函数体，足够覆盖两个断言锚点
  let fnEnd = src.indexOf('// v3.8 Step2（GC 定时化）', fnStart)
  if (fnEnd < 0) fnEnd = fnStart + 6000
  const body = src.slice(fnStart, fnEnd)
  const settleIdx = body.indexOf('settleWakeLedger(')
  const earlyReturnIdx = body.indexOf('if (pending.length === 0) return')
  assert.ok(settleIdx >= 0, '应能在 heartbeatTick 函数体内找到台账结算调用（settleWakeLedger）')
  assert.ok(earlyReturnIdx >= 0, '应能在 heartbeatTick 函数体内找到 pending===0 的 early return')
  assert.ok(settleIdx < earlyReturnIdx, '结算调用必须早于 early return——否则无新待办的轮次永远不结算台账')
})

// ---------------------------------------------------------------------------
// ccfeat-20260916-quotasuppress: shouldSuppressWake（配额感知抑制纯函数）
// ---------------------------------------------------------------------------

test('shouldSuppressWake：quotaWaiting=true 且 pending 全部只含 unclaimed-pending → true', () => {
  const pending = [
    { exprId: 'e1', signals: ['unclaimed-pending'] },
    { exprId: 'e2', signals: ['unclaimed-pending'] }
  ]
  assert.equal(shouldSuppressWake({ pending, quotaWaiting: true }), true)
})

test('shouldSuppressWake：单个 pending 项只含 unclaimed-pending → true', () => {
  assert.equal(shouldSuppressWake({ pending: [{ exprId: 'e1', signals: ['unclaimed-pending'] }], quotaWaiting: true }), true)
})

test('shouldSuppressWake：混入 review-pending（或任一其它信号）→ false（必须照常唤醒）', () => {
  const withReview = [
    { exprId: 'e1', signals: ['unclaimed-pending'] },
    { exprId: 'e2', signals: ['review-pending'] }
  ]
  assert.equal(shouldSuppressWake({ pending: withReview, quotaWaiting: true }), false)
  for (const sig of ['review-pending', 'rejected-pending', 'finalize-pending', 'executing-stale', 'resume-circuit-paused']) {
    const p = [{ exprId: 'e1', signals: [sig] }]
    assert.equal(shouldSuppressWake({ pending: p, quotaWaiting: true }), false, `信号 ${sig} 不应被抑制`)
  }
})

test('shouldSuppressWake：多项中有一项含额外信号（unclaimed-pending + executing-stale）→ false', () => {
  const pending = [
    { exprId: 'e1', signals: ['unclaimed-pending'] },
    { exprId: 'e2', signals: ['unclaimed-pending', 'executing-stale'] }
  ]
  assert.equal(shouldSuppressWake({ pending, quotaWaiting: true }), false)
})

test('shouldSuppressWake：quotaWaiting=false → false（即使全部只有 unclaimed-pending）', () => {
  const pending = [{ exprId: 'e1', signals: ['unclaimed-pending'] }]
  assert.equal(shouldSuppressWake({ pending, quotaWaiting: false }), false)
  assert.equal(shouldSuppressWake({ pending }), false)
})

test('shouldSuppressWake：pending 为空数组 → false', () => {
  assert.equal(shouldSuppressWake({ pending: [], quotaWaiting: true }), false)
})

test('shouldSuppressWake：signals 缺失/非数组/空数组 → false，不抛错', () => {
  assert.equal(shouldSuppressWake({ pending: [{ exprId: 'e1' }], quotaWaiting: true }), false)
  assert.equal(shouldSuppressWake({ pending: [{ exprId: 'e1', signals: 'unclaimed-pending' }], quotaWaiting: true }), false)
  assert.equal(shouldSuppressWake({ pending: [{ exprId: 'e1', signals: [] }], quotaWaiting: true }), false)
  assert.doesNotThrow(() => shouldSuppressWake({ pending: [null, undefined, 42], quotaWaiting: true }))
  assert.equal(shouldSuppressWake({ pending: [null], quotaWaiting: true }), false)
})

test('shouldSuppressWake：pending 非数组/整体缺失参数 → false，不抛错', () => {
  assert.equal(shouldSuppressWake({ pending: null, quotaWaiting: true }), false)
  assert.equal(shouldSuppressWake({ quotaWaiting: true }), false)
  assert.doesNotThrow(() => shouldSuppressWake())
  assert.equal(shouldSuppressWake(), false)
})

// ---- ccfeat-20260916-quotasuppress: 唤醒台账「抑制记录」结构（结构断言，字段与 lib/index.js
// heartbeatTick 内 wakeLedger.push(...) 保持一致——见 §20 文档） ----
test('唤醒台账抑制记录结构：含 suppressed 与 quotaResetsAt，agentWoken=false，sessionId=null', () => {
  const st = stFor({ steps: [{ id: 1, status: 'pending', notes: [] }] })
  const pending = [{ exprId: st.exprId, signals: ['unclaimed-pending'], detail: [] }]
  const quotaResetsAt = '2026-09-17T00:00:00.000Z'
  // 镜像 heartbeatTick 内抑制分支的台账构造逻辑（该分支位于 apply() 闭包内不可直接 import，
  // 与 §18.8 既有的镜像测试方式一致）
  const entry = {
    at: new Date().toISOString(),
    exprs: pending.map((p) => ({ exprId: p.exprId, fingerprint: exprFingerprint(st) })),
    signals: [...new Set(pending.flatMap((p) => p.signals))],
    sessionId: null,
    agentWoken: false,
    reason: 'suppressed:quota-wait',
    suppressed: 'quota-wait',
    quotaResetsAt,
    outcomes: {}
  }
  assert.equal(entry.agentWoken, false)
  assert.equal(entry.sessionId, null)
  assert.equal(entry.suppressed, 'quota-wait')
  assert.equal(entry.reason, 'suppressed:quota-wait')
  assert.equal(entry.quotaResetsAt, quotaResetsAt)
  assert.deepEqual(entry.signals, ['unclaimed-pending'])
  assert.deepEqual(entry.outcomes, {})
  assert.equal(entry.exprs[0].exprId, st.exprId)
})

// ---- ccfeat-20260916-quotasuppress: settleWakeLedger 跳过 suppressed 条目（镜像 lib/index.js
// settleWakeLedger 逻辑复测，理由同 §18.8——该函数位于 apply() 闭包内不可直接 import）----
function mirrorSettleWakeLedger(ledger, currentStates) {
  for (const entry of ledger) {
    if (entry && entry.suppressed) continue
    if (!entry || !entry.outcomes || Object.keys(entry.outcomes).length > 0) continue
    entry.outcomes = evaluateWakeOutcomes(entry, currentStates)
  }
  return ledger
}

test('settleWakeLedger（镜像）：跳过 suppressed 条目——outcomes 保持为空、不被回填', () => {
  const st = stFor({ steps: [{ id: 1, status: 'pending', notes: [] }] })
  const suppressedEntry = {
    at: new Date().toISOString(),
    exprs: [{ exprId: st.exprId, fingerprint: exprFingerprint(st) }],
    signals: ['unclaimed-pending'],
    sessionId: null,
    agentWoken: false,
    reason: 'suppressed:quota-wait',
    suppressed: 'quota-wait',
    quotaResetsAt: '2026-09-17T00:00:00.000Z',
    outcomes: {}
  }
  const normalEntry = {
    at: new Date().toISOString(),
    exprs: [{ exprId: st.exprId, fingerprint: 'stale-fingerprint-that-will-not-match' }],
    signals: ['review-pending'],
    sessionId: 's1',
    agentWoken: true,
    reason: null,
    outcomes: {}
  }
  const ledger = [suppressedEntry, normalEntry]
  mirrorSettleWakeLedger(ledger, [st])
  assert.deepEqual(suppressedEntry.outcomes, {}, 'suppressed 条目 outcomes 不应被回填')
  assert.notDeepEqual(normalEntry.outcomes, {}, '普通条目仍应正常结算')
  assert.equal(normalEntry.outcomes[st.exprId], 'changed')
})

// ---- ccfeat-20260916-quotasuppress: 源码契约——heartbeatTick 内配额抑制判定必须早于
// wakeMainAgent 调用，且抑制记录写入 suppressed/quotaResetsAt/agentWoken:false ----
test('源码契约：lib/index.js heartbeatTick 内配额抑制路径早于 wakeMainAgent 调用', () => {
  const indexPath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const src = readFileSync(indexPath, 'utf8')
  const fnStart = src.indexOf('async function heartbeatTick')
  assert.ok(fnStart >= 0, '应能定位 heartbeatTick 函数定义')
  let fnEnd = src.indexOf('// v3.8 Step2（GC 定时化）', fnStart)
  if (fnEnd < 0) fnEnd = fnStart + 10000
  const body = src.slice(fnStart, fnEnd)
  const suppressIdx = body.indexOf("reason: 'suppressed:quota-wait'")
  const wakeCallIdx = body.indexOf('await wakeMainAgent(')
  const lastInjectionAssignIdx = body.indexOf('lastHeartbeatInjection = Date.now()')
  assert.ok(suppressIdx >= 0, '应能在 heartbeatTick 内找到抑制记录的 reason 字段')
  assert.ok(wakeCallIdx >= 0, '应能在 heartbeatTick 内找到 wakeMainAgent 调用')
  assert.ok(suppressIdx < wakeCallIdx, '配额抑制判定必须在 wakeMainAgent 调用之前完成')
  assert.ok(suppressIdx < lastInjectionAssignIdx, '抑制分支必须在 lastHeartbeatInjection 赋值语句之前（抑制路径不得更新防频时间戳）')
  assert.match(body, /suppressed:\s*'quota-wait'/, '台账抑制记录应含 suppressed 字段')
  assert.match(body, /quotaResetsAt/, '台账抑制记录应含 quotaResetsAt 字段')
  assert.match(body, /agentWoken:\s*false/, '抑制记录 agentWoken 应为 false')
  assert.match(body, /shouldSuppressWake\(/, 'heartbeatTick 应调用 shouldSuppressWake 判定')
})

// ---- ccfeat-20260922-reopenwake（L-2026-0922-100）: 终态任务上的 reopen/start 已 approved 步骤不得再产生「请执行」交接 ----
// 背景：补证据时对已 approved 步骤反复 reopen → 每次 reopen 都往会话队列堆一条「请执行 Step N」回合，
// 收口后仍被逐条投递（实测 15 次 reopen → 收到 Step 7/5/6 三条陈旧唤醒，诱导重做已完成的工作）。
test('shouldWakeOnStepTransition：终态 + 步骤已 approved → 抑制唤醒（返工动作不是新工作）', () => {
  const step = { id: '5', status: 'approved' }
  for (const state of [{ finalized: true, status: 'done' }, { finalized: false, status: 'paused' }, { finalized: false, status: 'stopped' }]) {
    for (const action of ['reopen', 'start']) {
      const r = shouldWakeOnStepTransition({ action, step, state })
      assert.equal(r.wake, false, `${action} + 终态(${state.status}) 应抑制唤醒`)
      assert.equal(r.suppressed, true)
      assert.match(String(r.reason), /返工|终态/, '抑制必须给出可读原因（供留痕）')
    }
  }
})

test('shouldWakeOnStepTransition：未终态任务照常放行（reopen 是正常重提流程）', () => {
  const step = { id: '5', status: 'approved' }
  for (const status of ['open', 'executing']) {
    const r = shouldWakeOnStepTransition({ action: 'reopen', step, state: { finalized: false, status } })
    assert.equal(r.wake, true, `未终态(${status}) 必须照常唤醒`)
    assert.equal(r.suppressed, false)
  }
})

test('shouldWakeOnStepTransition：终态但步骤非 approved → 放行（仍可能是真实待办）', () => {
  const state = { finalized: true, status: 'done' }
  for (const st of ['pending', 'review', 'rejected', 'executing']) {
    assert.equal(shouldWakeOnStepTransition({ action: 'reopen', step: { id: '5', status: st }, state }).wake, true, `步骤 ${st} 应放行`)
  }
})

test('shouldWakeOnStepTransition：非 reopen/start 一律放行（本判据只管这两类交接）', () => {
  const state = { finalized: true, status: 'done' }
  const step = { id: '5', status: 'approved' }
  for (const action of ['complete', 'approve', 'reject', 'resume', 'stop']) {
    assert.equal(shouldWakeOnStepTransition({ action, step, state }).wake, true, `${action} 不应被本判据拦截`)
  }
})

test('shouldWakeOnStepTransition：参数缺失/畸形 fail-open 放行（唤醒通路宁可多唤不可静默不唤）', () => {
  assert.equal(shouldWakeOnStepTransition({}).wake, true)
  assert.equal(shouldWakeOnStepTransition({ action: 'reopen' }).wake, true)
  assert.equal(shouldWakeOnStepTransition({ action: 'reopen', step: null, state: null }).wake, true)
  assert.equal(shouldWakeOnStepTransition({ action: 'reopen', step: { id: '5', status: 'approved' }, state: {} }).wake, true)
})

test('源码契约：lib/index.js 的 reopen/start 交接必须经 shouldWakeOnStepTransition 闸门', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const i = src.indexOf("if (action === 'reopen' || action === 'start') {")
  assert.ok(i >= 0, '应能定位 reopen/start 交接块')
  const body = src.slice(i, i + 4000)
  const gateIdx = body.indexOf('shouldWakeOnStepTransition(')
  const wakeIdx = body.indexOf('await wakeMainAgent({ sessionId, handoffText })')
  assert.ok(gateIdx >= 0, '交接块内必须调用 shouldWakeOnStepTransition')
  assert.ok(wakeIdx >= 0, '交接块内应有 wakeMainAgent 调用')
  assert.ok(gateIdx < wakeIdx, '闸门判定必须在 wakeMainAgent 调用之前')
  assert.match(body, /suppressed-rework-on-terminal/, '抑制时必须有可 grep 的留痕 decision')
})

// ---- ccfeat-20260922-wakecoalesce: 唤醒合并/去重（同一逻辑目标的重复唤醒不追加回合）----
// 背景：wakeMainAgent 用 mode:'queue' 追加整回合且不去重，同一步骤反复触发会线性堆积
// （实测单 expr 峰值队列 54，日志里「请执行 Step N」交接 60 条，同一 Step 7 占 8 条）。
test('buildWakeKey：同一逻辑目标 → 同一键；不同步骤/动作/会话 → 不同键', () => {
  const a = buildWakeKey({ sessionId: 's1', action: 'reopen', exprId: 'e1', stepId: '7' })
  assert.equal(a, buildWakeKey({ sessionId: 's1', action: 'reopen', exprId: 'e1', stepId: '7' }), '同输入必须同键')
  assert.notEqual(a, buildWakeKey({ sessionId: 's1', action: 'reopen', exprId: 'e1', stepId: '8' }), '不同步骤必须不同键')
  assert.notEqual(a, buildWakeKey({ sessionId: 's1', action: 'start', exprId: 'e1', stepId: '7' }), '不同动作必须不同键')
  assert.notEqual(a, buildWakeKey({ sessionId: 's2', action: 'reopen', exprId: 'e1', stepId: '7' }), '不同会话必须不同键')
  assert.ok(buildWakeKey({ sessionId: 's1', action: 'heartbeat-pending' }).startsWith('s1|heartbeat-pending'), '无 exprId 也应可构造')
})

test('coalesceWake：首次放行并记录时刻', () => {
  const now = 1_000_000
  const r = coalesceWake({ logicalKey: 'k', lastWakeAt: {}, now })
  assert.equal(r.send, true)
  assert.equal(r.suppressed, false)
  assert.equal(r.lastWakeAt.k, now, '必须记录本次投递时刻')
})

test('[NEG] coalesceWake：冷却窗内重复触发 → 不追加回合（这是防堆积的关键）', () => {
  const t0 = 1_000_000
  const first = coalesceWake({ logicalKey: 'k', lastWakeAt: {}, now: t0 })
  const second = coalesceWake({ logicalKey: 'k', lastWakeAt: first.lastWakeAt, now: t0 + 1000 })
  assert.equal(second.send, false, '1 秒后重复必须被合并（不追加回合）')
  assert.equal(second.suppressed, true)
  assert.match(String(second.reason), /冷却窗内重复唤醒/, '必须给出可读原因（供留痕 grep）')
  // 边界：恰好等于冷却窗 → 放行
  const atEdge = coalesceWake({ logicalKey: 'k', lastWakeAt: first.lastWakeAt, now: t0 + WAKE_COALESCE_MS_DEFAULT })
  assert.equal(atEdge.send, true, '恰好到冷却窗边界应放行')
  // 窗内反复触发不会"漏窗"：时刻被刷新，窗外仍从最后一次算起
  const third = coalesceWake({ logicalKey: 'k', lastWakeAt: second.lastWakeAt, now: t0 + 2000 })
  assert.equal(third.send, false)
  assert.equal(third.lastWakeAt.k, t0 + 2000, '窗内抑制也要刷新时刻（防窗外补唤）')
})

test('[NEG] coalesceWake：不同逻辑目标互不影响（防误杀真实待办）', () => {
  const t0 = 1_000_000
  const a = coalesceWake({ logicalKey: 'step7', lastWakeAt: {}, now: t0 })
  const b = coalesceWake({ logicalKey: 'step8', lastWakeAt: a.lastWakeAt, now: t0 + 1000 })
  assert.equal(b.send, true, '另一目标必须放行')
  assert.equal(b.suppressed, false)
})

test('coalesceWake：缺 key / now 非法 → fail-open 放行（唤醒通路宁可多唤不可静默不唤）', () => {
  assert.equal(coalesceWake({ logicalKey: null, lastWakeAt: {}, now: 1 }).send, true)
  assert.equal(coalesceWake({ logicalKey: 'k', lastWakeAt: {}, now: NaN }).send, true)
  assert.equal(coalesceWake({ logicalKey: 'k', lastWakeAt: {}, now: 0 }).send, true)
  assert.equal(coalesceWake({}).send, true)
})

test('coalesceWake：冷却窗可注入（便于按场景调参）', () => {
  const t0 = 5_000_000
  const r = coalesceWake({ logicalKey: 'k', lastWakeAt: { k: t0 }, now: t0 + 30_000, coalesceMs: 60_000 })
  assert.equal(r.send, false, '30s < 60s 应抑制')
  const r2 = coalesceWake({ logicalKey: 'k', lastWakeAt: { k: t0 }, now: t0 + 30_000, coalesceMs: 10_000 })
  assert.equal(r2.send, true, '30s > 10s 应放行')
})

test('源码契约：wakeMainAgent 的去重判定必须早于 apiProxy 调用', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const i = src.indexOf('async function wakeMainAgent(')
  assert.ok(i >= 0, '应能定位 wakeMainAgent')
  const body = src.slice(i, i + 2200)
  const coalesceIdx = body.indexOf('coalesceWake(')
  const promptIdx = body.indexOf('apiProxy.sessions.prompt(')
  assert.ok(coalesceIdx >= 0, 'wakeMainAgent 内必须调用 coalesceWake')
  assert.ok(promptIdx >= 0, 'wakeMainAgent 内应仍有 apiProxy.sessions.prompt 调用')
  assert.ok(coalesceIdx < promptIdx, '去重判定必须在真正投递之前（否则照旧堆积）')
  assert.match(body, /suppressed-coalesced/, '抑制时必须有可 grep 的留痕 decision')
})
