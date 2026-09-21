// 门禁：额度判据的**跨实现一致性**——同一判断有三处实现，必须都认同一套文案。
//
// 为什么需要（2026-09-19 实测事故）：本机真实文案是 "You've hit your weekly **limit** · resets 2am"，
// 而三处实现的判据都只覆盖 session limit / rate limit / quota →
//   ① 链条：判为"未耗尽" → 不解析、不落盘恢复时刻 → 每 20 分钟白跑一次 90s 探针（累计 57 次）；
//   ② runner：失败被误分类（非 cc-quota-exhausted）→ 失败归因错、不写配额状态文件；
//   ③ 插件：同样漏判 → 插件侧"已知耗尽不盲等"短路与配额展示都不准。
// 三处各写一份判据，就是三份各写各的漂移源；本门禁把它们钉在同一组用例上。
//
// 用法: node verify-quota-patterns.mjs [--selftest]
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// ⚠ 绝不 import cc-chain.mjs：它**没有 import 守卫**（顶层直接执行主流程）。
//   2026-09-19 实测：本门禁初版 `import { classifyQuotaProbe } from './cc-chain.mjs'` →
//   **把整条链跑了一遍**（当时恰逢配额暂停才只打印"跳过"；若额度可用就会真的派发 cc 任务）。
//   故改为**子进程跑它自己的 --selftest-quota**（诊断模式、无状态副作用），按输出判定。
const CC_CHAIN = 'D:\\dsh relay test\\cc-chain.mjs';

const RUNNER = 'D:\\cc-tasks\\runner.sh';
const REPO = 'D:\\dsh-web-relay';
const CHANNEL = `${REPO}\\lib\\cc-channel.js`;
const REAL_WEEKLY = "You've hit your weekly limit · resets 2am (Asia/Shanghai)";
const NORMAL = 'all tests passed, nothing to see';

/** 从 runner.sh 抽出 grep 的额度判据（-E 后的单引号串） */
export function extractRunnerPattern(shText) {
  const m = String(shText || '').match(/grep\s+-qiE\s+'([^']+)'/);
  return m ? m[1] : null;
}

/** 纯函数：插件侧是否**依赖唯一收敛模块**（2026-09-19 收敛后，判据不再是"本文件里有没有 weekly 字样"，
 *  而是"它有没有把判断交给唯一模块" —— 这条静态期望必须跟着架构一起改，否则收敛完成反而报假失败）。
 *  注意：不能只判 /limit/i —— `session\s*limit` 里就有 "limit"，会**假通过**（本门禁初版即如此）。 */
export function pluginDependsOnCanonical(src) {
  const m = String(src || '').match(/const isQuotaExhausted[\s\S]{0,400}/);
  if (!m) return { ok: false, why: '未找到 isQuotaExhausted 判据' };
  const block = m[0];
  const covers = /quota-parser|isQuotaFailureText/.test(block) || /quota-parser/.test(String(src));
  return { ok: covers, why: covers ? '依赖唯一模块（quota-parser）' : '既未依赖唯一模块，也不含 weekly 类措辞' };
}

function selftest() {
  const cases = [];
  const t = (label, cond, detail = '') => { cases.push(cond); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };
  // [POS] 抽取器认得两种写法
  t('[POS] 抽取 runner 判据（-qiE 单引号）', extractRunnerPattern("x; then grep -qiE 'a|b' ; y") === 'a|b');
  t('[NEG] 抽取器对不含该写法的文本返回 null（不得瞎抓）', extractRunnerPattern('echo hi') === null);
  // [POS]/[NEG] 插件判据（收敛后：判据是"依赖唯一模块"，不再是"本文件里有 weekly 字样"）
  t('[POS] 依赖唯一模块的判据 → 认', pluginDependsOnCanonical("const isQuotaExhausted = ec === 'x' || isQuotaFailureText(y)").ok === true);
  t('[POS] 引用了 quota-parser 的判据 → 认', pluginDependsOnCanonical("import { isQuotaFailureText } from './quota-parser.mjs'\nconst isQuotaExhausted = ec === 'x' || isQuotaFailureText(y)").ok === true);
  t('[NEG] 既不自带 weekly 措辞、也不依赖唯一模块 → 抓', pluginDependsOnCanonical("const isQuotaExhausted = ec === 'x' || /session\\s*limit|rate\\s*limit/i.test(y)").ok === false);
  const ok = cases.filter(Boolean).length;
  console.log(`\nRESULT: ${ok}/${cases.length} ${ok === cases.length ? 'PASS' : 'FAIL'}`);
  return ok === cases.length;
}
if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

