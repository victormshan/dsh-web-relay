/**
 * bridge-poll.js
 *
 * web-gemini 桥接任务结果判定（纯函数，可注入时钟；见 lib/index.js webGeminiAsk）。
 *
 * 背景（2026-09-09 探活实测）：
 *   Chrome 扩展 background.js 每 1s 轮询 /next-task 取任务 → content script 在
 *   gemini.google.com 页面投递 prompt 并读取回复（waitReply 上限 60s，65s 内必 sendResponse）。
 *   实测缺口：content script 无响应时（sendMessage 4 次重试全失败），background 对
 *   resp === null 既不做 /submit-answer 也不做 /submit-error → 桥接任务永久停留
 *   processing（泄漏），而宿主 webGeminiAsk 只认 status === 'done'，只能死等满 300s 超时，
 *   使每次降级链白等 5 分钟（AutoIteration V5/V6 各一次实测）。
 *
 * 判定语义（按 task.status / processing 停滞时长）：
 *   - done    → 有 answer：成功
 *   - failed  → 扩展上报诊断错误：立即失败（当前实现被忽略，白等超时）
 *   - stalled → processing 且停滞超过 stallMs：content script 未响应（泄漏），提前失败
 *   - waiting → 尚未开始（pending）或 processing 未超停滞阈值：继续轮询
 */

/** 默认停滞阈值（content script waitReply 上限 60s + 5s 兜底 → 65s；留 25s 余量）。 */
export const BRIDGE_STALL_MS_DEFAULT = 90000

/**
 * 判定一次桥接任务轮询结果。
 * @param {object|null} task 桥接任务对象 { status, answer, error, claimedAt }
 * @param {object} [opts]
 * @param {number} [opts.processingSince] processing 状态起始时间戳（ms）；未开始为 null
 * @param {number} [opts.now=Date.now()] 当前时间戳（ms）
 * @param {number} [opts.stallMs=BRIDGE_STALL_MS_DEFAULT] 停滞阈值（ms）
 * @returns {{ state: 'done'|'failed'|'stalled'|'waiting', answer?: string, error?: string }}
 *   state='done' 时携带 answer；'failed'/'stalled' 时携带 error 文案
 */
export function classifyBridgeTask(task, { processingSince = null, now = Date.now(), stallMs = BRIDGE_STALL_MS_DEFAULT } = {}) {
  if (!task || typeof task !== 'object') return { state: 'waiting' }

  if (task.status === 'done') {
    if (task.answer) return { state: 'done', answer: String(task.answer) }
    // done 但无 answer：视作扩展异常（既非成功也非显式失败）——按 waiting 继续等（保守），
    // 由外层超时兜底；避免把"空回复"当成成功。
    return { state: 'waiting' }
  }

  if (task.status === 'failed') {
    const detail = task.error ? String(task.error).slice(0, 300) : '(扩展未提供诊断)'
    return { state: 'failed', error: `bridge 任务失败：${detail}` }
  }

  if (task.status === 'processing' && processingSince !== null) {
    const elapsed = now - processingSince
    if (elapsed >= stallMs) {
      return {
        state: 'stalled',
        error: `bridge 任务停滞（processing ${Math.round(elapsed / 1000)}s 无终态——content script 未响应/任务泄漏，提前失败不白等超时）`,
      }
    }
  }

  return { state: 'waiting' }
}
