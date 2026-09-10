/**
 * review-audit.js
 *
 * 审核降级率审计（纯函数，2026-09-10 架构征询落地 P1-1）。
 *
 * 背景：架构征询（外部 AI）建议"降级审计门"——统计单次任务中对话模型（dialog）
 * 兜底审核的占比，超过阈值即标记 Risk 并在收口时提醒用户。
 * 依据实证：AutoIteration 6 版迭代（23 步）中 dialog 占 13 步 ≈ 57%——当外部通道
 * （Gemini API 429 限流 / web-gemini 不可用 / cc 通道契约 bug）连续不可用时，审核
 * 会静默降级到无工具的内部模型，形成"形式上 approved、实质审查强度下降"的风险，
 * 而收口汇总里只有分组清单、没有比例告警，用户难以一眼察觉。
 *
 * 本模块把该审计固化为确定性纯函数，供 finalize 收口与面板调用。
 */

/** 默认阈值与权重。 */
export const REVIEW_AUDIT_DEFAULTS = Object.freeze({
  dialogRatioWarn: 0.3,   // dialog 占比 >30% → 告警（架构征询建议值）
  minStepsForAudit: 3,    // 样本过小（<3 步）不评估，避免噪声
})

/**
 * 审核来源分类（与 summarizeReviewSources 的分类保持一致）。
 * @param {object} step
 * @returns {'external'|'dialog'|'manual'|'mainagent'|'claude-code'}
 */
export function classifyReviewer(step) {
  const rb = step && step.reviewedBy
  if (rb === 'dialog') return 'dialog'
  if (rb === 'manual') return 'manual'
  if (rb === 'mainagent') return 'mainagent'
  if (rb === 'claude-code') return 'claude-code'
  return 'external' // 缺省视为外部 AI（含 web-gemini 成功路径，二者 reviewer 均记 external）
}

/**
 * 审计一批步骤的审核来源分布与降级率。
 * @param {Array<object>} steps
 * @param {object} [opts]
 * @param {number} [opts.dialogRatioWarn=0.3] dialog 占比告警阈值
 * @param {number} [opts.minStepsForAudit=3] 最小样本量
 * @returns {{total: number, counts: object, dialogRatio: number, degradedRatio: number,
 *   level: 'ok'|'warn'|'risk', flagged: boolean, message: string}}
 *   level：ok=无告警；warn=降级占比超阈值；risk=降级占比超阈值且外部通道成功数为 0
 *   degradedRatio = (dialog + manual) / total ——人工兜底同样属于"非外部 AI 自动审核"
 */
export function auditReviewSources(steps, opts = {}) {
  const cfg = { ...REVIEW_AUDIT_DEFAULTS, ...opts }
  const list = Array.isArray(steps) ? steps : []
  const counts = { external: 0, dialog: 0, manual: 0, mainagent: 0, 'claude-code': 0 }
  for (const s of list) counts[classifyReviewer(s)] += 1
  const total = list.length

  if (total < cfg.minStepsForAudit) {
    return {
      total, counts,
      dialogRatio: total ? counts.dialog / total : 0,
      degradedRatio: total ? (counts.dialog + counts.manual) / total : 0,
      level: 'ok', flagged: false,
      message: `样本不足（${total} < ${cfg.minStepsForAudit} 步），不做降级率评估`,
    }
  }

  const dialogRatio = counts.dialog / total
  const degradedRatio = (counts.dialog + counts.manual) / total
  const flagged = dialogRatio > cfg.dialogRatioWarn
  const externalOk = counts.external + counts['claude-code']
  let level = 'ok'
  if (flagged) level = externalOk === 0 ? 'risk' : 'warn'

  const pct = (n) => `${Math.round(n * 100)}%`
  let message
  if (!flagged) {
    message = `审核降级率正常：dialog ${counts.dialog}/${total}（${pct(dialogRatio)}）≤ 阈值 ${pct(cfg.dialogRatioWarn)}；外部通道成功 ${externalOk} 步`
  } else if (level === 'risk') {
    message = `⚠ 审核降级风险：dialog ${counts.dialog}/${total}（${pct(dialogRatio)}）超阈值 ${pct(cfg.dialogRatioWarn)}，且**外部通道（Gemini/claude-code）成功 0 步**——本次审核全部依赖内部模型兜底，实质审查强度下降，建议人工抽查关键步骤`
  } else {
    message = `⚠ 审核降级告警：dialog ${counts.dialog}/${total}（${pct(dialogRatio)}）超阈值 ${pct(cfg.dialogRatioWarn)}（外部通道成功 ${externalOk} 步）——建议核查外部通道可用性（429 限流/桥接/cc 契约）`
  }

  return { total, counts, dialogRatio, degradedRatio, level, flagged, message }
}

/**
 * 汇总文本追加段（finalize 收口用）：仅在有告警时返回非空文本。
 * @param {ReturnType<typeof auditReviewSources>} audit
 * @returns {string}
 */
export function renderAuditLine(audit) {
  if (!audit || !audit.flagged) return ''
  return `\n\n【审核降级审计（P1-1）】${audit.message}`
}
