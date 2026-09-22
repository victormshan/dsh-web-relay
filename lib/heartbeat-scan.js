// dsh-web-relay · v4.9.2 心跳自查信号扫描（lib/heartbeat-scan.js）
// 纯函数：给定 expr 状态数组，判定「需要主 agent 新一轮检查」的信号集（无副作用，便于单测）。
// 双保险续跑：机制 a = 重启事件驱动（bootResumeScan 注入）；机制 b = 本模块时间驱动（宿主周期心跳）——
// 覆盖非重启场景的停滞：review 待审未触发、rejected 待重提、executing 长时间无进展、续跑熔断需介入汇报。

/**
 * 判定单个 expr 的待办信号。
 * @param {object} st expr state（readStepState 输出；含 exprId/status/autoReview/steps/updatedAt/stopReason 等）
 * @param {object} [opts]
 * @param {number} [opts.staleMs=1200000] executing 停滞阈值（默认 20 分钟）
 * @param {number} [opts.maxAgeMs=0] 陈旧过滤：updatedAt 早于 now-maxAgeMs 的 expr 视为历史僵尸，不产生任何信号（0=不过滤）
 * @param {number} [opts.unclaimedMs=1800000] 可执行但无人认领阈值（默认 30 分钟，见 ⑥ unclaimed-pending；与 staleMs 独立，不复用）
 * @param {number} [opts.now=Date.now()]
 * @returns {{exprId: string, signals: string[], detail: string[]}} signals 空 = 无需 agent 介入
 */
