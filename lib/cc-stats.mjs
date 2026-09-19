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

import { CC_TASKS_ROOT_DEFAULT } from './cc-channel.js';
import { LIMIT_WORDING } from './quota-parser.mjs';

/**
 * ccfix-20260919-quotaclass: cc-quota-exhausted 规则不再自带独立写死的限额正则字面量，
 * 改为由唯一收敛模块 lib/quota-parser.mjs 的 LIMIT_WORDING 组合而成（额外并入 errorCode
 * 字面量 'cc-quota-exhausted' 这一路径），与 lib/cc-channel.js 的 classifyCcFailure 同源，
 * 避免两处各写一份正则、文案变化（如本机真实文案是 weekly limit）时只改一处导致漏判。
 */
const QUOTA_FAILURE_RULE_RE = new RegExp(`cc-quota-exhausted|${LIMIT_WORDING.source}`, 'i');

const RECENT_LIMIT = 10;

/** loadChainTaskResults 默认只看最近 N 个任务目录，避免 tasks/ 无界增长时全量扫描。 */
const CHAIN_TASKS_LIMIT_DEFAULT = 100;

/** summarizeChainTasks 默认统计窗口：近 7 天。 */
const CHAIN_WINDOW_MS_DEFAULT = 7 * 24 * 3600 * 1000;

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
 * cc-marker-missing）一致，关键词兜底（permissions to write/haven't granted/not permitted）
 * 与 classifyCcFailure 的正则同源，避免两处正则各写一套却语义漂移。此前这三类 reason 落不到
 * 任何规则，一律归入 unknown（见 docs/CC-HYBRID.md 的 ccfix-20260914-hb3 遗留说明），
 * /health-check 无法单独看到「配额耗尽 N 次」。
 *
 * ccfix-20260919-quotaclass: cc-quota-exhausted 的措辞判据（session/rate/weekly/usage
 * limit、hit your ... limit、quota）已收敛到唯一模块 lib/quota-parser.mjs 的 LIMIT_WORDING
 * （见文件头 QUOTA_FAILURE_RULE_RE），本文件不再自带独立写死的限额正则字面量——此前只认
 * session/rate/quota，本机真实文案是 weekly limit，漏判导致 byFailure 把配额耗尽记成
 * unknown（本任务修复的直接对象）。
 *
 * ccfix-20260915-markermissing: cc-marker-missing 必须排在 runner-failed 之前——runner.sh
 * 为该分类写入的 reason 文本是 "claude exit=0; done.flag=missing"，命中 runner-failed 正则
 * 里的 `done\.flag\s*(missing|不存在|缺失)` 子模式，若不前置会被 runner-failed 吞掉，导致
 * 「代码写坏了」与「只是没写完成标记（产物完好）」在统计上又变得不可区分。
 *
 * ccfeat-20260916-chainstats-a: 新增 \bcc-failed\b 归入 runner-failed——cc-failed 是
 * runner.sh 的通用兜底 errorCode（见 /mnt/d/cc-tasks/runner.sh 约第 80 行
 * `else ERRCODE="cc-failed"; fi`）：exit≠0（或 exit=0 但产物目录为空且工作树无改动）、
 * 且不属于 timeout/quota/permission-denied/marker-missing 任一更具体分类时的默认值，
 * 语义上就是「代码/runner 执行失败」，与既有 runner-failed 桶（exit≠0 等）同义，
 * 故复用同一桶而非另立分类。
 *
 * ccfix-20260916-fallback-classify: 修复审计盲区——runner.sh 真实写出的 reason 是**等号
 * 形态**（'claude exit=1; done.flag=missing'），此前 runner-failed 子模式只认
 * `exit\s*(≠|!=)\s*0` 与 `done\.flag\s*(missing|...)`（要求空白分隔），对等号形态恒不命中，
 * errorCode 为空的行一律落 unknown。现补齐：
 *   1) done.flag 子模式加 `=?`，等号/空格两种写法都认（`done\.flag\s*=?\s*(missing|...)`）；
 *   2) runner-failed 新增 `\bexit\s*=\s*[1-9]\d*\b` 认非零 exit（不含 0，避免误伤成功）；
 *   3) exit=124（runner.sh 900s 硬超时 kill 的退出码）从泛化 timeout 桶移入 cc-timeout
 *      桶（`\bexit\s*=\s*124\b` 挪进 cc-timeout 规则、移出 timeout 规则），使同一失败模式
 *      不再分裂成 timeout/cc-timeout 两桶；
 *   4) cc-marker-missing 新增一对前瞻 `(?=.*exit=0)(?=.*done\.flag=?missing)`，使
 *      'claude exit=0; done.flag=missing' 这一真实文本（即使不含字面量 'cc-marker-missing'）
 *      也能被识别为「claude 自身成功、仅缺完成标记」而非 runner-failed——该规则仍需保持在
 *      runner-failed **之前**（见上方 ccfix-20260915-markermissing 说明），因为两者的
 *      done.flag 子模式现在会同时命中同一段文本，顺序决定归属。
 * 同时 summarizeChainTasks / recordCcOutcome 两处调用点改为把 errorCode 与 reason
 * **合并**成一段文本再分类（此前 errorCode 非空时 reason 被完全忽略），使
 * errorCode='cc-failed' + reason='claude exit=0; done.flag=missing' 这类此前被误判为
 * runner-failed（实际是「代码写坏了」的反面：claude 已经成功，只是没写标记）的记录，
 * 能正确落回 cc-marker-missing。
 */
