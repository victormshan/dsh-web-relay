// v4.9.2: 心跳自查信号扫描单测（真实模块 lib/heartbeat-scan.js）
// 运行：node --test test/heartbeat-scan.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { scanExprSignals, scanPendingSignals, exprFingerprint, evaluateWakeOutcomes } from '../lib/heartbeat-scan.js'

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
