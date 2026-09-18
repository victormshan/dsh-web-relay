// lib/pending-human.mjs — ccfeat-20260918-pendinghuman
//
// 「链条停下等人」信号的纯逻辑层：解析信号文件文本 / 判定是否需要唤醒 / 生成交接文本，
// 全部为纯函数（不做磁盘 IO、不调用 wakeMainAgent），磁盘读取与唤醒动作均由调用方
// （lib/index.js）负责，便于两侧（本模块单测 + 调用方接线）各自独立验证——与
// lib/selfcheck.mjs「纯逻辑 + 调用方注入 IO」的风格一致。
//
// 信号文件由 cc 链条侧写入（护栏触发：单项连续失败达上限 / 验收器自身出错 / 跑完待收口），
// 形状（链条侧已实现，本模块不改）：
//   { id, chainId, reason, taskId, detail, lastVerdict, attempts, at, acknowledgedAt, ackNote, dryRun? }
//   reason ∈ 'too-many-attempts' | 'instrument-error' | 'review-needed'
//
// 纯 Node ESM，Node >= 18，零第三方依赖。

/**
 * 解析 chain-needs-human.json 的原始文本。绝不抛异常——boot/心跳路径要求 fail-open，
 * 读到坏文件（BOM、截断 JSON、字段缺失）只能得到 { ok:false }，不能让调用方崩溃。
 *
 * @param {string} rawText - 文件原始文本（utf8；可能带 BOM）。
 * @returns {{ok:boolean, entry:object|null, error:string|null}}
 */
export function parsePendingHuman(rawText) {
  try {
    if (typeof rawText !== 'string' || rawText.trim() === '') {
      return { ok: false, entry: null, error: 'empty or non-string input' }
    }
    // BOM 容错：文件以 UTF-8 BOM（﻿）开头时 JSON.parse 会直接抛错，需先剥离。
    const stripped = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText
    let parsed
    try {
      parsed = JSON.parse(stripped)
    } catch (err) {
      return { ok: false, entry: null, error: `invalid JSON: ${String((err && err.message) || err)}` }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, entry: null, error: 'parsed value is not an object' }
    }
    const missing = ['id', 'chainId', 'reason'].filter((k) => typeof parsed[k] !== 'string' || parsed[k].trim() === '')
    if (missing.length > 0) {
      return { ok: false, entry: null, error: `missing required field(s): ${missing.join(',')}` }
    }
    return { ok: true, entry: parsed, error: null }
  } catch (err) {
    // 任何未预见的异常（理论上不应到达这里）依然 fail-open，不抛出。
    return { ok: false, entry: null, error: String((err && err.message) || err) }
  }
}

/**
 * 判定给定的信号条目是否需要唤醒主 agent。
 *
 * 规则（按优先级）：
 *   ① entry 无效（缺 id/chainId/reason）→ none
 *   ② entry.acknowledgedAt 非空（已销账）→ none
 *   ③ entry.id 已在 notifiedIds 里（进程内已通知过，去重）→ none
 *   ④ entry.dryRun === true → would-wake（判定为需要但不真的唤醒——验收探针用它空跑）
 *   ⑤ 其余 → wake
 *
 * @param {object|null} entry - parsePendingHuman 的 entry，或调用方直接构造的候选对象。
 * @param {{notifiedIds?: Set<string>|string[]}} [opts]
 * @returns {{decision:'wake'|'would-wake'|'none', reason:string}}
 */
export function decidePendingHuman(entry, { notifiedIds } = {}) {
  if (!entry || typeof entry !== 'object' || !entry.id || !entry.chainId || !entry.reason) {
    return { decision: 'none', reason: 'invalid entry' }
  }
  if (entry.acknowledgedAt) {
    return { decision: 'none', reason: 'acknowledged' }
  }
  const notified = notifiedIds instanceof Set ? notifiedIds : new Set(Array.isArray(notifiedIds) ? notifiedIds : [])
  if (notified.has(entry.id)) {
    return { decision: 'none', reason: 'duplicate' }
  }
  if (entry.dryRun === true) {
    return { decision: 'would-wake', reason: 'dryRun' }
  }
  return { decision: 'wake', reason: 'new' }
}

/**
 * 解析「唤醒目标该用哪个 sessionId」——纯函数，不读 process.env（由调用方注入，便于注入测试）。
 *
 * 背景（2026-09-18 实测缺口）：宿主启动器只注入 DSH_WEB_ARGS/DSH_RELAY_WORKSPACE/
 * DSH_RELAY_REPO/DSH_WEB_LOG，**没有 DSH_SESSION_ID**；此前 pending-human 唤醒路径只读
 * env，导致这台机器上"判定成立却没有唤醒目标"，心跳日志长期打印"仅记录留痕"——能力形同虚设。
 * 仓库里早有回退（mostRecentExprSessionId：取最近落盘 expr 的 sessionId），本函数把它的
 * 优先级规则抽成纯函数，供 lib/index.js 接线复用。
 *
 * 规则（按优先级）：
 *   ① env 有值               → { sessionId: env, source: 'env' }
 *   ② env 空、recent 有值     → { sessionId: recentExprSessionId, source: 'recent-expr' }
 *   ③ 两者都空                → { sessionId: null, source: 'none' }
 * 不在有值时返回 null；不凭空造目标；不抛异常。
 *
 * @param {{env?: string|null, recentExprSessionId?: string|null}} [opts]
 * @returns {{sessionId: string|null, source: 'env'|'recent-expr'|'none'}}
 */
export function resolveWakeSessionId({ env, recentExprSessionId } = {}) {
  if (env) {
    return { sessionId: env, source: 'env' }
  }
  if (recentExprSessionId) {
    return { sessionId: recentExprSessionId, source: 'recent-expr' }
  }
  return { sessionId: null, source: 'none' }
}

/**
 * 生成唤醒主 agent 的交接文本。
 * @param {object} entry - 信号条目（至少含 chainId/reason；taskId/detail 缺失时用占位说明）。
 * @returns {string}
 */
export function pendingHandoffText(entry) {
  const e = entry && typeof entry === 'object' ? entry : {}
  return [
    '【dsh-web-relay：链条停下等人】',
    '',
    `chainId: ${e.chainId || '(unknown)'}`,
    `reason: ${e.reason || '(unknown)'}`,
    `taskId: ${e.taskId || '(none)'}`,
    `detail: ${e.detail || '(none)'}`,
    '',
    '这是链条停下等你的信号（护栏触发：单项连续失败达上限 / 验收器自身出错 / 跑完待收口），',
    '请复核后处理并销账（acknowledgeHumanSignal），否则链条会一直停在这里。',
    '',
    '下一步建议：',
    '• 打开 taskId 对应任务目录的 out/report.md 与 claude.log，判断具体根因；',
    '• too-many-attempts → 检查任务拆分是否过细/验收标准是否可达；',
    '• instrument-error → 检查验收脚本（acceptanceScript）自身是否有缺陷；',
    '• review-needed → 人工复核产物后决定通过/打回/调整后重试；',
    '• 处理完毕后调用 acknowledgeHumanSignal 销账，链条才会继续。'
  ].join('\n')
}