const FAILURE_RULES = [
  ['channel-unavailable', /cc-tasks\s*(根目录|目录)?\s*不可用|目录缺失|channel[-_ ]?unavailable/i],
  ['cc-watchdog-stale', /cc-watchdog-stale/i],
  ['timeout-still-running', /timeout-still-running/i],
  [
    'cc-quota-exhausted',
    // 由唯一模块 lib/quota-parser.mjs 的 LIMIT_WORDING 组合而成，覆盖
    // session/rate/weekly/usage limit、hit your ... limit、quota（不再自带独立正则字面量）。
    QUOTA_FAILURE_RULE_RE,
  ],
  ['cc-permission-denied', /cc-permission-denied|permissions to write|haven'?t granted|not permitted/i],
  ['cc-timeout', /\bcc-timeout\b|\bexit\s*=\s*124\b/i],
  ['timeout', /超时|\b900s\b|\btimeout\b/i],
  ['contract-reject', /REJECT(ED)?|契约校验失败|隔离|\.invalid\//i],
  [
    'cc-marker-missing',
    /cc-marker-missing|(?=[\s\S]*\bexit\s*=\s*0\b)(?=[\s\S]*done\.flag\s*=?\s*(?:missing|不存在|缺失))/i,
  ],
  [
    'runner-failed',
    /claude\s*exit\s*(≠|!=)\s*0|exit\s*(≠|!=)\s*0|\bexit\s*=\s*[1-9]\d*\b|done\.flag\s*=?\s*(missing|不存在|缺失)|v2-validate-failed|runner[-_ ]?failed|\bcc-failed\b/i,
  ],
  ['artifact-missing', /产物缺失|产物校验失败|artifact[-_ ]?missing/i],
];

/** 截断文本到指定长度（不追加省略标记，保留原文前 N 字）。 */
function truncateText(text, maxLen) {
  const s = typeof text === 'string' ? text : '';
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

/**
 * ccfix-20260916-fallback-classify: 把 errorCode 与 reason 合并成一段文本供 classifyCcFailure
 * 分类，两个调用点（recordCcOutcome / summarizeChainTasks）共用，避免 errorCode 非空时
 * reason 被完全忽略（反之亦然）。两者均非字符串/为空时按空串处理，不抛错。
 */
function combineErrorCodeAndReason(errorCode, reason) {
  const parts = [];
  if (typeof errorCode === 'string' && errorCode) parts.push(errorCode);
  if (typeof reason === 'string' && reason) parts.push(reason);
  return parts.join(' ');
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
 * @param {object} outcome - { taskId, kind, ok, elapsedMs, reason?, errorCode?, at? }
 *   ccfix-20260916-fallback-classify: errorCode 与 reason 一并纳入失败分类（合并成一段
 *   文本再 classifyCcFailure），而不是 errorCode 存在时 reason 被完全忽略——否则
 *   errorCode='cc-failed' + reason='claude exit=0; done.flag=missing' 这类「claude 自身
 *   成功、仅缺完成标记」的记录会被单独看 errorCode 误判为 runner-failed。
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
    category = classifyCcFailure(combineErrorCodeAndReason(o.errorCode, o.reason)).category;
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

/**
 * ccfeat-20260916-chainstats-a: 「编码通道」（链条/主 agent 直接派发的 implement/fix/feat
 * 任务）可靠性统计——纯函数，输入是已从磁盘读出的 result.json 内容数组（见
 * loadChainTaskResults），不做任何 IO。
 *
 * 背景：lib/index.js 里全部 6 处 recordCcStat 调用点 kind 都固定是 'review'
 * （relay 自己派发审核任务的路径，见 runCcReviewTask 内 recordCcStat 调用），
 * 即既有 ccStats（recordCcOutcome/summarizeCcStats）只统计「审核通道」；
 * 「编码通道」的结果只落在 D:\cc-tasks\tasks\<id>\result.json，此前没有任何聚合，
 * 本函数补上这块聚合能力。/health-check 的接线是后续任务，这里只做纯逻辑。
 *
 * 计入规则（按 result.json 字段 { status, start, end, exit, errorCode, reason }）：
 *   - 缺失 start 的条目直接跳过，不参与任何计数（无法判断是否在统计窗口内）；
 *   - start 早于 [now-windowMs, now] 窗口左端的条目跳过（窗口过滤）；
 *     边界取舍：start 恰好等于 now-windowMs 时**计入**（左闭区间），只有严格早于
 *     窗口左端才跳过——对应下方 `startMs < windowStart` 才 continue。
 *   - status==='done' → 计入 ok；
 *   - 其余（含 status==='failed' 与 status 缺失/异常等一切无法判定为 done 的情况）→
 *     先用 classifyCcFailure(errorCode + ' ' + reason 合并文本) 归类（ccfix-20260916-
 *     fallback-classify: errorCode 与 reason **一并**纳入判定，不再是 errorCode 非空时
 *     reason 完全被忽略）；分类结果为 'cc-marker-missing' → 单独计入 markerMissing，
 *     **不计入 failed**、也不进入 byFailure（该分类下产物完好只是没写完成标记，多次独立
 *     验收 ACCEPT，混进 failed 会误导 /health-check 的降级判断）——无论这个结论是来自
 *     errorCode 字面量 'cc-marker-missing' 还是来自 reason 文本 'claude exit=0;
 *     done.flag=missing' 命中新增的等号形态规则，处理一致；其余分类结果 → 计入 failed
 *     并记入 byFailure（无法归类时 classifyCcFailure 本身兜底为 'unknown'，不抛错）；
 *   - byStatus 按 result.json 原始 status 字段原样计数（缺失/非字符串归入 'unknown'
 *     键），与上面的语义化 failed/markerMissing 分桶是两套独立视角，互不影响。
 *   - 畸形输入（results 非数组、元素非对象、errorCode/status 类型异常等）逐条跳过，
 *     不抛错；空输入 total=0，successRate/avgElapsedMs 为 null（不产生 NaN）。
 *
 * @param {Array<object>} results - result.json 内容数组（通常来自 loadChainTaskResults）。
 * @param {object} [opts]
 * @param {number} [opts.now] - 当前时间毫秒时间戳，默认 Date.now()。
 * @param {number} [opts.windowMs] - 统计窗口宽度（毫秒），默认 7 天。
 * @returns {{
 *   total: number, ok: number, failed: number, markerMissing: number,
 *   byFailure: Record<string, number>, byStatus: Record<string, number>,
 *   successRate: number|null, avgElapsedMs: number|null,
 *   recent: Array<{taskId: string, status: string, errorCode: string|null, category: string|null, elapsedMs: number|null, at: string|number}>
 * }}
 */
export function summarizeChainTasks(results, { now = Date.now(), windowMs = CHAIN_WINDOW_MS_DEFAULT } = {}) {
  const list = Array.isArray(results) ? results : [];
  const windowStart = now - windowMs;

  let ok = 0;
  let failed = 0;
  let markerMissing = 0;
  const byFailure = {};
  const byStatus = {};
  let elapsedSum = 0;
  let elapsedCount = 0;
  const recentCandidates = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;

    const startRaw = item.start;
    if (typeof startRaw !== 'string' && typeof startRaw !== 'number') continue;
    const startMs = new Date(startRaw).getTime();
    if (!Number.isFinite(startMs)) continue;
    if (startMs < windowStart) continue;

    const status = typeof item.status === 'string' && item.status ? item.status : '';
    const errorCode = typeof item.errorCode === 'string' && item.errorCode ? item.errorCode : '';
    const reasonRaw = typeof item.reason === 'string' ? item.reason : '';

    byStatus[status || 'unknown'] = (byStatus[status || 'unknown'] || 0) + 1;

    let category = null;
    if (status === 'done') {
      ok += 1;
    } else {
      const combined = combineErrorCodeAndReason(errorCode, reasonRaw);
      const cls = classifyCcFailure(combined).category;
      if (cls === 'cc-marker-missing') {
        markerMissing += 1;
        category = 'cc-marker-missing';
      } else {
        failed += 1;
        category = cls;
        byFailure[category] = (byFailure[category] || 0) + 1;
      }
    }

    let elapsedMs = null;
    const endRaw = item.end;
    if (typeof endRaw === 'string' || typeof endRaw === 'number') {
      const endMs = new Date(endRaw).getTime();
      if (Number.isFinite(endMs)) {
        const diff = endMs - startMs;
        if (Number.isFinite(diff)) {
          elapsedMs = diff;
          elapsedSum += diff;
          elapsedCount += 1;
        }
      }
    }

    recentCandidates.push({
      taskId: typeof item.taskId === 'string' ? item.taskId : '',
      status: status || 'unknown',
      errorCode: errorCode || null,
      category,
      elapsedMs,
      at: startRaw,
      _sortMs: startMs,
    });
  }

  recentCandidates.sort((a, b) => b._sortMs - a._sortMs);
  const recent = recentCandidates.slice(0, RECENT_LIMIT).map(({ _sortMs, ...rest }) => rest);

  const total = ok + failed + markerMissing;
  const successRate = total > 0 ? ok / total : null;
  const avgElapsedMs = elapsedCount > 0 ? elapsedSum / elapsedCount : null;

  return { total, ok, failed, markerMissing, byFailure, byStatus, successRate, avgElapsedMs, recent };
}

/**
 * ccfeat-20260916-chainstats-a: 有界读取器——只读 D:\cc-tasks\tasks\ 下最近 limit 个
 * 任务目录的 result.json（按目录 mtime 倒序取前 limit 个），避免 tasks/ 无界增长
 * （实测已 46 个子目录且持续增长）时一次性全量扫描磁盘。
 *
 * 刻意不读 claude.log（体积不可控，属无界 IO），本函数只关心 result.json 这一份
 * 已经是聚合结果的小文件。root 默认复用 lib/cc-channel.js 的 CC_TASKS_ROOT_DEFAULT，
 * 不另立路径常量（resolveTasksRoot(env) 的环境变量覆盖属于调用方决定是否传入 root，
 * 本函数不感知 process.env）。
 *
 * 容错：
 *   - root/tasks 目录不可访问（不存在/无权限等）→ 不抛错，返回
 *     { results: [], scanned: 0, skipped: 0, reason: '<说明文本>' }；
 *   - 单个任务目录 stat 失败 → 不影响其它目录，该目录排序时视为最旧（mtimeMs=0）；
 *   - 单个任务目录下 result.json 不存在或 JSON 解析失败 → 计入 skipped 并继续，不抛；
 *   - 每条成功读出的结果会带上 taskId（取自目录名，覆盖 result.json 里可能同名的字段）。
 *
 * @param {object} [opts]
 * @param {string} [opts.root] - cc-tasks 根目录，默认 CC_TASKS_ROOT_DEFAULT。
 * @param {object} [opts.fsImpl] - 可注入 fsImpl，需实现 readdir(dir,{withFileTypes:true})、
 *   stat(path)（读 mtimeMs）、readFile(path,'utf8')；默认 node:fs/promises。
 * @param {number} [opts.limit] - 最多扫描的任务目录数（按 mtime 倒序取前 N 个），默认 100。
 * @param {number} [opts.now] - 预留（当前实现未用于过滤，读取器只负责取数，窗口过滤交给
 *   summarizeChainTasks），默认 Date.now()。
 * @returns {Promise<{results: Array<object>, scanned: number, skipped: number, reason: string|null}>}
 */
export async function loadChainTaskResults({
  root = CC_TASKS_ROOT_DEFAULT,
  fsImpl = nodeFsPromises,
  limit = CHAIN_TASKS_LIMIT_DEFAULT,
  now = Date.now(),
} = {}) {
  void now; // 预留参数：窗口过滤由 summarizeChainTasks 负责，读取器不据此裁剪。
  const tasksDir = path.join(root, 'tasks');

  let entries;
  try {
    entries = await fsImpl.readdir(tasksDir, { withFileTypes: true });
  } catch (err) {
    return {
      results: [],
      scanned: 0,
      skipped: 0,
      reason: `tasks 目录不可访问（${tasksDir}）：${String(err && err.message ? err.message : err)}`,
    };
  }

  const dirNames = [];
  for (const ent of entries || []) {
    const isDir = ent && typeof ent.isDirectory === 'function' ? ent.isDirectory() : false;
    if (isDir && ent.name) dirNames.push(ent.name);
  }

  const withMtime = [];
  for (const name of dirNames) {
    const dirPath = path.join(tasksDir, name);
    let mtimeMs = 0;
    try {
      const st = await fsImpl.stat(dirPath);
      mtimeMs = st && typeof st.mtimeMs === 'number' ? st.mtimeMs : 0;
    } catch {
      // stat 失败的目录仍参与扫描候选，只是排序时视为最旧，不因单个目录异常整体失败。
    }
    withMtime.push({ name, dirPath, mtimeMs });
  }
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const boundedLimit = Number.isFinite(limit) && limit >= 0 ? limit : CHAIN_TASKS_LIMIT_DEFAULT;
  const picked = withMtime.slice(0, boundedLimit);

  const results = [];
  let scanned = 0;
  let skipped = 0;
  for (const { name, dirPath } of picked) {
    scanned += 1;
    const resultPath = path.join(dirPath, 'result.json');
    let raw;
    try {
      raw = await fsImpl.readFile(resultPath, 'utf8');
    } catch {
      skipped += 1;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      skipped += 1;
      continue;
    }
    if (!parsed || typeof parsed !== 'object') {
      skipped += 1;
      continue;
    }
    results.push({ ...parsed, taskId: name });
  }

  return { results, scanned, skipped, reason: null };
}
