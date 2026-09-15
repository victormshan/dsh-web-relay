/**
 * cc-channel.js
 *
 * dsh-web-relay 宿主进程（Windows Node）与本地 Claude Code 执行器（D:\cc-tasks，
 * WSL 侧 cc-watchdog.sh 轮询 queue/*.task.json → 移入 tasks/<taskId>/task.json →
 * runner.sh 以 claude headless 执行 → 产出 out/review.md + done.flag →
 * 写 result.json {status:"done"|"failed"}）之间的“审核通道”客户端模块。
 *
 * 纯 Node ESM，Node >= 18，零第三方依赖，仅使用 node:fs/promises、node:path、node:process。
 * 所有与文件系统的交互都通过可注入的 fsImpl 完成，便于单元测试用内存 fake 替换。
 */

import * as nodeFsPromises from 'node:fs/promises';
import path from 'node:path';

/** Windows 风格的默认 cc-tasks 根目录常量。 */
export const CC_TASKS_ROOT_DEFAULT = 'D:\\cc-tasks';

/**
 * 解析 cc-tasks 根目录。
 * @param {object} env - process.env 风格对象（可注入，便于测试）。
 * @returns {string} env.DSH_CC_TASKS_ROOT 优先，否则回退 CC_TASKS_ROOT_DEFAULT。
 */
export function resolveTasksRoot(env) {
  return (env && env.DSH_CC_TASKS_ROOT) || CC_TASKS_ROOT_DEFAULT;
}

/** taskId 合法性正则：仅允许字母数字开头，随后是字母数字/点/下划线/连字符，最长 64 字符。 */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 校验 taskId 是否合法（防路径穿越/注入）。
 * @param {string} id - 待校验的 taskId。
 * @returns {boolean} 合法返回 true，否则 false（空、含路径分隔符、..、引号等一律 false）。
 */
export function sanitizeTaskId(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (!TASK_ID_RE.test(id)) return false;
  if (id.includes('..')) return false;
  return true;
}

/** 校验 taskId，非法则抛错；返回合法的 taskId 供后续拼路径使用。 */
function assertValidTaskId(taskId) {
  if (!sanitizeTaskId(taskId)) {
    throw new Error('invalid taskId');
  }
  return taskId;
}

/**
 * 截断文本到指定长度，超出时尾部追加省略标记。
 * @param {string} text - 原始文本。
 * @param {number} maxLen - 最大长度。
 * @param {string} [marker='…(截断)'] - 截断标记。
 * @returns {string} 截断后的文本。
 */
function truncateText(text, maxLen, marker = '…(截断)') {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + marker;
}

/** 生成形如 rev-<hex timestamp> 的默认 taskId。 */
function generateTaskId() {
  return `rev-${Date.now().toString(16)}`;
}

/**
 * 构建“审核任务”契约对象（task.json 结构），供派发给本地 Claude Code 执行器使用。
 * @param {object} params
 * @param {string} [params.taskId] - 任务 id；缺省时自动生成（前缀 rev-）。
 * @param {string} params.exprId - 实验 id。
 * @param {string} params.stepId - Step id。
 * @param {string} params.stepTitle - Step 标题。
 * @param {string} params.stepDetail - Step 详情。
 * @param {string} params.acceptance - 验收标准正文。
 * @param {string} params.artifactsSummary - 产物摘要。
 * @param {string} params.recordText - 任务记录摘要。
 * @param {string} params.traceText - 三方轨迹文本。
 * @param {string} [params.notesText] - 附加说明。
 * @returns {object} task.json 结构对象。
 */
