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

// ccfeat-20260920-humanwrite: **写入方**也放在本模块 —— 与解析器同处一个文件即"格式的唯一来源"。
// 起因（2026-09-20 分析）：熔断（连续打回 ≥3 / 重启续跑 ≥2）只 console.warn + webhook + 写 stopReason，
// **从不写 signal 文件**（此前该文件只有主 agent 工作区的工具会写）→ 熔断发生时盘上没有机器可读对象，
// 无人被叫醒。补写入方时必须避免"两个实现同一格式"的漂移，故与 parsePendingHuman 同居一处。
import { makeRef } from './task-ref.mjs'

/** 允许的 reason 白名单。与主 agent 侧 chain-human-signal.mjs 的 ALLOWED_REASONS **必须一致**
 *  （门禁 verify-human-signal.mjs 的解析器自检会比对两份清单，防漂移）。
 *  白名单存在的意义是防告警疲劳：不在其中的一律拒绝登记（例如"额度耗尽"是设计内行为，不得叫醒人）。 */
export const PENDING_HUMAN_REASONS = ['too-many-attempts', 'instrument-error', 'review-needed', 'audit-action-needed']

/**
 * 构造一条信号（纯函数，不碰磁盘）。写入方唯一入口——**禁止**各处手写对象字面量。
 * @param {{chainId:string, reason:string, taskRef?:string|null, detail?:string, lastVerdict?:string|null, attempts?:number|null, stableKey?:string|null, generation?:number, id?:string, now?:string}} o
 * @returns {{ok:boolean, entry?:object, error?:string}}
 */
export function buildPendingHumanWrite(o = {}) {
  const { chainId, reason, taskRef = null, detail = '', lastVerdict = null, attempts = null, stableKey = null, generation = 1, synthetic = false, now = new Date().toISOString() } = o
  if (!chainId) return { ok: false, error: 'chainId 必填' }
  if (!PENDING_HUMAN_REASONS.includes(reason)) return { ok: false, error: `未知 reason ${reason}（只允许 ${PENDING_HUMAN_REASONS.join('/')}）` }
  // taskId 一律存**规范 ref**（统一身份）：cc:/expr:/signal:/main: 前缀。
  // 历史遗留的裸串仍可被读取方识别（legacy），但新写入不得产出裸串。
  const id = o.id || (stableKey ? `${stableKey}#g${generation}` : `${chainId}|${reason}|${taskRef || '-'}|${now}`)
  return {
    ok: true,
    entry: {
      id,
      chainId,
      reason,
      taskId: taskRef || null,
      detail: String(detail || '').slice(0, 2000),
      lastVerdict,
      attempts,
      at: now,
      acknowledgedAt: null,
      ackNote: null,
      // ccfeat-20260923-synthetic（2026-09-23 实测）: 测试夹具/演练产物的显式标记。
      // 为什么必须在**写入时**就带上：夹具走生产路径登记，id 是逼真时间戳、形状与真实告警完全一致，
      // 事后补标记之前插件已经唤醒过主 agent（同一夹具连续三次把主 agent 叫醒，为一条**不存在的 expr**）。
      // 消费者契约：checkPendingHuman 见 synthetic===true → 只留痕、不唤醒（见 lib/index.js）。
      ...(synthetic === true ? { synthetic: true } : {}),
      ...(stableKey ? { stableKey, generation } : {}),
    },
  }
}

/** 便捷：以 expr 为载体登记熔断信号时用的规范 ref。 */
export function exprTaskRef(exprId) { return makeRef('expr', String(exprId)) }

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
 * 规则（按优先级，2026-09-20 增补第 ②.5 档 ccfeat-20260920-waketarget）：
 *   ① env 有值                 → { sessionId: env, source: 'env' }
 *   ② activeSessions 非空      → { sessionId: 最近活跃者, source: 'active' }（刷新后 GUI 换到的新会话）
 *   ③ env 空、recent 有值       → { sessionId: recentExprSessionId, source: 'recent-expr' }（旧行为，最后兜底）
 *   ④ 全空                     → { sessionId: null, source: 'none' }
 *
 * 为什么必须加 ②（2026-09-20 实测事故）：用户**刷新**后 GUI 换到新会话（session-4fcb148a），
 * 而 expr 仍绑着刷新前那个（session-5ee8782e）。旧逻辑只认 ③，于是每次唤醒都投给**旧会话** ——
 * 旧会话仍然活着并**并发写同一个工作区**（核对了清单、做了插件改动、发了 re-restart，还用内联
 * PowerShell 正则把主槽信号文件写成了 `[]`）。人看得见的是新会话，被叫醒的却是另一个"我"。
 * 选中"最近活跃会话"即可消除这种分裂；note 字段明示是否发生了切换，便于事后审计投递目标。
 * 不在有值时返回 null；不凭空造目标；不抛异常。
 *
 * @param {{env?: string|null, recentExprSessionId?: string|null, activeSessions?: Array<{id:string, mtimeMs:number}>}} [opts]
 * @returns {{sessionId: string|null, source: 'env'|'active'|'recent-expr'|'none', note?: string}}
 */
export function resolveWakeSessionId({ env, recentExprSessionId, activeSessions } = {}) {
  if (env) {
    return { sessionId: env, source: 'env' }
  }
  const act = Array.isArray(activeSessions) ? activeSessions.filter((s) => s && s.id && Number.isFinite(s.mtimeMs)) : []
  if (act.length) {
    const newest = act.slice().sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    const switched = !!recentExprSessionId && recentExprSessionId !== newest.id
    return { sessionId: newest.id, source: 'active', ...(switched ? { note: `已从历史会话 ${recentExprSessionId} 切到最近活跃会话` } : {}) }
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
