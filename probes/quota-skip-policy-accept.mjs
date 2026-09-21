// 验收探针：**"已知耗尽 → 跳过派发"这条策略**必须收敛（含 cap），不能一个消费方有保护、另一个没有。
//
// 背景（2026-09-19，主 agent 复核 v17 时发现）：
//   v15/v17 把**判据**（措辞正则、resetsAt 解析、kind）收敛到了 lib/quota-parser.mjs，但**策略**没有：
//     · 主 agent 的链条：只在「剩余等待 ≤ shortcutCapMs(kind)」时才短路（周 24h / 会话 6h）——
//       这是对"resetsAt 被误解析/陈旧"的保护（解析器会把已过去的时刻滚到明天 → 最长 ~24h）；
//     · 插件 lib/cc-channel.js 的 shouldSkipForKnownQuotaExhaustion：`now < resetsAt` 就跳过，**没有 cap**。
//   于是同一份数据在两个消费方得到不同强度的保护：插件可能被一个错误/陈旧的时间戳**静默停掉派发一整个窗口**。
//   而且规范模块导出的 shortcutCapMs 在仓库里**没有任何消费者**（只有定义）——"策略未落地"的机器签名。
//
// 本探针断言（仓库侧、双平台、当场可判）：
//   [POS] 插件确实依赖唯一模块的 shortcutCapMs（而不是自定义窗口）
//   [POS] shouldSkipForKnownQuotaExhaustion 在“剩余等待在 cap 内”时返回 true
//   [NEG] 剩余等待**远超 cap**（如 20 天后的时间戳）时不得跳过（否则就是静默停摆）
//   [POS] weekly 与 session 的 cap 差异真实生效（同一时间戳，weekly 可跳、session 不跳）
//   [NEG] resetsAt 缺失/不可解析 → 不得跳过（fail-open 到"照常派发"）
//   [POS] 插件持久化配额状态时带上 quotaKind（否则 cap 无法按种类取）
//
// 用法: node probes/quota-skip-policy-accept.mjs [taskId]
//       node probes/quota-skip-policy-accept.mjs --selftest
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isWin = process.platform === 'win32';
const REPO = process.env.DSH_REPO || (isWin ? 'D:\\dsh-web-relay' : '/mnt/d/dsh-web-relay');
const CHANNEL = path.join(REPO, 'lib', 'cc-channel.js');
const INDEX = path.join(REPO, 'lib', 'index.js');

const results = [];
const check = (label, cond, detail = '') => { results.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };

if (process.argv.includes('--selftest')) {
  // 判定助手自检：给定 cap 与剩余等待，决定是否该跳过（防探针自身永真）
  const shouldSkip = (remainingMs, capMs) => remainingMs > 0 && remainingMs <= capMs;
  const cases = [
    ['[POS] 剩余在 cap 内 → 跳过', shouldSkip(60 * 60 * 1000, 6 * 3600000) === true],
    ['[NEG] 剩余远超 cap → 不跳过', shouldSkip(20 * 24 * 3600000, 24 * 3600000) === false],
    ['[NEG] 已过期（剩余为负）→ 不跳过', shouldSkip(-1000, 24 * 3600000) === false],
  ];
  const bad = cases.filter((c) => !c[1]).length;
  for (const [l, ok] of cases) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}`);
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

// ---- 静态：插件必须依赖唯一模块的 cap ----
const chanSrc = fs.existsSync(CHANNEL) ? fs.readFileSync(CHANNEL, 'utf8') : '';
const indexSrc = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : '';
check('[POS] cc-channel 引用了唯一模块的 shortcutCapMs', /shortcutCapMs/.test(chanSrc));
check('[POS] shortcutCapMs 在仓库里确有消费者（不再是死代码）', /shortcutCapMs/.test(chanSrc) || /shortcutCapMs/.test(indexSrc));
check('[POS] 插件持久化配额状态时带 quotaKind（cap 才能按种类取）', /quotaKind/.test(indexSrc) || /quotaKind/.test(chanSrc));

// ---- 行为：cap 真实生效 ----
let mod = null;
try { mod = await import(pathToFileURL(CHANNEL).href); } catch (e) {
  check('[POS] lib/cc-channel.js 可导入', false, e.code === 'ERR_MODULE_NOT_FOUND' ? '不存在' : e.message);
}
if (mod && typeof mod.shouldSkipForKnownQuotaExhaustion === 'function') {
  const now = Date.parse('2026-09-19T12:00:00.000Z');
  const mk = (mins, quotaKind) => ({ kind: 'quota-exhausted', resetsAt: new Date(now + mins * 60000).toISOString(), quotaKind });
  const skip = (s) => mod.shouldSkipForKnownQuotaExhaustion({ quotaState: s, now });
  check('[POS] 会话档：剩余 1h（≤6h）→ 跳过', skip(mk(60, 'session')) === true);
  check('[NEG] 会话档：剩余 20h（>6h）→ **不得**跳过（否则可能静默停摆）', skip(mk(20 * 60, 'session')) === false, `skip=${skip(mk(20 * 60, 'session'))}`);
  check('[POS] 周档：剩余 20h（≤24h）→ 跳过', skip(mk(20 * 60, 'weekly')) === true);
  check('[NEG] 周档：剩余 20 天（>24h）→ 不得跳过', skip(mk(20 * 24 * 60, 'weekly')) === false);
  check('[NEG] resetsAt 缺失 → 不跳过', skip({ kind: 'quota-exhausted', resetsAt: null }) === false);
  check('[NEG] resetsAt 不可解析 → 不跳过', skip({ kind: 'quota-exhausted', resetsAt: 'not-a-date' }) === false);
  check('[NEG] 非 quota-exhausted 状态 → 不跳过', skip({ kind: 'available', resetsAt: new Date(now + 3600000).toISOString() }) === false);
} else if (mod) {
  check('[POS] 导出 shouldSkipForKnownQuotaExhaustion', false, '未导出');
}

const pass = results.filter((r) => r.cond).length;
console.log(`\nRESULT: ${pass}/${results.length} → 判定 ${pass === results.length ? 'PASS' : 'FAIL'}`);
process.exit(pass === results.length ? 0 : 1);