export function buildReviewTask(params) {
  const {
    exprId,
    stepId,
    stepTitle,
    stepDetail,
    acceptance,
    artifactsSummary,
    recordText,
    traceText,
    notesText,
  } = params || {};

  let taskId = params && params.taskId;
  if (taskId != null) {
    assertValidTaskId(taskId);
  } else {
    taskId = generateTaskId();
  }

  const taskDir = `/mnt/d/cc-tasks/tasks/${taskId}`;
  // s2v5_3: outputDir 必须是任务根目录内的相对子路径（v2 schema 硬校验，绝对路径被
  // cc-watchdog 门控 REJECT——.invalid/ 13 例教训）。实际产出目录 = taskDir + outputDir；
  // 绝对路径提示（/mnt/d/...）只出现在 prompt 里给 Claude 落盘用，不进 task.json 字段。
  const outputDir = 'out';

  const truncRecordText = truncateText(recordText || '', 4000);
  const truncTraceText = truncateText(traceText || '', 4000);
  const truncArtifactsSummary = truncateText(artifactsSummary || '', 4000);

  const promptLines = [
    '你是 dsh-web-relay 审核员，负责审核以下 Step 是否达成验收标准。',
    '',
    '请严格按以下步骤执行：',
    '1) 仔细阅读本任务契约的 prompt 与 acceptance 字段；',
    '2) 依据下方提供的执行上下文（Step 详情、验收标准、notes、artifacts 摘要、任务记录摘要、三方轨迹）审核该 Step 是否达成验收；',
    `3) 用 Write 工具把结论写入本任务目录 ${taskDir}/out/review.md，格式严格为：第一行 \`VERDICT: APPROVED\` 或 \`VERDICT: REJECTED\`，随后空行，再写逐条意见（中文，注明严重度 高/中/低）；`,
    `4) 完成后用 Bash 工具在本任务目录 ${taskDir} 创建空文件 done.flag（touch done.flag）。`,
    '',
    `不要修改 ${taskDir} 之外的任何文件。`,
    '',
    '=== 执行上下文 ===',
    `实验 id (exprId): ${exprId || ''}`,
    `Step id (stepId): ${stepId || ''}`,
    `Step 标题 (stepTitle): ${stepTitle || ''}`,
    `Step 详情 (stepDetail): ${stepDetail || ''}`,
    `验收标准 (acceptance): ${acceptance || ''}`,
    `notes: ${notesText || ''}`,
    '',
    '--- artifacts 摘要 ---',
    truncArtifactsSummary,
    '',
    '--- 任务记录摘要 (recordText) ---',
    truncRecordText,
    '',
    '--- 三方轨迹 (traceText) ---',
    truncTraceText,
  ];

  const prompt = promptLines.join('\n');

  return {
    taskId,
    kind: 'review',
    title: `评审 dsh-web-relay Step ${stepId || ''}`,
    refs: [],
    acceptance:
      'out/review.md 存在且结论行 VERDICT: APPROVED 或 VERDICT: REJECTED；不改任何源码',
    prompt,
    outputDir,
  };
}

/**
 * 解析 review.md 文本得到审核结论。
 * @param {string} text - review.md 全文。
 * @returns {{verdict: 'approved'|'rejected'|'unknown', reason: string}}
 */
export function parseCcVerdict(text) {
  const full = typeof text === 'string' ? text : '';

  // a) VERDICT 行正则
  const verdictRe = /VERDICT\s*[:：]?\s*(APPROVED|REJECTED)/i;
  const m = full.match(verdictRe);
  if (m) {
    const verdict = m[1].toLowerCase();
    const reason = truncateText(
      full.slice(0, m.index) + full.slice(m.index + m[0].length),
      2000
    ).trim();
    return { verdict, reason };
  }

  // b) JSON 兜底
  const jsonMatch = full.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const raw = obj && (obj.result || obj.verdict);
      if (typeof raw === 'string') {
        const lower = raw.toLowerCase();
        if (lower === 'approved' || lower === 'rejected') {
          const reason = truncateText(
            full.slice(0, jsonMatch.index) +
              full.slice(jsonMatch.index + jsonMatch[0].length),
            2000
          ).trim();
          return { verdict: lower, reason };
        }
      }
    } catch {
      // JSON.parse 失败，继续下一级兜底
    }
  }

  // c) 中文关键词兜底
  if (/通过|同意|ok/i.test(full) && !/不通过|打回|拒绝|reject/i.test(full)) {
    return { verdict: 'approved', reason: truncateText(full, 2000).trim() };
  }
  if (/打回|不通过|拒绝|reject/i.test(full)) {
    return { verdict: 'rejected', reason: truncateText(full, 2000).trim() };
  }

  // d) 都无法识别
  return { verdict: 'unknown', reason: truncateText(full, 500).trim() };
}

