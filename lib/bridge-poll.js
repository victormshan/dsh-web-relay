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
/** 默认无人认领阈值（pending 未被扩展拾取；扩展每秒轮询，60s 无认领即异常）。 */
export const BRIDGE_PENDING_MS_DEFAULT = 60000

/**
 * 判定一次桥接任务轮询结果。
 * @param {object|null} task 桥接任务对象 { status, answer, error, claimedAt }
 * @param {object} [opts]
 * @param {number} [opts.processingSince] processing 状态起始时间戳（ms）；未开始为 null
 * @param {number} [opts.pendingSince] pending 状态起始时间戳（ms）；用于识别"无人认领"
 * @param {number} [opts.now=Date.now()] 当前时间戳（ms）
 * @param {number} [opts.stallMs=BRIDGE_STALL_MS_DEFAULT] 停滞阈值（ms）
 * @param {number} [opts.pendingMs=BRIDGE_PENDING_MS_DEFAULT] 无人认领阈值（ms）
 * @returns {{ state: 'done'|'failed'|'stalled'|'unavailable'|'waiting', answer?: string, error?: string }}
 *   state='done' 时携带 answer；'failed'/'stalled'/'unavailable' 时携带 error 文案
 */
export function classifyBridgeTask(task, {
  processingSince = null,
  pendingSince = null,
  now = Date.now(),
  stallMs = BRIDGE_STALL_MS_DEFAULT,
  pendingMs = BRIDGE_PENDING_MS_DEFAULT,
} = {}) {
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

  // v4.9.3（stab1_2 实测新增）: pending 无人认领——扩展 background.js 的 pollOnce 在
  // 「无 gemini.google.com 标签页」时直接跳过取任务，任务会永久 pending；此前宿主只能
  // 白等到 300s 硬超时（2026-09-10 实测：claimCount=0 且任务 stop pending）。
  if (task.status === 'pending' && pendingSince !== null) {
    const elapsed = now - pendingSince
    if (elapsed >= pendingMs) {
      return {
        state: 'unavailable',
        error: `bridge 任务无人认领（pending ${Math.round(elapsed / 1000)}s 未被扩展拾取——可能 Chrome 无 gemini.google.com 标签页 / 扩展被停用 / Service Worker 未运行），提前失败由降级链续降`,
      }
    }
  }

  return { state: 'waiting' }
}

/**
 * v4.12.2: bridge 共享 token 轮换自愈（移植自 2026-09-01 auto-iterate dsh-web-relay-hardening V1，
 * 并从原来只覆盖 create-task 扩展为所有带 token 的 bridge 请求）。
 *
 * 背景：宿主把 bridge /__token 拉到的 token 缓存 1 小时。bridge.token 一旦被重新生成
 * （删除/重装扩展/安全重置——2026-09-11 升级扩展时就发生过），缓存期内每个带 token 的请求都会
 * 401，web-gemini 审核被误判为故障、整小时降级到 dialog；task-result 轮询与健康视图的 /stats
 * 同样受影响。
 *
 * 规则：首个响应为 401 时视为「本地缓存 token 可能已过期」——清缓存、重新取 token、重试且仅重试一次；
 * 重试仍 401（真实密钥不一致）则把第二次响应原样返回，调用方报错文案不变。非 401 不重试。
 *
 * @param {(headers: object) => Promise<{status: number}>} doFetch 用给定请求头发起一次请求
 * @param {{ getHeaders: () => Promise<object>, invalidate: () => void }} auth
 * @returns {Promise<{status: number}>} 最终响应（网络异常照常抛出，由调用方既有 catch 处理）
 */
export async function fetchWithTokenRetry(doFetch, { getHeaders, invalidate }) {
  const res = await doFetch(await getHeaders())
  if (!res || res.status !== 401) return res
  invalidate()
  return doFetch(await getHeaders())
}

/**
 * v4.12.2: 健康视图对 bridge /__token 探测响应的归一化（原内联于 index.js collectHeavyHealth）。
 * 提为导出纯函数，使 test/health-checker.test.js 直接测真实逻辑——此前测试手抄了一份 v3.3.0
 * 之前 /stats 形状的镜像，全绿却在测已废弃的代码路径（移植自 2026-09-01 dsh-web-relay-hardening V2，
 * 并按当时审核意见消除镜像漂移风险）。
 *
 * @param {unknown} d /__token 的 JSON 响应（解析失败时为 null）
 * @returns {{ ok: true, note: string } | { ok: false, error: string }}
 */
export function normalizeBridgeProbe(d) {
  return d && d.ok !== false
    ? { ok: true, note: 'bridge 在线（token 就绪）' }
    : { ok: false, error: 'bridge 响应异常' }
}
