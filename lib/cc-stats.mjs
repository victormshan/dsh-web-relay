/**
 * cc-stats.mjs
 *
 * cc 通道（Claude Code 派发）成功率统计模块——纯函数 + 轻量 IO 注入，
 * 用于把历次派发结果（成功/失败/耗时/失败原因）累计为可观测的统计对象，
 * 并给出成功率三级判定建议。
 *
 * 纯 Node ESM，Node >= 18，零第三方依赖，仅使用 node:fs/promises、node:path。
 * 所有与文件系统的交互都通过可注入的 fsImpl 完成（默认 node:fs/promises 本身），
 * 便于单元测试用内存 fake 替换、不碰真实磁盘。
 */

import * as nodeFsPromises from 'node:fs/promises';
import path from 'node:path';

const RECENT_LIMIT = 10;

/**
 * 失败原因分类规则：按顺序匹配，命中即返回，避免关键词交叉误判。
 * cc-watchdog-stale / timeout-still-running 必须排在通用 timeout 之前——两者都含
 * "timeout" 子串（\btimeout\b 会命中 "timeout-still-running"），先匹配到更具体的类别，
 * 使「派发前 watchdog 陈旧降级」与「轮询到超时上限但任务可能仍在执行」在统计上可区分，
 * 不被笼统归入 timeout（该类此前专指 runner.sh exit=124 等真实执行超时）。
 *
 * ccfix-20260914-stats: cc-quota-exhausted / cc-permission-denied / cc-timeout 同理必须
 * 排在通用 timeout 之前——命名与 lib/index.js runCcReviewTask 已经在写的字面量 reason
 * （'cc-quota-exhausted' / 'cc-permission-denied'，见 lib/index.js 附近 recordCcStat 调用点）
 * 及 lib/cc-channel.js classifyCcFailure() 消费的 result.json.errorCode 取值
 * （cc-quota-exhausted/cc-permission-denied/cc-timeout/cc-failed/v2-validate-failed/
 * cc-marker-missing）一致，关键词兜底（session limit/rate limit/quota、permissions to
 * write/haven't granted/not permitted）与 classifyCcFailure 的正则同源，避免两处正则各写
 * 一套却语义漂移。此前这三类 reason 落不到任何规则，一律归入 unknown（见 docs/CC-HYBRID.md 的
 * ccfix-20260914-hb3 遗留说明），/health-check 无法单独看到「配额耗尽 N 次」。
 *
 * ccfix-20260915-markermissing: cc-marker-missing 必须排在 runner-failed 之前——runner.sh
 * 为该分类写入的 reason 文本是 "claude exit=0; done.flag=missing"，命中 runner-failed 正则
 * 里的 `done\.flag\s*(missing|不存在|缺失)` 子模式，若不前置会被 runner-failed 吞掉，导致
 * 「代码写坏了」与「只是没写完成标记（产物完好）」在统计上又变得不可区分。
 */