/** 构造两种候选布局下的文件路径：<root>/tasks/<taskId>/<rel> 与 <root>/<taskId>/<rel>。 */
function candidatePaths(root, taskId, rel) {
  return [
    path.join(root, 'tasks', taskId, rel),
    path.join(root, taskId, rel),
  ];
}

/** 判断错误是否为 ENOENT（文件/目录不存在）。 */
function isEnoent(err) {
  return err && (err.code === 'ENOENT' || /ENOENT/.test(String(err && err.message)));
}

/**
 * 按 kind 分档的默认轮询超时（毫秒）。
 * review：外部审核通道的既有默认值（未变）。
 * implement / understand：runner.sh 以 `timeout 900 claude -p ...` 执行（900s 硬上限，
 * 见 docs/CC-HYBRID.md §7 "cc 有 4-8 分钟固定开销"），relay 侧轮询上限必须 ≥ 900000ms
 * 并留余量，否则任务仍在正常执行时就会被 relay 误判超时降级。
 */
export const DEFAULT_TIMEOUT_BY_KIND = {
  review: 150000,
  implement: 960000,
  understand: 960000,
};

/**
 * 解析有效轮询超时（毫秒）。优先级：显式 timeoutMs > env.DSH_CC_REVIEW_TIMEOUT_MS > 按 kind 默认值。
 * @param {object} params
 * @param {string} [params.kind] - 任务 kind（review/implement/understand），未知 kind 回退 review 档位。
 * @param {object} [params.env] - process.env 风格对象（可注入）。
 * @param {number} [params.timeoutMs] - 显式指定的超时（最高优先级）。
 * @returns {number} 有效超时毫秒数。
 */
export function resolveTimeoutMs({ kind, env, timeoutMs } = {}) {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
    return timeoutMs;
  }
  const envRaw = env && env.DSH_CC_REVIEW_TIMEOUT_MS;
  if (envRaw != null && String(envRaw).trim() !== '') {
    const n = Number(envRaw);
    if (Number.isFinite(n)) return n;
  }
  const k = typeof kind === 'string' && kind ? kind : 'review';
  return Object.prototype.hasOwnProperty.call(DEFAULT_TIMEOUT_BY_KIND, k)
    ? DEFAULT_TIMEOUT_BY_KIND[k]
    : DEFAULT_TIMEOUT_BY_KIND.review;
}

/**
 * 轮询 result.json，直到读到终态或超时。
 * 超时与真失败返回可区分的 reason：超时为 'timeout-still-running'（任务可能仍在执行，
 * 只是超出了 relay 侧轮询上限，并非任务本身失败）；真失败为 'failed'（result.json 中
 * status=failed 的终态，沿用现有解析并额外暴露 errorCode/errorText）。
 * @param {object} params
 * @param {object} params.fsImpl - 注入的文件系统实现。
 * @param {string} params.root - cc-tasks 根目录。
 * @param {string} params.taskId - 任务 id。
 * @param {string} [params.kind] - 任务 kind，用于按 kind 解析默认超时。
 * @param {object} [params.env] - process.env 风格对象，用于解析 DSH_CC_REVIEW_TIMEOUT_MS 覆盖。
 * @param {number} [params.timeoutMs] - 显式超时（最高优先级，缺省走 resolveTimeoutMs）。
 * @param {number} [params.intervalMs=3000] - 轮询间隔（毫秒）。
 * @returns {Promise<{ok: boolean, status: string, reason: string, result: (object|null), error: (string|null), elapsedMs?: number, taskDir?: string, errorCode?: *, errorText?: *}>}
 */
