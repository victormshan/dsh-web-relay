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
