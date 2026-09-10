// dsh-web-relay · v4.0 宿主重启续跑（cross-restart resume）纯函数模块（lib/resume-scan.js）
// 语义（外部 AI expr-2026-09-05_13-35-19 设计）：续跑 = 重读落盘 steps.json + 触发新 turn，
// 不恢复 LLM 推理上下文。字段：sessionId（唤醒用）/ bootId（宿主进程标识，写盘打戳）/
// restartCount（同一任务跨重启续接次数，≥2 熔断 paused，防死循环）。

// 判定「跨宿主重启被中断」：状态忙（executing/review/activeSteps 非空）且 bootId ≠ 当前宿主 bootId（
// bootId 为空=旧版未打戳的 expr → 不误判）
export function isExprInterrupted(state, currentBootId) {
  if (!state || !currentBootId) return false
  // paused/stopped（已熔断/已叫停）不参与续跑扫描——即使 activeSteps 残留也不判忙，
  // 防已熔断任务在每次宿主重启时 restartCount 无限 +1 并重复刷熔断日志（96-96-96 2→3 案例）
  if (state.status === 'paused' || state.status === 'stopped') return false
  const busy = state.status === 'executing' || state.status === 'review' || (Array.isArray(state.activeSteps) && state.activeSteps.length > 0)
  const crossBoot = !!state.bootId && state.bootId !== currentBootId
  return busy && crossBoot
}

// 续跑决策：none（未中断）/ resume（可续，restartCount+1）/ pause（restartCount ≥ maxRestarts 熔断）
// v4.9.3（lesson 048 改进）: 区分「有进展的重启」与「反复中断」——熔断的语义是"同一断点反复
// 中断且无进展"，但原实现只按跨 bootId 次数计数，导致**有意的连续重启**（如验证重启机制 +
// 加载新代码各一次）被误判熔断（实测 expr-2026-09-10_18-42-03 restartCount=2 → paused）。
// 现依据 lastProgressAt（上次续跑排队后是否有步骤状态推进）判定：有进展则计数重置。
export function resumeAction(state, currentBootId, { maxRestarts = 2 } = {}) {
  if (!isExprInterrupted(state, currentBootId)) return { action: 'none', restartCount: state.restartCount || 0 }
  // 有进展 → 视为新一轮（计数从 0 起算），避免误伤"有意重启"
  const progressed = hasProgressSinceResume(state)
  const base = progressed ? 0 : (state.restartCount || 0)
  const restartCount = base + 1
  if (restartCount >= maxRestarts) return { action: 'pause', restartCount, progressed }
  return { action: 'resume', restartCount, progressed }
}

/**
 * 判定"上次续跑排队之后是否有进展"（v4.9.3 / lesson 048）。
 * 判据：步骤状态序列指纹发生变化（有步 approved/rejected/complete 等推进），
 * 或 updatedAt 晚于 resumeQueuedAt 且步骤指纹不同。
 * 无 resumeQueuedAt（从未续跑过）→ false（首次中断应按正常计数）。
 * @param {object} state
 * @returns {boolean}
 */
export function hasProgressSinceResume(state) {
  if (!state || !state.resumeQueuedAt) return false
  const queued = new Date(state.resumeQueuedAt).getTime()
  if (!Number.isFinite(queued)) return false
  const fp = stepFingerprint(state)
  // 有指纹记录 → 直接按指纹比较（记录时刻就是续跑排队时刻，时间戳相同属正常，不能用时间戳卡）
  if (typeof state.progressFingerprint === 'string') {
    return fp !== state.progressFingerprint
  }
  // 无指纹记录（旧 expr）→ 退化为时间戳启发：updatedAt 明显晚于排队时间（>5s）视为有推进
  const stamp = state.updatedAt ? new Date(state.updatedAt).getTime() : 0
  return Number.isFinite(stamp) && stamp - queued > 5000
}

/** 步骤状态指纹：id:status 有序拼接（变化即代表有推进）。 */
export function stepFingerprint(state) {
  const steps = Array.isArray(state && state.steps) ? state.steps : []
  return steps.map((s) => `${s.id}:${s.status}`).join('|')
}

// v4.7.0 (v7_2): 续跑扫描候选过滤——isTest 且已完成（done/finalized）的 expr 视为已归档，
// 不再参与续跑扫描（等效逻辑归档；插件 fs 无删除/移动 API，物理清理受限留档）
export function isScanEligible(state) {
  if (!state) return false
  if (state.isTest === true && (state.status === 'done' || state.status === 'finalized' || state.finalized === true)) return false
  return true
}

// v4.7.0 (v7_1/v7_3): 批量计划——对候选 expr 列表逐个决策，返回不丢顺序的决策数组
// （多会话并发续跑：不同 sessionId 各自独立 queue，无共享可变状态 → 逐个处理即安全无锁冲突）
export function planResumes(states, currentBootId, { maxRestarts = 2 } = {}) {
  const out = []
  for (const st of Array.isArray(states) ? states : []) {
    if (!st || !st.exprId) continue
    if (!isScanEligible(st)) continue
    const dec = resumeAction(st, currentBootId, { maxRestarts })
    if (dec.action !== 'none') out.push({ exprId: st.exprId, sessionId: st.sessionId || null, action: dec.action, restartCount: dec.restartCount })
  }
  return out
}

// resume/pause 用的 handoff 文案（供 wakeMainAgent）
export function resumeHandoff(state, exprId) {
  const step = Array.isArray(state.steps) ? state.steps.find((s) => s.status === 'executing' || s.status === 'review') : null
  return [
    '【dsh-web-relay 宿主自愈重启 · 自动续跑】',
    '',
    `任务: ${exprId}`,
    `断点: ${state.status === 'review' ? '步骤审核中' : state.status === 'executing' ? '步骤执行中' : '有活动步骤'}${step ? `（Step ${step.id} ${step.title || ''}，状态 ${step.status}）` : ''}`,
    '宿主进程已重启（bootId 变化），步骤状态机已落盘保留。',
    '请读取 expr-*.steps.json 与最新三方轨迹，自动接管续跑：executing → 先 git 检查残改再续；review → 直接重触发 /steps/auto-review；全 approved → 直接收口。',
    'rejectStreak/iterationBaseCommit 跨重启保持，勿重置。'
  ].join('\n')
}