export async function pollTaskResult({
  fsImpl,
  root,
  taskId,
  kind,
  env,
  timeoutMs,
  intervalMs = 3000,
}) {
  assertValidTaskId(taskId);
  const paths = candidatePaths(root, taskId, 'result.json');
  const start = Date.now();
  const effectiveTimeoutMs = resolveTimeoutMs({ kind, env, timeoutMs });
  const taskDir = path.dirname(paths[0]);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const p of paths) {
      let raw;
      try {
        raw = await fsImpl.readFile(p);
      } catch (err) {
        if (isEnoent(err)) continue;
        throw err;
      }

      let result;
      try {
        result = JSON.parse(String(raw));
      } catch {
        continue;
      }

      if (result && result.status === 'done') {
        return { ok: true, status: 'done', reason: 'done', result, error: null };
      }
      if (result && result.status === 'failed') {
        const errorText = result.reason != null ? result.reason : (result.error != null ? result.error : null);
        const errorCode = result.errorCode != null ? result.errorCode : (result.code != null ? result.code : null);
        return {
          ok: false,
          status: 'failed',
          reason: 'failed',
          result,
          error: errorText,
          errorCode,
          errorText,
        };
      }
      // status 既非 done 也非 failed：视为尚无有效终态结果，继续轮询
    }

    if (Date.now() - start >= effectiveTimeoutMs) {
      const elapsedMs = Date.now() - start;
      return {
        ok: false,
        status: 'timeout',
        reason: 'timeout-still-running',
        result: null,
        error: 'cc 审核超时',
        elapsedMs,
        taskDir,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * 读取 out/review.md（兼容两种目录布局）。
 * @param {object} params
 * @param {object} params.fsImpl - 注入的文件系统实现。
 * @param {string} params.root - cc-tasks 根目录。
 * @param {string} params.taskId - 任务 id。
 * @returns {Promise<{ok: true, text: string}|{ok: false, error: string}>}
 */
export async function readReviewOut({ fsImpl, root, taskId }) {
  assertValidTaskId(taskId);
  const paths = candidatePaths(root, taskId, path.join('out', 'review.md'));

  let lastError = null;
  for (const p of paths) {
    try {
      const raw = await fsImpl.readFile(p);
      return { ok: true, text: String(raw) };
    } catch (err) {
      if (isEnoent(err)) {
        lastError = err;
        continue;
      }
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }
  return {
    ok: false,
    error: String(lastError && lastError.message ? lastError.message : 'ENOENT'),
  };
}

/**
 * 探测 cc 通道是否可用（cc-tasks 根目录是否存在），不抛异常。
 * @param {object} params
 * @param {object} params.fsImpl - 注入的文件系统实现。
 * @param {string} params.root - cc-tasks 根目录。
 * @returns {Promise<boolean>} 目录存在返回 true，ENOENT 返回 false。
 */
export async function ccChannelAvailable({ fsImpl, root }) {
  try {
    await fsImpl.access(root);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    return false;
  }
}

/** watchdog 心跳新鲜度阈值默认值（毫秒），env DSH_CC_WATCHDOG_STALE_MS 可覆盖。 */
export const WATCHDOG_STALE_MS_DEFAULT = 120000;

/**
 * watchdog 心跳文件候选名，按优先级顺序探测，命中第一个即用：
 * 1. `watchdog.heartbeat` —— 专用心跳文件，cc-watchdog.sh 轮询循环内每轮 touch（见
 *    /mnt/d/cc-tasks/cc-watchdog.sh.new），是唯一按“轮询节奏”刷新的信号。
 * 2. `watchdog.log` —— 事件驱动日志（仅 startup/dispatch/REJECT 时 echo），队列长期空闲
 *    时可能数分钟不写，不能单独当心跳用，仅作心跳文件尚未换入前的过渡回退。
 * 不再把 `cc-stats.json` 纳入候选：它只在成功派发后才更新（数分钟到数天量级的粒度），
 * 拿它判断“watchdog 轮询循环是否卡死”噪声太大，容易把“长期无任务”误判为“watchdog 死了”。
 */
const WATCHDOG_HEARTBEAT_FILES = ['watchdog.heartbeat', 'watchdog.log'];

/**
 * 派发前 watchdog liveness 探针：判定 cc 派发链（queue → watchdog → runner）的**结构**是否
 * 完好（root/queue/tasks 均可访问），心跳新鲜度只作为告警（stale）透出，不参与阻塞判定——
 * 除非显式开启 DSH_CC_WATCHDOG_STRICT=1。
 *
 * 失败方向选择（设计原则）：心跳陈旧绝大多数时候只是“事件驱动日志恰好很久没写”（watchdog
 * 仍在正常轮询），而非 watchdog 真的挂了；把这种陈旧误判为不可用 = 整条 cc 通道被瞬间短路
 * （生产环境每次派发都会撞上，代价极高）。反之若心跳真的因 watchdog 挂掉而失真，fail-open
 * 放行派发后也只是走到既有的 pollTaskResult 轮询超时（reason='timeout-still-running'），
 * 代价是多等一轮已有的超时窗口（可接受）。因此默认 fail-open：只有结构性不可用（root/queue/
 * tasks 目录缺失）才阻塞，心跳缺失或陈旧一律 ok:true + stale:true 告警放行。
 *
 * @param {object} params
 * @param {object} params.fsImpl - 注入的文件系统实现，需实现 access/stat/readdir。
 * @param {string} params.root - cc-tasks 根目录。
 * @param {object} [params.env] - process.env 风格对象，用于解析 DSH_CC_WATCHDOG_STALE_MS /
 *   DSH_CC_WATCHDOG_STRICT 覆盖。
 * @param {number} [params.now] - 当前时间戳（毫秒，可注入便于测试），缺省 Date.now()。
 * @returns {Promise<{ok: boolean, reason: string, stale: boolean, details: {logAgeMs: (number|null), queueDepth: (number|null), tasksCount: (number|null), heartbeatFile: (string|null)}}>}
 */
export async function ccWatchdogAlive({ fsImpl, root, env, now }) {
  const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const thresholdMs = (() => {
    const raw = env && env.DSH_CC_WATCHDOG_STALE_MS;
    if (raw != null && String(raw).trim() !== '') {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
    return WATCHDOG_STALE_MS_DEFAULT;
  })();
  const strict = !!(env && env.DSH_CC_WATCHDOG_STRICT === '1');

  const emptyDetails = { logAgeMs: null, queueDepth: null, tasksCount: null, heartbeatFile: null };

  try {
    await fsImpl.access(root);
  } catch (err) {
    return { ok: false, reason: 'root-unavailable', stale: false, details: { ...emptyDetails } };
  }

  let queueDepth = null;
  try {
    const entries = await fsImpl.readdir(path.join(root, 'queue'));
    // A7（2026-09-16 实测修正）: **只计任务文件**（*.task.json）。原实现直接取 readdir 长度，
    // 而 queue/ 下常态存在 .dupes 与 .invalid 两个归档子目录 → queueDepth 恒 ≥2，
    // 使「是队列积压还是守护缺失」这一诊断判据失真（实测 details.queueDepth=2 时队列里其实没有任务）。
    queueDepth = Array.isArray(entries)
      ? entries.filter((n) => typeof n === 'string' && n.endsWith('.task.json')).length
      : null;
  } catch (err) {
    return { ok: false, reason: 'queue-dir-missing', stale: false, details: { ...emptyDetails } };
  }

  let tasksCount = null;
  try {
    const entries = await fsImpl.readdir(path.join(root, 'tasks'));
    tasksCount = Array.isArray(entries) ? entries.length : null;
  } catch (err) {
    return { ok: false, reason: 'tasks-dir-missing', stale: false, details: { ...emptyDetails, queueDepth } };
  }

  let logAgeMs = null;
  let heartbeatFile = null;
  for (const name of WATCHDOG_HEARTBEAT_FILES) {
    try {
      const st = await fsImpl.stat(path.join(root, name));
      const mtimeMs = st && typeof st.mtimeMs === 'number'
        ? st.mtimeMs
        : (st && st.mtime ? new Date(st.mtime).getTime() : null);
      if (mtimeMs != null && Number.isFinite(mtimeMs)) {
        logAgeMs = nowMs - mtimeMs;
        heartbeatFile = name;
        break;
      }
    } catch (err) {
      continue;
    }
  }

  // 结构完好（root/queue/tasks 均可访问）之后的分支：心跳缺失/陈旧只告警，默认不阻塞。
  const details = { logAgeMs, queueDepth, tasksCount, heartbeatFile };

  if (logAgeMs === null) {
    if (strict) {
      return { ok: false, reason: 'cc-watchdog-stale:missing', stale: true, details };
    }
    return { ok: true, reason: 'alive-unverified:missing', stale: true, details };
  }

  if (logAgeMs > thresholdMs) {
    if (strict) {
      return { ok: false, reason: `cc-watchdog-stale:${logAgeMs}`, stale: true, details };
    }
    return { ok: true, reason: `alive-unverified:${logAgeMs}`, stale: true, details };
  }

  return { ok: true, reason: 'alive', stale: false, details };
}

/**
 * 把 UTC 毫秒时间戳按目标 IANA 时区“翻译”为该时区的挂钟时刻分量。内部用于
 * {@link zonedTimeToUtcMs} 的不动点迭代，不导出。
 */
function readZonedParts(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const map = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour);
  return Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second));
}

/**
 * 把“目标时区的挂钟时刻”换算为 UTC 毫秒时间戳（不依赖任何第三方时区库）。
 * 算法：先把挂钟分量当成 UTC 取一个初始猜测，再用 Intl.DateTimeFormat 在目标时区读回
 * 该猜测对应的挂钟分量，用差值修正猜测，2-3 次迭代即收敛（非 DST 切换瞬间的绝大多数时刻
 * 1 次即收敛）。抛出异常（如非法 timeZone）时由调用方 catch。
 */
function zonedTimeToUtcMs(y, mo, d, h, mi, timeZone) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (let i = 0; i < 3; i++) {
    const seenMs = readZonedParts(guess, timeZone);
    const diff = guess - seenMs;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/**
 * 从形如 `resets 5:10am (Asia/Shanghai)` 的文本中尽力解析下一次配额恢复时间点。
 * 解析不出或时区非法时返回 null，绝不抛错。
 * @param {string} text - 待解析文本（claude.log / result.json 原文均可）。
 * @param {object} [opts]
 * @param {number} [opts.now] - 当前时间戳（毫秒，可注入便于测试），缺省 Date.now()。
 * @returns {string|null} ISO 8601 时间字符串，或 null。
 */
export function parseResetsAt(text, { now } = {}) {
  const s = typeof text === 'string' ? text : '';
  const m = s.match(/resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^)]+)\)/i);
  if (!m) return null;
  const [, hhRaw, mmRaw, ap, tz] = m;
  let hour = parseInt(hhRaw, 10) % 12;
  if (/pm/i.test(ap)) hour += 12;
  const minute = parseInt(mmRaw, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();

  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const map = {};
    for (const part of dtf.formatToParts(new Date(nowMs))) {
      if (part.type !== 'literal') map[part.type] = part.value;
    }
    const y = Number(map.year);
    const mo = Number(map.month);
    const d = Number(map.day);

    let candidate = zonedTimeToUtcMs(y, mo, d, hour, minute, tz);
    if (candidate <= nowMs) {
      // 目标挂钟时刻已过（今天该时刻早于当前时间）——配额重置一定发生在未来，顺延到明天。
      candidate = zonedTimeToUtcMs(y, mo, d + 1, hour, minute, tz);
    }
    if (!Number.isFinite(candidate)) return null;
    return new Date(candidate).toISOString();
  } catch {
    return null;
  }
}

