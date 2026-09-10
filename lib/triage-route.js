/**
 * triage-route.js
 *
 * 混合架构场景路由分流（纯函数，2026-09-10 架构征询落地 P0-1）。
 *
 * 背景：架构征询（外部 AI web-gemini + Claude Code 双方独立作答，均判 conditional）
 * 的共识是——三方协作机制适合默认，但**混合架构（cc 派发）应条件默认**：
 * cc 通道有 4-8 分钟固定开销与硬边界（900s 总超时、无 --resume 无跨进程记忆、
 * 白名单三工具 Read/Write/Bash、无 GUI/常驻、Pro 订阅配额）。
 *
 * 本模块把两方建议的判定规则固化为确定性函数，供接入层（派发决策）调用，
 * 避免"凭感觉派 cc"造成无效等待或配额浪费。
 *
 * 判定信号（调用方从任务上下文收集；缺省值按"保守不启用"处理）：
 *   kind              任务类型：implement | review | understand | refactor | config | probe
 *   changedFiles      预计涉及文件数
 *   iterations        AutoIteration 声明版本数（>1 表示多版本演进）
 *   alternativesCount Step 的 alternatives 候选数（>1 表示多方案裁决）
 *   needsGui          是否需要 GUI/浏览器/真实页面交互（cc 无此能力）
 *   needsCrossSession 是否需要跨会话状态收敛（cc 每次全新进程无记忆）
 *   estimatedSeconds  预估执行秒数（cc runner 上限 900s）
 *   needsHostOnlyTools 是否需要主 agent 专属工具（Glob/Grep/Web/subagent 并发）
 */

/** 默认阈值（可在调用处覆盖）。 */
export const TRIAGE_DEFAULTS = Object.freeze({
  smallChangeMaxFiles: 1,      // ≤1 文件视为局部小改
  multiFileMinFiles: 3,        // ≥3 文件视为跨模块改动（两方专家交集结论）
  ccTimeoutSeconds: 900,       // runner.sh timeout 900
  hugeTaskSeconds: 600,        // 单次 Bash ≤600s 之外的保守预估线
})

/**
 * 判定是否使用混合架构（cc 派发）。
 * @param {object} signals 见文件头说明
 * @param {object} [opts] 阈值覆盖（默认 TRIAGE_DEFAULTS）
 * @returns {{useHybrid: boolean, confidence: 'high'|'medium'|'low', reasons: string[], blockers: string[]}}
 *   useHybrid=true 时 reasons 给出启用依据；=false 时 blockers 给出阻断原因（硬边界优先）
 */
export function decideHybridRoute(signals = {}, opts = {}) {
  const cfg = { ...TRIAGE_DEFAULTS, ...opts }
  const reasons = []
  const blockers = []

  const kind = typeof signals.kind === 'string' ? signals.kind : 'unknown'
  const files = Number.isFinite(signals.changedFiles) ? signals.changedFiles : 0
  const iterations = Number.isFinite(signals.iterations) ? signals.iterations : 1
  const alternatives = Number.isFinite(signals.alternativesCount) ? signals.alternativesCount : 0
  const est = Number.isFinite(signals.estimatedSeconds) ? signals.estimatedSeconds : 0

  // ---- 硬边界（cc 能力之外，任何情况都不派）----
  if (signals.needsGui === true) blockers.push('需要 GUI/浏览器/真实页面交互——cc 无此能力（web-gemini 桥接调试类任务由主 agent 做）')
  if (signals.needsCrossSession === true) blockers.push('需要跨会话状态收敛——cc 每次全新进程、无 --resume、无模型记忆继承')
  if (signals.needsHostOnlyTools === true) blockers.push('需要主 agent 专属工具（Glob/Grep/Web/subagent 并发）——cc 白名单仅 Read/Write/Bash')
  if (est > cfg.ccTimeoutSeconds) blockers.push(`预估 ${est}s 超过 cc runner 上限 ${cfg.ccTimeoutSeconds}s——应由主 agent 先拆分为多个任务`)

  // ---- 豁免条件（不必派：固定开销不划算）----
  const exempt = []
  if (files > 0 && files <= cfg.smallChangeMaxFiles && kind !== 'understand') {
    exempt.push(`涉及文件 ≤${cfg.smallChangeMaxFiles}（局部小改）——避免 4-8 分钟 cc 唤起固定开销`)
  }
  if (kind === 'config' || kind === 'probe') {
    exempt.push(`任务类型 ${kind}（纯配置/环境探路）——主 agent 本地极速完成`)
  }

  // ---- 启用条件（两方专家交集的"默认启用"场景）----
  if (kind === 'implement' || kind === 'refactor') {
    if (files >= cfg.multiFileMinFiles) reasons.push(`代码实现类且涉及文件 ≥${cfg.multiFileMinFiles}（跨模块）`)
    else if (files > cfg.smallChangeMaxFiles) reasons.push(`代码实现类且涉及多文件（${files}）`)
  }
  if (kind === 'understand') reasons.push('静态代码诊断/架构核查——cc 可读全仓代码并给出 file:line 依据')
  if (kind === 'review') reasons.push('代码级评审——cc 有实证价值（POC-3 审出主 agent 与单测均漏检的 refs 共享引用污染）')
  if (iterations > 1) reasons.push(`AutoIteration 多版本演进（iterations=${iterations}）——每版实现/理解步适合派 cc`)
  if (alternatives > 1) reasons.push(`多方案裁决（alternatives=${alternatives}）——适合独立第三方视角`)

  // ---- 合成 ----
  const blocked = blockers.length > 0
  const exempted = exempt.length > 0
  const useHybrid = !blocked && !exempted && reasons.length > 0
  let confidence = 'low'
  if (useHybrid) confidence = reasons.length >= 2 ? 'high' : 'medium'
  else if (blocked) confidence = 'high'      // 硬边界判定明确
  else if (exempted) confidence = 'medium'   // 豁免判定（小改/探路）

  return {
    useHybrid,
    confidence,
    reasons: [...reasons, ...exempt],
    blockers,
  }
}

/**
 * 一行可读结论（供 trace / note / 面板展示）。
 * @param {ReturnType<typeof decideHybridRoute>} decision
 * @returns {string}
 */
export function renderRouteDecision(decision) {
  if (!decision) return 'route: 未判定'
  const head = decision.useHybrid ? `route=hybrid(cc) confidence=${decision.confidence}` : `route=local confidence=${decision.confidence}`
  const detail = decision.blockers.length ? `阻断：${decision.blockers.join('；')}` : (decision.reasons.join('；') || '无判定依据')
  return `${head} | ${detail}`
}
