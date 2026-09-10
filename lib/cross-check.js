/**
 * cross-check.js
 *
 * 双通道交叉校验仲裁（纯函数，2026-09-10 架构征询落地 P2-1）。
 *
 * 背景：架构征询两方（外部 AI + Claude Code）均建议——对 importance=high 的关键步骤，
 * 用两条**独立**外部通道分别取审核结论（外部 AI 侧 vs 本地 Claude Code 侧），
 * 结论一致则采信，冲突则**不自动判定**：升级人工裁决（避免任一方单独误判被直接采信）。
 *
 * 设计要点：
 *   - 只做判定，不发起调用（调用与落盘在 lib/index.js 的审核流程中）。
 *   - 共识规则：双方均为 approved → approved；双方均为 rejected → rejected；
 *     任一 unknown/失败 → 视为"不可采信"，走 escalation（不算冲突但也不采信）。
 *   - 冲突（一 approved 一 rejected）→ escalation，附双方理由供人工裁决。
 */

/** 仲裁结果类型。 */
export const CROSS_CHECK_STATES = Object.freeze(['consensus-approved', 'consensus-rejected', 'escalate-conflict', 'escalate-unusable'])

/**
 * 归一化单通道结论。
 * @param {{verdict?: string, reason?: string}|null} outcome
 * @returns {{usable: boolean, verdict: ('approved'|'rejected'|null), reason: string, label: string}}
 */
function normalize(outcome, label) {
  if (!outcome || typeof outcome !== 'object') return { usable: false, verdict: null, reason: '（无结论）', label }
  const v = String(outcome.verdict || outcome.result || '').toLowerCase()
  if (v !== 'approved' && v !== 'rejected') return { usable: false, verdict: null, reason: String(outcome.reason || '（结论无法识别）'), label }
  return { usable: true, verdict: v, reason: String(outcome.reason || ''), label }
}

/**
 * 双通道交叉校验仲裁。
 * @param {{verdict?: string, reason?: string}|null} primary 主通道结论（如外部 AI / Gemini）
 * @param {{verdict?: string, reason?: string}|null} secondary 次通道结论（如 claude-code）
 * @param {object} [opts]
 * @param {string} [opts.primaryLabel='外部 AI']
 * @param {string} [opts.secondaryLabel='claude-code']
 * @returns {{state: string, result: ('approved'|'rejected'|null), escalate: boolean, reason: string, detail: object}}
 *   state ∈ CROSS_CHECK_STATES；escalate=true 时调用方应升级人工（不自动落 approved/rejected）
 */
export function crossCheckVerdicts(primary, secondary, opts = {}) {
  const pl = opts.primaryLabel || '外部 AI'
  const sl = opts.secondaryLabel || 'claude-code'
  const p = normalize(primary, pl)
  const s = normalize(secondary, sl)
  const detail = { primary: p, secondary: s }

  if (!p.usable || !s.usable) {
    const missing = [!p.usable ? pl : null, !s.usable ? sl : null].filter(Boolean)
    return {
      state: 'escalate-unusable',
      result: null,
      escalate: true,
      reason: `交叉校验不可用：${missing.join('、')} 未给出可识别结论（不得由单方结论自动采信）`,
      detail,
    }
  }

  if (p.verdict === s.verdict) {
    return {
      state: p.verdict === 'approved' ? 'consensus-approved' : 'consensus-rejected',
      result: p.verdict,
      escalate: false,
      reason: `双通道一致（${pl} 与 ${sl} 均为 ${p.verdict}）\n【${pl}】${p.reason.slice(0, 400)}\n【${sl}】${s.reason.slice(0, 400)}`,
      detail,
    }
  }

  return {
    state: 'escalate-conflict',
    result: null,
    escalate: true,
    reason: `双通道结论冲突（${pl}=${p.verdict}，${sl}=${s.verdict}）——升级人工裁决\n【${pl}】${p.reason.slice(0, 600)}\n【${sl}】${s.reason.slice(0, 600)}`,
    detail,
  }
}

/**
 * 判定某步骤是否应启用交叉校验（importance=high 且显式开启开关）。
 * @param {object} step
 * @param {boolean} enableCrossCheck 请求级开关
 * @returns {boolean}
 */
export function shouldCrossCheck(step, enableCrossCheck) {
  if (enableCrossCheck !== true) return false
  if (!step || typeof step !== 'object') return false
  return step.importance === 'high'
}