/**
 * 把一次 cc 派发失败的原始证据（result.json + claude.log 原文）分类为可审计的失败类型，
 * 使“配额耗尽”“权限被拒”“真实执行超时”“代码本身失败”“仅缺完成标记（产物完好）”在审计上
 * 互相可区分（此前一律记成 `claude exit=N; done.flag=missing`，配额耗尽/真实代码失败/仅缺
 * 完成标记三者在审计上不可区分）。
 * 优先消费 runner.sh 已产出的 result.json.errorCode（cc-quota-exhausted / cc-permission-denied /
 * cc-timeout / cc-failed / v2-validate-failed / cc-marker-missing），errorCode 缺失时退化为对
 * claude.log 原文做关键词兜底识别。纯函数，不做任何 IO。
 *
 * 注意：cc-marker-missing 的判定必须排在 isCodeFailed 分支之前——runner.sh 为
 * cc-marker-missing 写入的 result.json 里 status 同样是 "failed"，isCodeFailed 分支的兜底
 * 条件 `result.status === 'failed'` 会先命中并把它误判为 code-failed，导致「代码写坏了」与
 * 「只是没写完成标记」在审计上又变得不可区分。
 * @param {object} params
 * @param {object} [params.result] - result.json 解析后的对象（可为空）。
 * @param {string} [params.claudeLogText] - claude.log 原文（可为空）。
 * @param {number} [params.now] - 当前时间戳（毫秒，可注入），传给 parseResetsAt。
 * @returns {{kind: ('quota-exhausted'|'permission-denied'|'timeout'|'marker-missing'|'code-failed'|'unknown'), errorCode: (string|null), resetsAt: (string|null), raw: string}}
 */
