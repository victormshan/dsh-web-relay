/**
 * quota-parser.mjs
 *
 * “配额判断”唯一收敛模块（纯函数、无 IO、无副作用、零第三方依赖）。
 *
 * 背景（ccfix-20260919-quotaclass）：本机 cc 的真实限额文案是
 * "You've hit your weekly limit · resets 2am (Asia/Shanghai)"，而仓库内至少两处消费者
 * （lib/cc-channel.js 的 classifyCcFailure、lib/cc-stats.mjs 的 FAILURE_RULES）此前
 * 各自写死一份只认 session/rate/quota 的正则，都漏判 weekly/usage/"hit your ... limit"，
 * 导致同一条真实失败日志在插件侧被判为“未耗尽”（不落盘恢复时刻）、在统计侧被归入
 * unknown（byFailure 看不到配额耗尽）。本模块把判断收敛到唯一实现，两处消费者改为依赖它，
 * 而不是各改各的正则（那样只是把同一个漂移风险搬到下一次文案变化）。
 *
 * 两种语义必须分开，不能混用：
 *   - **分类语义**（isQuotaFailureText）：一段失败日志是否由配额导致，只认措辞本身，
 *     不关心文本里有没有 "OK"。用于 classifyCcFailure / FAILURE_RULES 这类“审计分类”场景。
 *   - **探针语义**（classifyQuotaProbe）：额度探针的输出判定。探针的契约是“额度可用时
 *     打印 OK”，因此没有 OK 也应判定为不可用——即使探针输出里恰好不含任何限额措辞
 *     （例如探针进程崩溃、输出为空、网络错误等，都不代表额度可用）。
 *   如果把探针语义（没 OK 就算不可用）挪去做分类判断，会把任意一条不含 "OK" 的普通失败
 *   日志误判成配额耗尽；反过来把分类语义（只认措辞）挪去判探针，又会在探针输出不含
 *   限额措辞但也没打印 OK 时（比如探针本身跑挂了）误判为“可用”。两者互不可替代。
 */

/** 解析配额恢复时间时的默认时区；真实文案通常自带 (Asia/Shanghai)，缺省时以此兜底。 */
const DEFAULT_QUOTA_TZ = 'Asia/Shanghai';

/**
 * 限额措辞的单一正则常量（分类语义与探针场景下的“措辞识别”共用同一份，不得再另开一份）。
 * 覆盖：
 *   - session limit / rate limit / weekly limit / usage limit（关键词 + limit，允许中间空白）
 *   - hit your ... limit（如 "You've hit your weekly limit"，措辞里不一定含上面四个关键词，
 *     比如 "hit your daily limit"，故单独覆盖，中间最多容忍 40 字符的修饰语）
 *   - 裸的 quota 关键词（如 "API error: quota exceeded"）
 */
export const LIMIT_WORDING = /(?:(?:session|rate|weekly|usage)\s*limit|hit\s+your\b[\s\S]{0,40}?\blimit\b|\bquota\b)/i;

/**
 * 把“目标时区的挂钟时刻”换算为 UTC 毫秒时间戳（不依赖任何第三方时区库）。
 * 算法：把挂钟分量当成 UTC 取初始猜测，再用 Intl.DateTimeFormat 在目标时区读回该猜测对应的
 * 挂钟分量，以“目标挂钟分量”为基准做差修正猜测，2-3 次迭代即收敛。
 * @returns {number} UTC 毫秒时间戳。
 */
function zonedTimeToUtcMs(y, mo, d, h, mi, timeZone) {
  const target = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const seenMs = readZonedParts(guess, timeZone);
    const diff = target - seenMs; // 以目标挂钟分量为基准做差，而非以当前猜测做差
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/** 把 UTC 毫秒时间戳按目标 IANA 时区“翻译”为该时区的挂钟时刻分量。仅供 zonedTimeToUtcMs 内部使用。 */
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
 * 从形如 `resets 5:10am (Asia/Shanghai)` 的文本中尽力解析下一次配额恢复时间点。
 * 分钟可省略（默认 0，真实文案常见 "resets 7am"），时区可省略（回退 DEFAULT_QUOTA_TZ）。
 * 解析不出或时区非法时返回 null，绝不抛错。
 * @param {string} text - 待解析文本（claude.log / result.json 原文均可）。
 * @param {object} [opts]
 * @param {number} [opts.now] - 当前时间戳（毫秒，可注入便于测试），缺省 Date.now()。
 * @returns {string|null} ISO 8601 时间字符串，或 null。
 */
export function parseResetsAt(text, { now } = {}) {
  const s = typeof text === 'string' ? text : '';
  const m = s.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i);
  if (!m) return null;
  const [, hhRaw, mmRaw, ap, tzRaw] = m;
  let hour = parseInt(hhRaw, 10) % 12;
  if (/pm/i.test(ap)) hour += 12;
  const minute = mmRaw === undefined ? 0 : parseInt(mmRaw, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const tz = (tzRaw && String(tzRaw).trim()) || DEFAULT_QUOTA_TZ;
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
 * **分类语义**：这段失败日志是否由配额导致。只认 {@link LIMIT_WORDING} 措辞，不关心文本
 * 里有没有 "OK"。用于 classifyCcFailure / FAILURE_RULES 一类“把一条失败日志归类”的场景。
 * @param {string} text - 待判定文本（failure 日志 / errorCode+reason 合并文本均可）。
 * @returns {boolean} true 表示文本里出现了限额措辞。
 */
export function isQuotaFailureText(text) {
  const s = typeof text === 'string' ? text : '';
  return LIMIT_WORDING.test(s);
}

/**
 * **探针语义**：额度探针输出判定。探针契约是“额度可用时打印 OK”，因此没有 OK 也算不可用
 * （即使输出里不含任何限额措辞——探针崩溃、空输出、网络错误等场景都不代表额度可用，
 * 不能靠“没提到限额”来推定可用）。不得把本函数用于日志分类，见文件头两种语义的说明。
 * @param {string} text - 探针原始输出。
 * @returns {'available'|'exhausted'} 'available' 仅当输出中出现独立的 OK 标记。
 */
export function classifyQuotaProbe(text) {
  const s = typeof text === 'string' ? text : '';
  return /\bOK\b/.test(s) ? 'available' : 'exhausted';
}

/** 短路上限（毫秒）：weekly 档 24 小时，其余（session/rate/usage/未知）档 6 小时。 */
const SHORTCUT_CAP_MS_WEEKLY = 24 * 60 * 60 * 1000;
const SHORTCUT_CAP_MS_DEFAULT = 6 * 60 * 60 * 1000;

/**
 * 按配额种类给出“已知耗尽不盲等”短路的时间上限（毫秒），避免 resetsAt 解析异常或文案
 * 极端值时把短路窗口撑得过大/过小。weekly 类配额窗口本身以周计，给 24 小时上限；
 * 其余（session/rate/usage 等短周期配额）给 6 小时上限。
 * @param {string} kind - 配额种类（如 'weekly'、'session'、'rate'、'usage'），大小写不敏感。
 * @returns {number} 上限毫秒数。
 */
export function shortcutCapMs(kind) {
  const k = typeof kind === 'string' ? kind.toLowerCase() : '';
  return k === 'weekly' ? SHORTCUT_CAP_MS_WEEKLY : SHORTCUT_CAP_MS_DEFAULT;
}