const FAILURE_RULES = [
  ['channel-unavailable', /cc-tasks\s*(根目录|目录)?\s*不可用|目录缺失|channel[-_ ]?unavailable/i],
  ['cc-watchdog-stale', /cc-watchdog-stale/i],
  ['timeout-still-running', /timeout-still-running/i],
  ['cc-quota-exhausted', /cc-quota-exhausted|session\s*limit|rate\s*limit|\bquota\b/i],
  ['cc-permission-denied', /cc-permission-denied|permissions to write|haven'?t granted|not permitted/i],
  ['cc-timeout', /\bcc-timeout\b/i],
  ['timeout', /超时|exit\s*=\s*124|\b900s\b|\btimeout\b/i],
  ['contract-reject', /REJECT(ED)?|契约校验失败|隔离|\.invalid\//i],
  ['cc-marker-missing', /cc-marker-missing/i],
  [
    'runner-failed',
    /claude\s*exit\s*(≠|!=)\s*0|exit\s*(≠|!=)\s*0|done\.flag\s*(missing|不存在|缺失)|v2-validate-failed|runner[-_ ]?failed/i,
  ],
  ['artifact-missing', /产物缺失|产物校验失败|artifact[-_ ]?missing/i],
];

/** 截断文本到指定长度（不追加省略标记，保留原文前 N 字）。 */
function truncateText(text, maxLen) {
  const s = typeof text === 'string' ? text : '';
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

/**
 * 把失败原因文本归类到可统计的类别。
 * @param {string} reasonText - 失败原因原文（如 result.json.reason / runner.log 摘录）。
 * @returns {{category: string, detail: string}} category 为 FAILURE_RULES 中某一分类或
 *   兜底的 'unknown'；detail 原文前 200 字。
 */
export function classifyCcFailure(reasonText) {
  const text = typeof reasonText === 'string' ? reasonText : '';
  const detail = truncateText(text, 200);
  for (const [category, re] of FAILURE_RULES) {
    if (re.test(text)) {
      return { category, detail };
    }
  }
  return { category: 'unknown', detail };
}

/** 构造一个空白 stats 对象。 */
function emptyStats() {
  return {
    total: 0,
    ok: 0,
    failed: 0,
    byKind: {},
    byFailure: {},
    elapsedMs: { sum: 0, min: null, max: null, count: 0 },
    recent: [],
  };
}

/** 深拷贝 stats（仅涉及本模块使用到的纯 JSON 结构，够用即可）。 */
function cloneStats(stats) {
  const base = stats && typeof stats === 'object' ? stats : emptyStats();
  return {
    total: base.total || 0,
    ok: base.ok || 0,
    failed: base.failed || 0,
    byKind: { ...(base.byKind || {}) },
    byFailure: { ...(base.byFailure || {}) },
    elapsedMs: {
      sum: (base.elapsedMs && base.elapsedMs.sum) || 0,
      min: base.elapsedMs && typeof base.elapsedMs.min === 'number' ? base.elapsedMs.min : null,
      max: base.elapsedMs && typeof base.elapsedMs.max === 'number' ? base.elapsedMs.max : null,
      count: (base.elapsedMs && base.elapsedMs.count) || 0,
    },
    recent: Array.isArray(base.recent) ? base.recent.map((r) => ({ ...r })) : [],
  };
}

/**
 * 把一次 cc 派发结果并入统计对象（不可变更新，不修改入参 stats）。
 * @param {object} stats - 现有统计对象（可为空/undefined，视为空白统计）。
 * @param {object} outcome - { taskId, kind, ok, elapsedMs, reason?, at? }
 * @returns {object} 新的 stats 对象。
 */
export function recordCcOutcome(stats, outcome) {
  const next = cloneStats(stats);
  const o = outcome || {};
  const kind = typeof o.kind === 'string' && o.kind ? o.kind : 'unknown';
  const ok = !!o.ok;
  const elapsedMs = typeof o.elapsedMs === 'number' && Number.isFinite(o.elapsedMs) ? o.elapsedMs : null;
  const at = typeof o.at === 'string' && o.at ? o.at : new Date().toISOString();

  next.total += 1;
  if (ok) {
    next.ok += 1;
  } else {
    next.failed += 1;
  }

  const byKindEntry = next.byKind[kind] || { total: 0, ok: 0, failed: 0 };
  next.byKind[kind] = {
    total: byKindEntry.total + 1,
    ok: byKindEntry.ok + (ok ? 1 : 0),
    failed: byKindEntry.failed + (ok ? 0 : 1),
  };

  let category = null;
  if (!ok) {
    category = classifyCcFailure(o.reason).category;
    next.byFailure[category] = (next.byFailure[category] || 0) + 1;
  }

  if (elapsedMs !== null) {
    next.elapsedMs = {
      sum: next.elapsedMs.sum + elapsedMs,
      min: next.elapsedMs.min === null ? elapsedMs : Math.min(next.elapsedMs.min, elapsedMs),
      max: next.elapsedMs.max === null ? elapsedMs : Math.max(next.elapsedMs.max, elapsedMs),
      count: next.elapsedMs.count + 1,
    };
  }

  const recentEntry = {
    taskId: typeof o.taskId === 'string' ? o.taskId : '',
    kind,
    ok,
    elapsedMs,
    category,
    at,
  };
  next.recent = [...next.recent, recentEntry].slice(-RECENT_LIMIT);

  return next;
}

/**
 * 依据 stats 给出成功率判定建议。
 * @param {object} stats - recordCcOutcome 累积的统计对象。
 * @returns {{successRate: number, level: 'ok'|'warn'|'risk', message: string, breakdown: object}}
 */
export function summarizeCcStats(stats) {
  const s = cloneStats(stats);
  const total = s.total;
  const successRate = total > 0 ? s.ok / total : 0;
  const avgElapsedMs = s.elapsedMs.count > 0 ? s.elapsedMs.sum / s.elapsedMs.count : null;

  let level;
  let message;
  if (total < 5) {
    level = 'warn';
    message = `样本不足（total=${total} < 5），成功率仅供参考：${(successRate * 100).toFixed(1)}%`;
  } else if (successRate >= 0.8) {
    level = 'ok';
    message = `cc 通道健康，成功率 ${(successRate * 100).toFixed(1)}%（样本 ${total}）`;
  } else if (successRate < 0.5) {
    level = 'risk';
    message = `cc 通道成功率偏低（${(successRate * 100).toFixed(1)}%，样本 ${total}），建议排查失败原因`;
  } else {
    level = 'warn';
    message = `cc 通道成功率一般（${(successRate * 100).toFixed(1)}%，样本 ${total}），建议持续观察`;
  }

  return {
    successRate,
    level,
    message,
    breakdown: {
      total: s.total,
      ok: s.ok,
      failed: s.failed,
      byKind: s.byKind,
      byFailure: s.byFailure,
      avgElapsedMs,
    },
  };
}

/**
 * 从磁盘加载 stats（IO 可注入）。文件不存在或 JSON 损坏均不抛异常，返回空白 stats。
 * @param {string} filePath - stats JSON 文件路径。
 * @param {object} [fsImpl] - 默认 node:fs/promises；需实现 readFile(path, 'utf8')。
 * @returns {Promise<object>} stats 对象；异常路径下额外带 message 字段说明原因。
 */
export async function loadStats(filePath, fsImpl = nodeFsPromises) {
  let raw;
  try {
    raw = await fsImpl.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ...emptyStats(), message: `stats 文件不存在（${filePath}），已返回空白统计` };
    }
    return { ...emptyStats(), message: `stats 文件读取失败（${String(err && err.message ? err.message : err)}），已返回空白统计` };
  }

  try {
    const parsed = JSON.parse(String(raw));
    return cloneStats(parsed);
  } catch {
    return { ...emptyStats(), message: `stats 文件 JSON 解析失败（${filePath}），已返回空白统计` };
  }
}

/**
 * 把 stats 写回磁盘（IO 可注入）。
 * @param {string} filePath - stats JSON 文件路径。
 * @param {object} stats - 待写入的统计对象。
 * @param {object} [fsImpl] - 默认 node:fs/promises；需实现 writeFile(path, data, 'utf8')，
 *   可选实现 mkdir(dir, {recursive:true}) 用于自动创建父目录。
 * @returns {Promise<void>}
 */
export async function saveStats(filePath, stats, fsImpl = nodeFsPromises) {
  if (typeof fsImpl.mkdir === 'function') {
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
  }
  await fsImpl.writeFile(filePath, JSON.stringify(stats, null, 2), 'utf8');
}