export function classifyCcFailure({ result, claudeLogText, now } = {}) {
  const logText = typeof claudeLogText === 'string' ? claudeLogText : '';
  const resultText = result != null ? (() => { try { return JSON.stringify(result); } catch { return String(result); } })() : '';
  const combined = `${logText}\n${resultText}`;
  const raw = truncateText(combined.trim(), 2000);
  const errorCode = result && result.errorCode != null ? String(result.errorCode) : null;

  const isPermissionDenied = errorCode === 'cc-permission-denied'
    || /permissions to write|haven'?t granted/i.test(combined);
  if (isPermissionDenied) {
    return { kind: 'permission-denied', errorCode, resetsAt: null, raw };
  }

  const isQuotaExhausted = errorCode === 'cc-quota-exhausted'
    || /session\s*limit|rate\s*limit|\bquota\b/i.test(combined);
  if (isQuotaExhausted) {
    const resetsAt = parseResetsAt(combined, { now });
    return { kind: 'quota-exhausted', errorCode, resetsAt, raw };
  }

  const isTimeout = errorCode === 'cc-timeout';
  if (isTimeout) {
    return { kind: 'timeout', errorCode, resetsAt: null, raw };
  }

  const isMarkerMissing = errorCode === 'cc-marker-missing';
  if (isMarkerMissing) {
    return { kind: 'marker-missing', errorCode, resetsAt: null, raw };
  }

  const isCodeFailed = errorCode === 'cc-failed'
    || errorCode === 'v2-validate-failed'
    || (result && result.status === 'failed');
  if (isCodeFailed) {
    return { kind: 'code-failed', errorCode, resetsAt: null, raw };
  }

  return { kind: 'unknown', errorCode, resetsAt: null, raw };
}