export function scanExprSignals(st, { staleMs = 1200000, maxAgeMs = 0, unclaimedMs = 1800000, now = Date.now() } = {}) {
  if (!st || !st.exprId) return { exprId: '', signals: [], detail: [] }
  const signals = []
  const detail = []
  const steps = Array.isArray(st.steps) ? st.steps : []
  // v4.9.3（stab2_3 心跳噪音修复）: 已归档 / 已收口 expr 不产生信号——与 resume-scan 的
  // isScanEligible 语义对齐。实测问题：归档测试快照时只改了 expr 级 status/finalized/isTest，
  // 步骤仍残留 rejected/review 状态 → 每轮心跳都报 rejected-pending/review-pending，
  // 反复打扰主 agent（实测一轮报出 4 个已归档测试 expr）。
  const archived = (st.isTest === true && (st.status === 'done' || st.finalized === true)) || st.finalized === true
  if (archived) return { exprId: st.exprId, signals, detail }
  // 陈旧过滤：心跳场景避免把数周前的遗留 expr 当待办刷屏（其状态多为历史残留，agent 无需介入）
  if (maxAgeMs > 0) {
    const updated = st.updatedAt ? new Date(st.updatedAt).getTime() : 0
    if (updated > 0 && now - updated > maxAgeMs) return { exprId: st.exprId, signals, detail }
  }

  // ① 续跑熔断 paused（stopReason 含「续跑熔断」）——设计上需用户/agent 介入汇报根因
  if (st.status === 'paused' && /续跑熔断|熔断/.test(st.stopReason || '')) {
    signals.push('resume-circuit-paused')
    detail.push(`任务 paused（${st.stopReason}）——需介入：确认根因后 resume 或收口`)
  }

  // ② review 状态步骤待审（autoReview 开启但尚未触发 /steps/auto-review）
  const reviewSteps = steps.filter((s) => s.status === 'review')
  if (reviewSteps.length > 0) {
    signals.push('review-pending')
    detail.push(`有 ${reviewSteps.length} 步待审核：${reviewSteps.map((s) => `Step ${s.id} ${s.title}`).join('、')}——请触发 /steps/auto-review（或手动审）`)
  }

  // ③ rejected 步骤待重提（被打回未重新提交）
  const rejectedSteps = steps.filter((s) => s.status === 'rejected')
  if (rejectedSteps.length > 0) {
    signals.push('rejected-pending')
    detail.push(`有 ${rejectedSteps.length} 步被打回待重提：${rejectedSteps.map((s) => `Step ${s.id}`).join('、')}——请按拒收意见补证据后 reopen→start→complete 重提`)
  }

  // ④ executing 停滞（updatedAt 早于阈值，agent 可能断线未续）
  if (st.status === 'executing') {
    const updated = st.updatedAt ? new Date(st.updatedAt).getTime() : 0
    const execSteps = steps.filter((s) => s.status === 'executing')
    if (updated > 0 && now - updated > staleMs && (execSteps.length > 0 || (Array.isArray(st.activeSteps) && st.activeSteps.length > 0))) {
      signals.push('executing-stale')
      detail.push(`任务 executing 停滞（updatedAt ${st.updatedAt}，超过 ${Math.round(staleMs / 60000)} 分钟无进展）——请检查是否断线：git 残改检查后续跑或收口`)
    }
  }

  // ⑤ 全 approved 但未 finalize（可收口未收口）
  if (steps.length > 0 && steps.every((s) => s.status === 'approved') && st.status !== 'done' && !st.finalized) {
    signals.push('finalize-pending')
    detail.push('全部步骤已 approved 但任务未 finalize——请调 /steps/finalize 收口')
  }

  // ⑥ unclaimed-pending（ccfeat-20260915-unclaimed）：存在可执行（pending 且依赖已 approved）但长期
  // 无人认领的步骤——这是①-⑤都覆盖不到的空隙：链条 items 可能压根没覆盖该 planStepId、或链条已
  // 结束/挂起、或调度窗口已过期，导致该步骤永远不会被自动续跑（真实事故：Step 7 依赖已满足但链条
  // items 未包含它，管线静默 9 小时 57 分才被人工发现）。依赖判定语义与 lib/index.js 的
  // depsSatisfied 保持一致：depends_on 缺失/空数组视为无依赖；否则每个依赖 id 必须能找到对应步骤
  // 且其 status === 'approved'（按 String(id) 比对，容忍 number/string id 混用）。
  // 计时基准用 st.updatedAt（而非「最后一个依赖被 approved 的时刻」）：任何写入该 expr 的操作都会
  // 重置这个计时器，因此该判据天然偏保守、偏少报（宁可晚叫不可误叫）——若某个依赖早已 approved
  // 但 expr 因其它步骤的活动而频繁 touch updatedAt，本信号会被持续推迟。后续可改进方向：改用
  // 「该步骤最后一个依赖被 approve 的时刻」（需读 steps[].notes 里的审批时间戳），能更精确定位
  // 「认领窗口」的起点，但当前先用 updatedAt 这一保守近似，避免过度设计。
  const depsApproved = (s) => {
    const deps = Array.isArray(s.depends_on) ? s.depends_on : []
    if (deps.length === 0) return true
    return deps.every((d) => steps.some((x) => String(x.id) === String(d) && x.status === 'approved'))
  }
  const unclaimedSteps = steps.filter((s) => s.status === 'pending' && depsApproved(s))
  if (unclaimedSteps.length > 0) {
    const updated = st.updatedAt ? new Date(st.updatedAt).getTime() : 0
    if (updated > 0 && now - updated > unclaimedMs) {
      signals.push('unclaimed-pending')
      detail.push(`有 ${unclaimedSteps.length} 步可执行但无人认领（updatedAt ${st.updatedAt}，超过 ${Math.round(unclaimedMs / 60000)} 分钟无进展）：${unclaimedSteps.map((s) => `Step ${s.id} ${s.title || ''}`.trim()).join('、')}——这通常意味着没人会去做它：链条可能未覆盖该步骤、链条可能已结束/挂起，或调度窗口已过期；请主 agent 判断应自行执行还是派发给 cc`)
    }
  }

  return { exprId: st.exprId, signals, detail }
}

/**
 * 批量扫描：给定 state 列表 → 有信号的 expr 数组（保持顺序）。
 * @param {Array<object>} states
 * @param {object} [opts]
 * @returns {Array<{exprId: string, signals: string[], detail: string[]}>}
 */
export function scanPendingSignals(states, opts) {
  const out = []
  for (const st of Array.isArray(states) ? states : []) {
    const r = scanExprSignals(st, opts)
    if (r.signals.length > 0) out.push(r)
  }
  return out
}

