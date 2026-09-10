// v4.0 Step1-3: 宿主重启续跑纯函数测试（镜像 lib/resume-scan.js + lib/index.js 接线）
// 运行：node --test test/resume-scan.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isExprInterrupted, resumeAction, resumeHandoff, isScanEligible, planResumes, hasProgressSinceResume, stepFingerprint } from '../lib/resume-scan.js'

const BOOT_A = 'boot-A'
const BOOT_B = 'boot-B'
function busyState(over = {}) {
  return { status: 'executing', activeSteps: ['1'], bootId: BOOT_A, restartCount: 0, steps: [{ id: '1', status: 'executing', title: 's1' }], ...over }
}

// ---- v4.9.3（lesson 048）: 熔断区分「有进展的重启」vs「反复中断」----

test('stepFingerprint：id:status 有序拼接，状态变化即指纹变化', () => {
  const a = { steps: [{ id: 's1', status: 'executing' }, { id: 's2', status: 'pending' }] }
  const b = { steps: [{ id: 's1', status: 'approved' }, { id: 's2', status: 'pending' }] }
  assert.equal(stepFingerprint(a), 's1:executing|s2:pending')
  assert.notEqual(stepFingerprint(a), stepFingerprint(b))
  assert.equal(stepFingerprint({}), '')
  assert.equal(stepFingerprint(null), '')
})

test('hasProgressSinceResume：无 resumeQueuedAt → false（首次中断按正常计数）', () => {
  assert.equal(hasProgressSinceResume(busyState({ restartCount: 1 })), false)
})

test('hasProgressSinceResume：指纹与续跑时不同 → true（有进展）', () => {
  const st = busyState({
    restartCount: 1,
    resumeQueuedAt: '2026-09-10T19:00:00.000Z',
    progressFingerprint: 's1:executing',
    progressFingerprintAt: '2026-09-10T19:00:00.000Z',
    updatedAt: '2026-09-10T19:10:00.000Z',
    steps: [{ id: 's1', status: 'approved' }],   // 状态推进了
  })
  assert.equal(hasProgressSinceResume(st), true)
})

test('hasProgressSinceResume：指纹相同 → false（无进展）', () => {
  const st = busyState({
    restartCount: 1,
    resumeQueuedAt: '2026-09-10T19:00:00.000Z',
    progressFingerprint: 's1:executing',
    progressFingerprintAt: '2026-09-10T19:00:00.000Z',
    updatedAt: '2026-09-10T19:10:00.000Z',
    steps: [{ id: 's1', status: 'executing' }],  // 仍卡在同一步
  })
  assert.equal(hasProgressSinceResume(st), false)
})

test('resumeAction：有进展 → 计数重置（不熔断，避免误伤有意重启）', () => {
  const st = busyState({
    restartCount: 5,                              // 已达阈值
    resumeQueuedAt: '2026-09-10T19:00:00.000Z',
    progressFingerprint: 's1:executing',
    progressFingerprintAt: '2026-09-10T19:00:00.000Z',
    updatedAt: '2026-09-10T19:10:00.000Z',
    steps: [{ id: 's1', status: 'approved' }],    // 有进展
  })
  const d = resumeAction(st, BOOT_B)
  assert.equal(d.action, 'resume')
  assert.equal(d.restartCount, 1)                 // 从 0 起算 +1
  assert.equal(d.progressed, true)
})

test('resumeAction：无进展且达阈值 → pause（保防死循环语义）', () => {
  const st = busyState({
    restartCount: 1,
    resumeQueuedAt: '2026-09-10T19:00:00.000Z',
    progressFingerprint: 's1:executing',
    progressFingerprintAt: '2026-09-10T19:00:00.000Z',
    updatedAt: '2026-09-10T19:10:00.000Z',
    steps: [{ id: 's1', status: 'executing' }],   // 无进展
  })
  const d = resumeAction(st, BOOT_B)
  assert.equal(d.action, 'pause')
  assert.equal(d.restartCount, 2)
  assert.equal(d.progressed, false)
})

test('resumeAction：首次中断（无续跑记录）行为不变（兼容）', () => {
  const d = resumeAction(busyState({ restartCount: 0 }), BOOT_B)
  assert.equal(d.action, 'resume')
  assert.equal(d.restartCount, 1)
})

test('isExprInterrupted：忙状态 + bootId 跨宿主才算中断', () => {
  assert.equal(isExprInterrupted(busyState(), BOOT_B), true)             // executing + 跨 boot
  assert.equal(isExprInterrupted({ ...busyState(), status: 'review' }, BOOT_B), true)
  assert.equal(isExprInterrupted({ ...busyState(), status: 'open', activeSteps: ['1'] }, BOOT_B), true) // activeSteps 非空
  assert.equal(isExprInterrupted(busyState(), BOOT_A), false)            // 同 boot（当前宿主写入）→ 不中断
  assert.equal(isExprInterrupted({ ...busyState(), bootId: null }, BOOT_B), false) // 旧版未打戳 → 不误判
  assert.equal(isExprInterrupted({ ...busyState(), status: 'approved', activeSteps: [] }, BOOT_B), false) // 非忙（approved+无活动步骤）→ 不误判
  // v4.4.1-fix: paused/stopped（已熔断/已叫停）即使 activeSteps 残留也不判忙（96-96-96 restartCount 2→3 案例）
  assert.equal(isExprInterrupted({ ...busyState(), status: 'paused', activeSteps: ['1'] }, BOOT_B), false)
  assert.equal(isExprInterrupted({ ...busyState(), status: 'stopped', activeSteps: ['1'] }, BOOT_B), false)
  assert.equal(isExprInterrupted(null, BOOT_B), false)
})

