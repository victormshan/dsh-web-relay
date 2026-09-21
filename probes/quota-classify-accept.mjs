// 验收探针：插件侧额度失败分类必须覆盖**本机真实文案**（"You've hit your weekly limit · resets 2am"）。
//
// 背景（2026-09-19 实测事故，三处实现同款漏判）：
//   · 本机返回的限额文案是 **weekly limit**，而三处判据都只写 `session limit|rate limit|quota`；
//   · 链条侧：判为"未耗尽"→ 不落盘恢复时刻 → 每 20 分钟白跑 90s 探针（实测 57 次）；已修（classifyQuotaProbe）。
//   · runner 侧：失败被误分类 → 失败归因错、不写配额状态文件；已修（runner.sh 判据）。
//   · **插件侧（本任务）**：lib/cc-channel.js 的 classifyCcFailure 同样漏判 → 插件"已知耗尽不盲等"与配额展示不准。
//
// 本探针（仓库侧、双平台可跑、当场可判）：真 import lib/cc-channel.js，断言
//   [POS] weekly 文案 → kind='quota-exhausted' 且 resetsAt 可解析
//   [POS] session/rate/quota 旧文案仍被识别（不回归）
//   [NEG] 普通失败日志 → 不得判成 quota-exhausted
//   [POS] 判据块覆盖 weekly（静态，防"只加测试不改判据"）
//
// 用法: node probes/quota-classify-accept.mjs [taskId]
//       node probes/quota-classify-accept.mjs --selftest
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isWin = process.platform === 'win32';
const REPO = process.env.DSH_REPO || (isWin ? 'D:\\dsh-web-relay' : '/mnt/d/dsh-web-relay');
const MOD = path.join(REPO, 'lib', 'cc-channel.js');
const REAL_WEEKLY = "You've hit your weekly limit · resets 2am (Asia/Shanghai)";

const results = [];
const check = (label, cond, detail = '') => { results.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };

if (process.argv.includes('--selftest')) {
  const cases = [
    ['[POS] weekly 应判为 quota', /weekly|usage\s*limit|hit your/i.test("x | /weekly limit|rate limit/i") === true],
    ['[NEG] 只有 session/rate/quota 不算覆盖 weekly', /weekly|usage\s*limit|hit your/i.test("/session\\s*limit|rate\\s*limit|quota/i") === false],
  ];
  const bad = cases.filter((c) => !c[1]).length;
  for (const [l, ok] of cases) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}`);
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

let mod = null;
try { mod = await import(pathToFileURL(MOD).href); } catch (e) {
  check('[POS] lib/cc-channel.js 可导入', false, e.code === 'ERR_MODULE_NOT_FOUND' ? '不存在' : e.message);
}

// 真调用：classifyCcFailure({ result, claudeLogText })
if (mod && typeof mod.classifyCcFailure === 'function') {
  const mk = (log) => mod.classifyCcFailure({ result: { status: 'failed', exit: 1, errorCode: null }, claudeLogText: log });
  const w = mk(REAL_WEEKLY);
  check('[POS] weekly 文案 → kind=quota-exhausted（本机真实文案）', w && w.kind === 'quota-exhausted', `kind=${w && w.kind}`);
  check('[POS] weekly 文案 → resetsAt 已解析（供"已知耗尽不盲等"用）', !!(w && w.resetsAt && Date.parse(w.resetsAt) > Date.now()), `resetsAt=${w && w.resetsAt}`);
  const s = mk("You've hit your session limit · resets 7am (Asia/Shanghai)");
  check('[POS] session limit 旧文案仍识别（不回归）', s && s.kind === 'quota-exhausted', `kind=${s && s.kind}`);
  const q = mk('API error: quota exceeded');
  check('[POS] quota 关键词旧文案仍识别（不回归）', q && q.kind === 'quota-exhausted', `kind=${q && q.kind}`);
  const n = mk('Error: cannot find module "./missing.js"');
  check('[NEG] 普通失败日志 → 不得判成 quota-exhausted', n && n.kind !== 'quota-exhausted', `kind=${n && n.kind}`);
} else if (mod) {
  check('[POS] 导出 classifyCcFailure', false, '未导出');
}

// 静态：判据块必须覆盖 weekly 类文案（防"只加测试不改判据"）
const src = fs.existsSync(MOD) ? fs.readFileSync(MOD, 'utf8') : '';
const blk = (src.match(/const isQuotaExhausted[\s\S]{0,300}/) || [''])[0];
check('[POS] isQuotaExhausted 判据覆盖 weekly / usage limit / hit your', /weekly|usage\s*limit|hit your/i.test(blk), blk ? blk.split('\n')[0].slice(0, 80) : '未找到判据块');

// ---- 第四处副本：lib/cc-stats.mjs 的 FAILURE_RULES（**报告里 byFailure 指标**用的就是它）----
// 这一处是回答"插件侧是不是指当前插件"时顺藤摸出来的：同一判断在仓库里有四处实现，
// 少修一处，我在报告里引用的配额失败归因就还是错的。
const STATS = path.join(REPO, 'lib', 'cc-stats.mjs');
let stats = null;
try { stats = await import(pathToFileURL(STATS).href); } catch (e) {
  check('[POS] lib/cc-stats.mjs 可导入', false, e.message);
}
if (stats && typeof stats.classifyCcFailure === 'function') {
  // 注意返回形状是 { category, detail }（不是字符串）——初版按字符串断言 → 三条里两条假失败、一条假通过
  const cat = (t) => (stats.classifyCcFailure(t) || {}).category;
  const w = cat(REAL_WEEKLY);
  check('[POS] cc-stats.classifyCcFailure：weekly 文案 → category=cc-quota-exhausted', w === 'cc-quota-exhausted', `got=${w}`);
  const s = cat("You've hit your session limit · resets 7am (Asia/Shanghai)");
  check('[POS] cc-stats：session 文案不回归', s === 'cc-quota-exhausted', `got=${s}`);
  const n = cat('claude exit=1; done.flag=missing');
  check('[NEG] cc-stats：普通失败不得归为配额', n !== 'cc-quota-exhausted' && !!n, `got=${n}`);
} else if (stats) {
  check('[POS] 导出 classifyCcFailure（cc-stats）', false, '未导出');
}
const statsSrc = fs.existsSync(STATS) ? fs.readFileSync(STATS, 'utf8') : '';
const statsRule = (statsSrc.match(/'cc-quota-exhausted',[^\]]*\]/) || [''])[0];
check('[POS] cc-stats 的 cc-quota-exhausted 规则覆盖 weekly 类文案', /weekly|usage\s*limit|hit your/i.test(statsRule), statsRule.slice(0, 90) || '未找到规则');

// ---- 收敛性（原则：唯一收敛原语）----
// 光"两处都改对"还不够：同一判断的多份实现会再次漂移（实测：五处副本因文案变化同时失效）。
// 本组断言要求仓库里存在**唯一模块**，且两处消费者都依赖它，而不是各留一份正则。
const CANON = path.join(REPO, 'lib', 'quota-parser.mjs');
let canon = null;
try { canon = await import(pathToFileURL(CANON).href); } catch { /* 不存在则后面判 FAIL */ }
check('[POS] 存在唯一收敛模块 lib/quota-parser.mjs', !!canon);
if (canon) {
  for (const fn of ['parseResetsAt', 'isQuotaFailureText']) {
    check(`[POS] 唯一模块导出 ${fn}`, typeof canon[fn] === 'function');
  }
  if (typeof canon.isQuotaFailureText === 'function') {
    check('[POS] 唯一模块：weekly 文案 → 判为配额失败', canon.isQuotaFailureText(REAL_WEEKLY) === true);
    check('[NEG] 唯一模块：普通失败 → 不判配额', canon.isQuotaFailureText('cannot find module') === false);
  }
  // 消费方需要的"细节 API"：否则每个消费方都要自己拼 kind/resetsAt —— 那又是多处实现（收敛只做了一半）
  check('[POS] 唯一模块导出 quotaKindOf(text)', typeof canon.quotaKindOf === 'function');
  if (typeof canon.quotaKindOf === 'function') {
    check('[POS] quotaKindOf：weekly 文案 → weekly', canon.quotaKindOf(REAL_WEEKLY) === 'weekly');
    check('[POS] quotaKindOf：session 文案 → session', canon.quotaKindOf("You've hit your session limit") === 'session');
    check('[NEG] quotaKindOf：无限额措辞 → 不得谎报 weekly/session', !['weekly', 'session'].includes(canon.quotaKindOf('all tests passed')));
  }
  check('[POS] 唯一模块导出 classifyQuotaProbeDetail(text)', typeof canon.classifyQuotaProbeDetail === 'function');
  if (typeof canon.classifyQuotaProbeDetail === 'function') {
    const d1 = canon.classifyQuotaProbeDetail(REAL_WEEKLY);
    check('[POS] detail：限额文案 → available=false 且 kind=weekly 且 resetsAt 非空',
      d1 && d1.available === false && d1.kind === 'weekly' && !!d1.resetsAt, JSON.stringify(d1).slice(0, 110));
    const d2 = canon.classifyQuotaProbeDetail('OK');
    check('[POS] detail：OK → available=true', d2 && d2.available === true, JSON.stringify(d2).slice(0, 80));
  }
}
const channelSrc = fs.existsSync(MOD) ? fs.readFileSync(MOD, 'utf8') : '';
const STATS_SRC = fs.existsSync(STATS) ? fs.readFileSync(STATS, 'utf8') : '';
check('[POS] cc-channel 依赖唯一模块（而不是自带正则）', /quota-parser/.test(channelSrc));
check('[POS] cc-stats 依赖唯一模块（而不是自带正则）', /quota-parser/.test(STATS_SRC));
// [NEG] 两处都不得再出现"独立写死的限额正则字面量"
const strayRe = /\/[^/\n]*(session|rate|weekly|usage)[^/\n]*limit[^/\n]*\/i/;
check('[NEG] cc-channel 不再自带限额正则字面量', !strayRe.test(channelSrc), (channelSrc.match(strayRe) || [''])[0].slice(0, 70));
check('[NEG] cc-stats 不再自带限额正则字面量', !strayRe.test(STATS_SRC), (STATS_SRC.match(strayRe) || [''])[0].slice(0, 70));

const pass = results.filter((r) => r.cond).length;
console.log(`\nRESULT: ${pass}/${results.length} → 判定 ${pass === results.length ? 'PASS' : 'FAIL'}`);
process.exit(pass === results.length ? 0 : 1);