// ---------------------------------------------------------------------------
// ccfeat-20260915-wakeledger: 唤醒台账状态指纹 + 核对（纯函数，便于单测）。
// 背景：lastHeartbeatState.injected 只表示「注入调用成功」，不代表主 agent 真的行动了——
// 心跳注入落进一个没人消费的会话时，injected 仍为 true 而实际什么都没发生。这两个函数让
// lib/index.js 的 heartbeatTick 能在下一轮心跳核对「注入时刻」与「当前」的 expr 状态是否变化，
// 从而区分「没唤醒」与「唤醒了没人动」。
// ---------------------------------------------------------------------------

/**
 * 由 expr 的关键状态派生稳定指纹字符串（同一状态多次调用结果相同；状态变化则指纹必变）。
 * 字段选择理由：
 *  - expr 级 status/finalized：覆盖「收口」（全部步骤仍是 approved，但 finalize 后 status/finalized 变化）。
 *  - 每个 step 的 id/status：覆盖「步骤状态变化」（pending→executing→review→approved/rejected 等）。
 *  - reviewedBy：同一 status 下审核来源也可能变化（如打回后清空又重新记录），单看 status 会漏判。
 *  - notes.length + 最后一条 note 的 at：覆盖「新增 note 但 status 未变」的情形（例如追加说明/续跑留痕），
 *    仅比对数组长度不够——若最后一条被覆盖替换（理论上不会发生但保守起见）也能靠 at 变化探测到。
 * 不选整份 JSON.stringify(st) 的原因：st 里混有 updatedAt 等「几乎每次心跳扫描都可能因无关字段被
 * touch」的信息，用它做指纹会导致「什么都没变」也被判定为「changed」，噪音过大。
 * @param {object} st expr state（同 scanExprSignals 的入参）
 * @returns {string} 指纹字符串；输入非法时返回 ''（调用方按「不可比对」处理）
 */
export function exprFingerprint(st) {
  if (!st || typeof st !== 'object') return ''
  const steps = Array.isArray(st.steps) ? st.steps : []
  const parts = [
    `status:${st.status || ''}`,
    `finalized:${st.finalized === true}`,
    ...steps.map((s) => {
      const notes = s && Array.isArray(s.notes) ? s.notes : []
      const lastNote = notes.length > 0 ? notes[notes.length - 1] : null
      const lastAt = (lastNote && lastNote.at) || ''
      return `${s && s.id}|${(s && s.status) || ''}|${(s && s.reviewedBy) || ''}|${notes.length}|${lastAt}`
    })
  ]
  return parts.join('::')
}

/**
 * 给定一条唤醒台账记录与当前状态列表，为每个 exprId 判定 'changed' | 'unchanged' | 'gone'。
 * fail-open：entry / currentStates 畸形（缺 exprs、非法字段等）不抛错，尽力返回已能算出的部分结果。
 * @param {object} entry 台账记录，至少含 exprs: [{ exprId, fingerprint }]
 * @param {Array<object>} currentStates 当前 expr 状态列表
 * @returns {Object<string, 'changed'|'unchanged'|'gone'>}
 */
export function evaluateWakeOutcomes(entry, currentStates) {
  const outcomes = {}
  try {
    const exprs = Array.isArray(entry && entry.exprs) ? entry.exprs : []
    const states = Array.isArray(currentStates) ? currentStates : []
    for (const e of exprs) {
      if (!e || typeof e !== 'object' || !e.exprId) continue
      const cur = states.find((s) => s && s.exprId === e.exprId)
      if (!cur) { outcomes[e.exprId] = 'gone'; continue }
      let curFp = ''
      try { curFp = exprFingerprint(cur) } catch { curFp = '' }
      outcomes[e.exprId] = curFp !== '' && curFp === e.fingerprint ? 'unchanged' : 'changed'
    }
  } catch { /* fail-open：返回已算出的部分结果，不抛错 */ }
  return outcomes
}

// ---------------------------------------------------------------------------
// ccfeat-20260916-quotasuppress: 配额感知抑制（纯函数，便于单测）。
// 背景：lib/cc-chain.mjs 顶部明确「绝不代替协议审核——链条不调 /steps/update」，即链条派发 cc
// 期间步骤状态仍是 pending；而 cc 额度耗尽时链条会停摆等待（实测单段最长 993 分钟），远超
// unclaimed-pending 的 30 分钟阈值。此时下一个待做步骤「可执行 + 无人认领 + updatedAt 超龄」
// 必然触发 ⑥ unclaimed-pending——但管线不是「无人认领」，而是「在等额度」，叫醒主 agent 无事可做。
// 本函数只做这一层抑制，不改变 unclaimed-pending 本身的判据。
// ---------------------------------------------------------------------------