test('resumeAction：resume（+1）/ pause（≥max 熔断）/ none', () => {
  assert.deepEqual(resumeAction(busyState({ restartCount: 0 }), BOOT_B), { action: 'resume', restartCount: 1, progressed: false })
  assert.deepEqual(resumeAction(busyState({ restartCount: 1 }), BOOT_B), { action: 'pause', restartCount: 2, progressed: false }) // 第 2 次即熔断（maxRestarts=2）
  assert.deepEqual(resumeAction(busyState(), BOOT_A), { action: 'none', restartCount: 0 })
})

test('resumeHandoff：含断点步骤与续跑指引', () => {
  const t = resumeHandoff(busyState(), 'expr-x')
  assert.ok(t.includes('expr-x'))
  assert.ok(t.includes('Step 1'))
  assert.ok(t.includes('rejectStreak/iterationBaseCommit 跨重启保持'))
})

test('source 标记：lib/index.js 接线（v4.0 重启续跑）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(src.includes("from './resume-scan.js'"))
  assert.ok(src.includes('CURRENT_BOOT_ID'))
  assert.ok(src.includes('bootId: CURRENT_BOOT_ID'))               // writeStepState 打戳
  assert.ok(src.includes('sessionId: data.sessionId || null'))     // readStepState 白名单
  assert.ok(src.includes('restartCount: data.restartCount || 0'))
  assert.ok(src.includes('bootResumeScan'))                         // 启动扫描
  assert.ok(src.includes('重启续跑熔断'))
  assert.ok(src.includes('wakeSid = st.sessionId || process.env.DSH_SESSION_ID'))  // v4.9.1 双回退唤醒
  assert.ok(src.includes('resumeHandoff(st, exprId)'))
  assert.ok(src.includes('sessionId: sessionId || null'))           // askHandler 创建落盘 sessionId
  assert.ok(src.includes('adminResumeScanHandler'))                  // 手动触发端点
  assert.ok(src.includes("'/dsh-web-relay/admin/resume-scan'"))
  assert.ok(src.includes('resumeScanBases'))                         // 候选基准（env > sandbox > cwd）
  assert.ok(src.includes('DSH_RELAY_WORKSPACE'))
  // v4.7 接线：isTest 逻辑归档过滤 + 白名单
  assert.ok(src.includes('isScanEligible(st)'))
  assert.ok(src.includes('isTest: data.isTest === true'))
  assert.ok(src.includes('isTest: state.isTest === true'))
})

// ---- v4.7.0 (v7_1/v7_2/v7_3): isTest 归档 + 多会话并发批量计划 ----
test('isScanEligible：isTest 且已完成 → 跳过（逻辑归档）；其他照常', () => {
  const done = { isTest: true, status: 'done', finalized: true }
  assert.equal(isScanEligible(done), false)
  assert.equal(isScanEligible({ isTest: true, status: 'done', finalized: false }), false)
  assert.equal(isScanEligible({ isTest: true, status: 'executing', finalized: false }), true)  // isTest 进行中仍可续
  assert.equal(isScanEligible({ isTest: false, status: 'done' }), true)                        // 业务 done 由状态机跳过
  assert.equal(isScanEligible(null), false)
})

test('planResumes：多 expr（不同 sessionId）跨 boot 全处理不丢、顺序保持、isTest-done 排除', () => {
  const states = [
    { exprId: 'e1', sessionId: 'sess-A', status: 'executing', activeSteps: ['1'], bootId: BOOT_A },
    { exprId: 'e2', sessionId: 'sess-B', status: 'review', bootId: BOOT_A },
    { exprId: 'e3', sessionId: 'sess-A', status: 'executing', bootId: BOOT_A, isTest: true },
    { exprId: 'e4', sessionId: 'sess-B', status: 'done', finalized: true, bootId: BOOT_A, isTest: true }
  ]
  const plan = planResumes(states, BOOT_B)
  assert.deepEqual(plan.map((p) => p.exprId), ['e1', 'e2', 'e3']) // e4 isTest-done 排除；顺序保持不丢
  assert.equal(plan.length, 3)
  assert.ok(plan.every((p) => p.action === 'resume' && p.restartCount === 1))
  assert.deepEqual(plan.map((p) => p.sessionId), ['sess-A', 'sess-B', 'sess-A']) // 不同会话独立不冲突
})