/**
 * 派发前配额状态判定：若已持久化的最近一次失败分类已知为配额耗尽且当前时间早于其
 * resetsAt，则应直接跳过本次派发（沿用既有降级链，不再盲等整个轮询超时）。纯函数，
 * 可注入 now 便于测试；quotaState 缺失/字段不全一律判定为“不跳过”（fail-open，交由
 * 正常派发链自行发现问题），避免因状态文件损坏而误伤派发。
 * @param {object} params
 * @param {{kind: string, resetsAt: (string|null)}|null|undefined} params.quotaState - 上次持久化的配额分类状态。
 * @param {number} [params.now] - 当前时间戳（毫秒，可注入），缺省 Date.now()。
 * @returns {boolean} true 表示应跳过本次派发（配额已知未恢复）。
 */
export function shouldSkipForKnownQuotaExhaustion({ quotaState, now } = {}) {
  if (!quotaState || quotaState.kind !== 'quota-exhausted' || !quotaState.resetsAt) return false;
  const resetsMs = Date.parse(quotaState.resetsAt);
  if (!Number.isFinite(resetsMs)) return false;
  const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  return nowMs < resetsMs;
}

/**
 * 基于 node:fs/promises 的真实文件系统实现，供生产环境注入使用。
 * readFile/access/stat/readdir 失败抛出原始错误（如 ENOENT）；writeFile 自动创建父目录。
 */
export const nodeFsImpl = {
  async readFile(p) {
    return nodeFsPromises.readFile(p, 'utf8');
  },
  async writeFile(p, data) {
    await nodeFsPromises.mkdir(path.dirname(p), { recursive: true });
    return nodeFsPromises.writeFile(p, data, 'utf8');
  },
  async access(p) {
    return nodeFsPromises.access(p);
  },
  async mkdir(p, opts) {
    return nodeFsPromises.mkdir(p, opts || { recursive: true });
  },
  async stat(p) {
    return nodeFsPromises.stat(p);
  },
  async readdir(p) {
    return nodeFsPromises.readdir(p);
  },
};