const results = [];
const check = (label, cond, detail = '') => { results.push(cond); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };

// ① runner.sh —— 收敛后它**不再自带判据**，而是桥接到唯一模块（CLI）：
//    所以断言从"抽取它的 grep 模式"改为"桥接 + 行为"（行为比文本更接近真实：直接用 CLI 判真实文案）。
const sh = fs.existsSync(RUNNER) ? fs.readFileSync(RUNNER, 'utf8') : '';
const CLI = '/mnt/d/cc-tasks/quota-classify-cli.mjs';
const runCli = (mode, text) => spawnSync('wsl.exe', ['-e', 'node', CLI, ...(mode ? [`--mode=${mode}`] : []), text], { encoding: 'utf8' });
const runnerBridged = /quota-classify(-cli)?\.mjs/.test(sh);
check('[POS] runner.sh 桥接到唯一模块（不再自带限额正则）', runnerBridged, runnerBridged ? '' : '未见 quota-classify 引用');
check('[NEG] runner.sh 不得再出现自带的限额 grep 判据', !/grep\s+-qiE\s+'session\[\[:space:\]\]\*limit/.test(sh));
if (runnerBridged) {
  const w = `${runCli('failure', REAL_WEEKLY).stdout || ''}`.trim();
  const n = `${runCli('failure', NORMAL).stdout || ''}`.trim();
  check('[POS] runner 桥：真实 weekly 文案 → quota=true', /quota=true/.test(w), w);
  check('[NEG] runner 桥：普通日志 → quota=false', /quota=false/.test(n), n);
}

// ② cc-chain.mjs —— 跑它自己的诊断自测（不经 import，避免触发主流程）
{
  const r = spawnSync(process.execPath, [CC_CHAIN, '--selftest-quota'], { encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  check('[POS] cc-chain --selftest-quota 通过', r.status === 0 && /RESULT: PASS/.test(out), `exit=${r.status}`);
  check('[POS] 其分类器命中真实 weekly 文案（limited=true kind=weekly）',
    /PASS\s+limited=true kind=weekly/.test(out), out.split('\n').filter((l) => /weekly/.test(l))[0]?.trim().slice(0, 90) || '(无该行)');
  check('[POS] weekly 恢复时刻被解析（"不再白探"的前提）', /weekly 恢复时刻已解析 = true/.test(out));
}
check('[NEG] 本门禁源码不得 import cc-chain（否则会连带执行主流程）',
  !/^\s*import\s+\{[^}]*\}\s+from\s+['"]\.\/cc-chain\.mjs['"]/m.test(fs.readFileSync('D:\\dsh relay test\\verify-quota-patterns.mjs', 'utf8')));

// ③ 插件 lib/cc-channel.js
const ch = fs.existsSync(CHANNEL) ? fs.readFileSync(CHANNEL, 'utf8') : '';
if (!ch) check('[POS] 读到 lib/cc-channel.js', false, '文件不存在');
else {
  const pc = pluginDependsOnCanonical(ch);
  check('[POS] 插件判据（cc-channel）把判断交给唯一模块', pc.ok, pc.why);
}

// ④ 插件 lib/cc-stats.mjs —— **报告里 byFailure 指标**用的第四处副本（回答"插件侧指谁"时顺藤摸出来的）
// 该模块是纯函数模块（无顶层副作用），可安全 import。
const STATS = `${REPO}\\lib\\cc-stats.mjs`;
let statsMod = null;
try { statsMod = await import(`file:///${STATS.replace(/\\/g, '/')}`); } catch (e) {
  check('[POS] 读到 lib/cc-stats.mjs', false, e.message);
}
if (statsMod && typeof statsMod.classifyCcFailure === 'function') {
  const cat = (t) => (statsMod.classifyCcFailure(t) || {}).category;
  check('[POS] cc-stats 归类：weekly 文案 → cc-quota-exhausted', cat(REAL_WEEKLY) === 'cc-quota-exhausted', `got=${cat(REAL_WEEKLY)}`);
  check('[NEG] cc-stats 归类：普通失败不得算配额', cat('claude exit=1; done.flag=missing') !== 'cc-quota-exhausted');
} else if (statsMod) {
  check('[POS] cc-stats 导出 classifyCcFailure', false, '未导出');
}

const ok = results.filter(Boolean).length;
console.log(`\nRESULT: ${ok}/${results.length} ${ok === results.length ? 'PASS' : 'FAIL'}`);
process.exit(ok === results.length ? 0 : 1);