/**
 * 判定本轮待办是否应因「配额已知耗尽 + 全部待办都只是 unclaimed-pending」而抑制唤醒。
 * 必须严格到 pending 中**每一项**的 signals **只含** unclaimed-pending 才抑制：只要还混有
 * review-pending / rejected-pending / finalize-pending / executing-stale / resume-circuit-paused
 * 中任意一个，就必须照常唤醒——那些信号代表的情形不会随配额恢复而自愈（例如打回待重提、
 * 全部 approved 未 finalize），继续抑制会造成真实的响应延迟。
 * fail-open 体现在调用方（heartbeatTick）：本函数自身对畸形输入一律返回 false（不抛错），
 * 畸形输入本就不该被当作「已知只有 unclaimed-pending」，直接不抑制、照常唤醒最安全。
 * @param {object} params
 * @param {Array<{signals: unknown}>} params.pending scanPendingSignals 的输出（本轮待办列表）
 * @param {boolean} params.quotaWaiting 是否已知配额耗尽且未到 resetsAt（见 lib/cc-channel.js
 *   的 shouldSkipForKnownQuotaExhaustion）
 * @returns {boolean} true 表示应跳过本轮唤醒（转为记台账，不注入）
 */
export function shouldSuppressWake({ pending, quotaWaiting } = {}) {
  if (quotaWaiting !== true) return false
  if (!Array.isArray(pending) || pending.length === 0) return false
  return pending.every((p) => {
    const signals = p && Array.isArray(p.signals) ? p.signals : null
    if (!signals || signals.length === 0) return false
    return signals.every((s) => s === 'unclaimed-pending')
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// ccfeat-20260922-reopenwake: 终态任务上的 reopen/start 不应再产生「请执行 Step N」唤醒
//
// 背景（2026-09-22 主 agent 实测事故，L-2026-0922-100）：
//   审核要求补证据时，主 agent 对**已 approved** 的步骤做了 reopen → complete → auto-review
//   的修复循环（同一 expr 内 reopen 累计 15 次）。而 /steps/update 对 reopen/start **无条件**调
//   wakeMainAgent（lib/index.js:3698-3724），且 wakeMainAgent 用 apiProxy.sessions.prompt
//   { mode:'queue' } **逐条排队新回合** → 队列里堆了 15 条「请执行 Step N」交接。
//   任务随后 finalize（13/13 approved），但这些已排队的回合**不会**被追溯取消，
//   于是它们在收口之后被逐条投递（实测收到 Step 7 / Step 5 / Step 6 三条），
//   每条都按**产生时刻**的状态说话 → 表现为「已终态任务仍在喊待办」，诱导主 agent 重做已完成的工作。
//
// 判据（纯函数、可注入、无 IO）：
//   实验已终态（finalized=true 或 status 为 done/paused/stopped）**且**该步骤当前已 approved
//   → 这是**返工动作**（改证据/改产物后重走一遍），不是"有新工作可做"，不应产生执行交接。
//   其余情形一律放行——尤其：
//     · 未终态任务：reopen 是正常流程（打回→重提），必须照常唤醒；
//     · 终态任务 + 非 approved 步骤：仍可能是真实待办（例如 finalize 后又 reopen 出 pending），放行；
//     · 参数缺失/畸形：fail-open 放行（宁可多唤一次，也不静默不唤——唤醒通路的失效与"安静无人值守"现象相同）。
export function shouldWakeOnStepTransition({ action, step, state } = {}) {
  if (action !== 'reopen' && action !== 'start') return { wake: true, suppressed: false, reason: null }
  if (!step || !state) return { wake: true, suppressed: false, reason: null }
  const terminal = state.finalized === true || ['done', 'paused', 'stopped'].includes(state.status)
  if (!terminal) return { wake: true, suppressed: false, reason: null }
  if (step.status !== 'approved') return { wake: true, suppressed: false, reason: null }
  return {
    wake: false,
    suppressed: true,
    reason: `实验已终态（finalized=${state.finalized === true}, status=${state.status}）且 Step ${step.id} 当前为 approved：`
      + 'reopen/start 属返工动作，不产生「请执行」交接（避免终态任务收口后仍被陈旧唤醒反复喊待办）'
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ccfeat-20260922-wakecoalesce: 唤醒合并/去重——同一逻辑目标的重复唤醒不再逐条追加回合
//
// 背景（2026-09-22 用户提问「为什么会有这么多、原来就有一直没解决」后的全历史取证）：
//   wakeMainAgent 固定用 apiProxy.sessions.prompt({ mode: 'queue' })，语义是**追加一个整回合**，
//   既不合并也不去重；而唤醒触发面很宽（reopen/start、审核通过/打回、链条停下等人、心跳待办），
//   彼此不感知。会话在忙时唤醒只能排队 ⇒"同一步骤来回改动"线性累积。
//   实测：单 expr 峰值队列 54（2026-09-22T21:58），日志里「请执行 Step N」交接 60 条，
//   同一 Step 7 一条就占 8 条。平时唤醒分散到达（相邻间隔中位 15 分钟）而单回合中位 95s，
//   消费快于到达 ⇒ 日末必回落到 0；一旦"同一小时内对同一步骤反复 reopen"就会堆起来。
//   （历史同类症状：L-039 重启后延迟投递噪声、L-2026-0922-100 收口后仍喊待办——都是本机制的症状。）
//
// 判据（纯函数、可注入 now、无 IO）：
//   同一 logicalKey（= 会话 + 目标对象 + 动作）在冷却窗内重复触发 → **不追加**，记 suppressed；
//   超出冷却窗或首次出现 → 放行，并记录本次投递时刻供下次比对。
//   缺 sessionId / logicalKey / now 畸形 → fail-open 放行（唤醒通路失效与"安静无人值守"现象相同，
//   宁可多唤一次，也不能静默不唤）。
export const WAKE_COALESCE_MS_DEFAULT = 10 * 60 * 1000

/** 构造唤醒的逻辑目标键（同一键 = 同一件事，重复触发应合并）。 */
export function buildWakeKey({ sessionId, action, exprId, stepId } = {}) {
  const parts = [sessionId || '?', action || '?']
  if (exprId) parts.push(String(exprId))
  if (stepId !== undefined && stepId !== null && stepId !== '') parts.push(`step:${stepId}`)
  return parts.join('|')
}

/**
 * @param {object} o
 * @param {string} o.logicalKey 逻辑目标键（buildWakeKey 产出）
 * @param {Record<string, number>} o.lastWakeAt 历史投递时刻（键 → ms）
 * @param {number} o.now 当前时刻 ms
 * @param {number} [o.coalesceMs] 冷却窗
 * @returns {{ send: boolean, suppressed: boolean, reason: string|null, lastAt: number|null, withinMs: number|null, lastWakeAt: Record<string, number> }}
 */
export function coalesceWake({ logicalKey, lastWakeAt, now, coalesceMs = WAKE_COALESCE_MS_DEFAULT } = {}) {
  const base = { send: true, suppressed: false, reason: null, lastAt: null, withinMs: null, lastWakeAt }
  if (!logicalKey || typeof logicalKey !== 'string') return { ...base, reason: 'logicalKey 缺失 → fail-open 放行' }
  if (!Number.isFinite(now) || now <= 0) return { ...base, reason: 'now 非法 → fail-open 放行' }
  const map = (lastWakeAt && typeof lastWakeAt === 'object') ? lastWakeAt : {}
  const lastAt = Number.isFinite(map[logicalKey]) ? map[logicalKey] : null
  if (lastAt === null) return { ...base, lastWakeAt: { ...map, [logicalKey]: now }, reason: null }
  const withinMs = now - lastAt
  if (withinMs >= 0 && withinMs < coalesceMs) {
    return {
      send: false,
      suppressed: true,
      reason: `同一逻辑目标在冷却窗内重复唤醒（${Math.round(withinMs / 1000)}s < ${Math.round(coalesceMs / 1000)}s）：${logicalKey} —— 不追加回合（合并去重）`,
      lastAt,
      withinMs,
      lastWakeAt: { ...map, [logicalKey]: now }
    }
  }
  return { ...base, lastWakeAt: { ...map, [logicalKey]: now }, lastAt, withinMs }
}
