// 分层审计统一入口：③门禁自审 ④链条运行 ⑤交付接地 ⑥事实复跑 —— 让"接地"真正**每周期自动发生**。
//
// 为什么需要它（本会话教训）：③④⑤⑥ 各自都做了、都自检通过，但**没有任何周期机制调用它们**——
// 那么它们只是"我下次想起来才跑"的一次性检查，等于把"靠运气发现"从人换成脚本，并没有真正消除。
// 这个入口把四层串成一条命令，并把结论落成一行日志，便于挂到计划任务上。
//
// 关键设计（沿用本会话确立的门禁纪律）：
//   ① 判定基于**退出码**而非散文：0=PASS / 1=判定失败 / 3=工具错误(INSTRUMENT-ERROR，需人修，不是业务失败)；
//   ② **层级缺失也算工具错误**——少了任何一层都不能"剩下的都绿所以算通过"（这正是"假守卫"的经典成因）；
//   ③ 负控必须两侧：全绿要放行，任一层失败要抓，任一层崩溃要能与失败**区分**，缺层/空输入要抓。
//
// 用法: node audit-all.mjs [--json] [--quiet]
//       node audit-all.mjs --selftest      # 两侧自检
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chainLive } from './chain-lock.mjs';

const WORK = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '));

// 必须存在的审计层（缺一层 → 工具错误，而不是"通过"）
export const REQUIRED_LAYERS = [
  { key: 'gates', name: '③ 门禁自审 meta-gate', file: 'verify-gates.mjs', args: [] },
  { key: 'chainRun', name: '④ 链条运行审计', file: 'verify-chain-run.mjs', args: [] },
  { key: 'delivery', name: '⑤ 交付接地', file: 'verify-delivery-live.mjs', args: [] },
  { key: 'claims', name: '⑥ 事实复跑', file: 'verify-claims.mjs', args: [] },
  // 2026-09-19 新增：把"语境能力有没有漂移"纳入周期审计。
  // 起因：lessons 末条停在 09-15，而 09-16~09-19 四天的机制建设一条都没沉淀——没有任何检查会发现这件事。
  { key: 'sediment', name: '⑦ 沉淀校验（registry 断言 + lessons schema + 交接文本会用到它们）', file: 'verify-sediment.mjs', args: [] },
  // 2026-09-19 新增：判据 + **策略** 的调用点穷举（策略点必须复用唯一模块的 cap）。
  // 起因：判据收敛后策略仍是两处实现（链条有 cap、插件没有）→ 同一份数据两个保护级别；
  // 该门禁实跑精确指向 cc-channel:588，v18 修好后转 PASS 才登记（否则会让审计连刷"需要人"信号）。
  { key: 'quotaSingleSource', name: '⑧ 配额判据/策略穷举（唯一来源 + cap 复用）', file: 'verify-quota-single-source.mjs', args: [] },
  // 2026-09-20 新增：唤醒通路「**实际发生**」审计。
  // 起因：⑫/⑬ 门禁只用夹具验唤醒通路的**机制正确性**，而"上一次真实重启到底有没有真的唤醒"
  // 无人验——这条能力的失败模式是"坏了就没人被叫醒"，与安静的无人值守在现象上无法区分
  // （09-19 已实测代价 4 小时）。勘查还发现信号唤醒路径**零 durable 痕迹**，故本轮先在插件侧补痕迹。
  // 该层允许返回 4（未验证）：证据不足时**既不判通过也不判失败**，由 judgeAudits 显式列出（见下方 unverified）。
  // mayBeUnverified 是**声明式**白名单：没有这个标记的层返回 4 仍按"非法跳过"处理（工具错误），
  // 以免任何层用 4 悄悄退场。且未验证会进 verdict.reason 被点名，不是静默通过。
  { key: 'wakeOccurrence', name: '⑨ 唤醒通路实际发生（痕迹 + 欠条纪律）', file: 'verify-wake-occurrence.mjs', args: [], mayBeUnverified: true },
  // 2026-09-20 新增：⑩ 迭代状态机审计（三方协议 step list）。
  // 起因：四类任务载体里，step list 是唯一"有状态机 + 有护栏 + 驱动自动版本演化"却**没有审计层**的一个
  // ——"版本迭代卡住了没有"只能靠人看 /health-check，卡住时是静默的（与影子沙盒死数月、唤醒零痕迹同型）。
  // 判据 J1..J5（停滞 / 熔断未登记 / 终态自洽 / 声明自洽 / 版间门）；范围由仓库 lib/resume-scan.js
  // 的**权威实现**决定（只读导入，不重写"什么算中断"——避免同一事实两个判定源）。
  { key: 'iterationState', name: '⑩ 迭代状态机（停滞 / 熔断登记 / 终态与声明自洽）', file: 'verify-iteration-state.mjs', args: [], mayBeUnverified: true },
  // 2026-09-20 新增：⑪ 事件路径**演练**（dryRun）。⑨⑩ 审的是"状态"，本层审的是"**事件路径会不会留下产物**"：
  // 走同一段生产代码、只把最后一步落盘换成返回（零副作用），故可进周期审计。
  // 插件尚未支持 drill 时，脚本会**自清理**并报未验证（绝不把"没验成"当通过、也不留下误写信号）。
  { key: 'eventDrill', name: '⑪ 事件路径演练（熔断登记 dryRun，零副作用）', file: 'verify-autoir-drill.mjs', args: [], mayBeUnverified: true },
];

// 允许在"链条运行中"跳过的层（需要稳定仓库快照）。白名单：不在里面的一律不许跳过。
export const SKIPPABLE_WHEN_LOCKED = new Set(['delivery', 'claims']);

// 纯函数：把各层结果判成一个总判定。runs: [{key,name,code,signal,tail,skipped}]
// chainLive：此刻是否有链条在飞（决定"跳过"是否合法——白名单 + 必须真有链锁）
export function judgeAudits(runs, required = REQUIRED_LAYERS, opts = {}) {
  const chainLive = !!opts.chainLive;
  const errors = [];
  const okCodes = new Set([0, 1, 3]);
  if (!Array.isArray(runs) || runs.length === 0) {
    return { verdict: 'INSTRUMENT-ERROR', exit: 3, reason: '没有任何审计层的结果（空输入）', failed: [], crashed: [], skipped: [], missing: required.map((r) => r.key) };
  }
  const byKey = new Map(runs.map((r) => [r.key, r]));
  const missing = required.filter((r) => !byKey.has(r.key)).map((r) => r.key);
  if (missing.length) errors.push(`缺审计层：${missing.join(', ')}（不能因为"剩下的都绿"就算通过）`);

  const crashed = [];
  const failed = [];
  const skipped = [];
  const unverified = [];
  for (const r of runs) {
    const name = r.name || r.key;
    if (r.skipped) {
      // 跳过只允许两层条件同时满足：① 真有链锁在飞；② 该层在可跳过白名单里
      if (!chainLive) { crashed.push(`${name}(声称不适用，但当前并无链条在飞 → 非法跳过)`); continue; }
      if (!SKIPPABLE_WHEN_LOCKED.has(r.key)) { crashed.push(`${name}(链条运行中，但该层不可跳过 → 非法跳过)`); continue; }
      skipped.push(name);
      continue;
    }
    if (r.code === 3) { crashed.push(`${name}(INSTRUMENT-ERROR)`); continue; }
    if (r.signal) { crashed.push(`${name}(被信号终止 ${r.signal})`); continue; }
    // 未验证（NOT-APPLICABLE）：**必须显式声明** r.unverified === true 才认，否则仍按异常退出码处理。
    // 这一条是防"用 4 悄悄退场"的最后一道闸：code 4 裸返回 = 工具错误，不会变成一次静默通过。
    if (r.code === 4 && r.unverified) { unverified.push(name); continue; }
    if (!okCodes.has(r.code)) { crashed.push(`${name}(异常退出码 ${r.code})`); continue; }
    if (r.code === 1) failed.push(name);
  }
  if (crashed.length) return { verdict: 'INSTRUMENT-ERROR', exit: 3, reason: `工具错误与判定必须可区分；本次是工具错误：${crashed.join('、')}`, failed, crashed, skipped, unverified, missing, errors };
  if (errors.length) return { verdict: 'INSTRUMENT-ERROR', exit: 3, reason: errors.join('；'), failed, crashed, skipped, unverified, missing, errors };
  if (failed.length) return { verdict: 'ACTION-NEEDED', exit: 1, reason: `以下审计层判定不通过：${failed.join('、')}${unverified.length ? `（另有未验证层：${unverified.join('、')}）` : ''}`, failed, crashed, skipped, unverified, missing, errors: [] };
  if (skipped.length || unverified.length) {
    const parts = [];
    if (skipped.length) parts.push(`${skipped.length} 层因链条运行中跳过`);
    if (unverified.length) parts.push(`${unverified.length} 层证据不足未验证`);
    return { verdict: 'OK-WITH-GAPS', exit: 0, reason: `通过（${parts.join('；')}：${[...skipped, ...unverified].join('、')}）—— **未验证不等于通过**，此处仅表示本周期没有可判定的违约`, failed, crashed, skipped, unverified, missing, errors: [] };
  }
  return { verdict: 'OK', exit: 0, reason: '分层审计全部通过', failed, crashed, skipped, unverified, missing, errors: [] };
}

function selftest() {
  const cases = [];
  const t = (label, runs, expectExit, opts = {}) => {
    const r = judgeAudits(runs, REQUIRED_LAYERS, opts);
    const pass = r.exit === expectExit;
    cases.push({ pass, label, got: r.exit, expectExit, verdict: r.verdict });
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label} → exit=${r.exit}（期望 ${expectExit}）${r.verdict}${pass ? '' : '  ✗ ' + r.reason}`);
    return pass;
  };
  const all = (c) => REQUIRED_LAYERS.map((r) => ({ key: r.key, name: r.name, code: c }));
  const skip = (key) => all(0).map((r) => (r.key === key ? { ...r, code: 4, skipped: true } : r));
  t('[POS] 四层全绿 → 放行', all(0), 0);
  t('[NEG] ④ 判定失败 → 抓（ACTION-NEEDED）', all(0).map((r) => (r.key === 'chainRun' ? { ...r, code: 1 } : r)), 1);
  t('[NEG] ⑤ 工具崩溃(code 3) → 必须与"判定失败"区分', all(0).map((r) => (r.key === 'delivery' ? { ...r, code: 3 } : r)), 3);
  t('[NEG] ⑥ 被信号杀死 → 算工具错误', all(0).map((r) => (r.key === 'claims' ? { ...r, code: null, signal: 'SIGKILL' } : r)), 3);
  t('[NEG] 缺一层（假守卫经典成因）→ 不能算通过', all(0).filter((r) => r.key !== 'claims'), 3);
  t('[NEG] 空输入 → 工具错误', [], 3);
  t('[NEG] 无法解释的退出码 255 → 工具错误', all(0).map((r) => (r.key === 'gates' ? { ...r, code: 255 } : r)), 3);
  // 新增：链条在飞时的"跳过"语义（跳过的层是**未验证**，不能算通过，也不能算失败）
  t('[POS] 链条在飞时 ⑤⑥ 跳过 → 放行，但明确标出"未验证"', skip('delivery').map((r) => (r.key === 'claims' ? { ...r, code: 4, skipped: true } : r)), 0, { chainLive: true });
  t('[NEG] 无链锁却声称"不适用" → 非法跳过（防用跳过错开检查）', skip('delivery'), 3, { chainLive: false });
  // 新增：⑨ 的"证据不足 → 未验证"语义（exit 0 但**点名**，绝不静默通过）
  const unv = (key) => all(0).map((r) => (r.key === key ? { ...r, code: 4, unverified: true } : r));
  {
    const r = judgeAudits(unv('wakeOccurrence'), REQUIRED_LAYERS, { chainLive: false });
    const pass = r.exit === 0 && r.unverified.length === 1 && /wakeOccurrence|⑨/.test(r.reason);
    cases.push({ pass, label: '[POS] ⑨ 证据不足(4+unverified) → 放行但必须点名，不得静默通过', got: r.exit, expectExit: 0, verdict: r.verdict });
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] [POS] ⑨ 证据不足(4+unverified) → 放行但必须点名，不得静默通过 → exit=${r.exit} ${r.verdict}｜reason=${r.reason}`);
  }
  {
    // 防退场闸：code 4 但**未显式声明** unverified → 仍必须算工具错误（否则任何层都能用 4 悄悄退场）
    const r = judgeAudits(all(0).map((x) => (x.key === 'wakeOccurrence' ? { ...x, code: 4 } : x)), REQUIRED_LAYERS, { chainLive: false });
    const pass = r.exit === 3;
    cases.push({ pass, label: '[NEG] code 4 未声明 unverified → 仍算工具错误（防用 4 悄悄退场）', got: r.exit, expectExit: 3, verdict: r.verdict });
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] [NEG] code 4 未声明 unverified → 仍算工具错误（防用 4 悄悄退场） → exit=${r.exit} ${r.verdict}`);
  }
  {
    // 未验证 + 真失败 并存：必须优先报 ACTION-NEEDED，且 reason 里仍点名未验证层（不掩盖）
    const r = judgeAudits(all(0).map((x) => (x.key === 'wakeOccurrence' ? { ...x, code: 4, unverified: true } : x.key === 'chainRun' ? { ...x, code: 1 } : x)), REQUIRED_LAYERS, { chainLive: false });
    const pass = r.exit === 1 && r.unverified.length === 1 && /未验证层/.test(r.reason);
    cases.push({ pass, label: '[NEG] 未验证 + 真失败并存 → 报失败且仍点名未验证层', got: r.exit, expectExit: 1, verdict: r.verdict });
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] [NEG] 未验证 + 真失败并存 → 报失败且仍点名未验证层 → exit=${r.exit} ${r.verdict}`);
  }
  t('[NEG] 链条在飞，但跳过了**不可跳过**的 ④ → 非法跳过', skip('chainRun'), 3, { chainLive: true });
  const ok = cases.filter((c) => c.pass).length;
  console.log(`\nRESULT: ${ok}/${cases.length} ${ok === cases.length ? 'PASS' : 'FAIL'}`);
  return ok === cases.length;
}

if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

const quiet = process.argv.includes('--quiet');
// 仅用于负控：--negctl-fail <layerKey> 把某一层强制成"判定失败"，用来验证
// 「审计失败 → 退出码 1 → 计划任务 Last Result ≠ 0」这条链路真的通（否则失败会静默消失）。
const negIdx = process.argv.indexOf('--negctl-fail');
const negKey = negIdx >= 0 ? process.argv[negIdx + 1] : null;
const lock = chainLive();
if (lock.live) console.log(`ℹ 链条运行中（锁 ${lock.ageMin} 分钟）：⑤⑥ 需要稳定仓库快照，本期跳过（标记为"未验证"，不是通过）。`);
const runs = [];
for (const layer of REQUIRED_LAYERS) {
  // 中途竞态守卫（2026-09-18 实测）：计划任务每 20 分钟触发，锁可能在**本轮审计跑到一半**时出现/消失；
  // 那样前后各层面对的不是同一个世界（结论不可比），故直接作废本轮（exit 3），不给半真半假的判定。
  if (chainLive().live !== lock.live) {
    console.log(`\n[INSTRUMENT-ERROR] 链条锁状态在审计运行中途发生变化（即将跑第 ${runs.length + 1}/${REQUIRED_LAYERS.length} 层：${layer.name}）`);
    console.log('  各层面对的不是同一个世界 → 作废本轮（exit 3）；请在链条空闲时重跑。\n');
    process.exit(3);
  }
  if (lock.live && SKIPPABLE_WHEN_LOCKED.has(layer.key)) {
    runs.push({ key: layer.key, name: layer.name, code: 4, signal: null, tail: '链条运行中 → 未验证（跳过）', skipped: true });
    if (!quiet) console.log(`${'SKIP'.padEnd(16)} ${layer.name}  链条运行中 → 未验证`);
    continue;
  }
  const pr = spawnSync(process.execPath, [path.join(WORK, layer.file), ...layer.args], { cwd: WORK, encoding: 'utf8' });
  const out = `${pr.stdout || ''}\n${pr.stderr || ''}`;
  const tail = out.split('\n').map((s) => s.trim()).filter(Boolean).slice(-1)[0] || '';
  const forced = negKey === layer.key;
  let code = forced ? 1 : pr.status;
  let skipped = false;
  let unverified = false;
  let note = forced ? '[NEGCTL] 人为强制失败（负控）' : tail;
  if (code === 4) {
    if (layer.mayBeUnverified) {
      // 声明式允许"证据不足"：既不判通过也不判失败，但会被点名（judgeAudits 收进 unverified 并写进 reason）。
      unverified = true;
      note = tail || '证据不足 → 未验证（不等于通过）';
    } else if (!lock.live) {
      // 层自称"不适用"：必须真有链锁且在白名单里，否则非法跳过（防"用跳过错开检查"）
      code = 3; note = '层返回 NOT-APPLICABLE，但当前并无链条在飞 → 非法跳过';
    } else if (!SKIPPABLE_WHEN_LOCKED.has(layer.key)) { code = 3; note = '链条运行中，但该层不在可跳过白名单 → 非法跳过'; }
    else { skipped = true; note = '链条运行中 → 未验证（跳过）'; }
  }
  runs.push({ key: layer.key, name: layer.name, code, signal: pr.signal, tail: note, skipped, unverified });
  if (!quiet) {
    const tag = skipped ? 'SKIP' : unverified ? 'UNVERIFIED' : forced ? 'FORCED-FAIL' : code === 0 ? 'PASS' : code === 1 ? 'FAIL' : 'INSTRUMENT-ERROR';
    console.log(`${tag.padEnd(16)} ${layer.name}  ${note}`);
  }
}
if (negKey) console.log(`\n[负控] 已把层「${negKey}」强制为失败——这是验证"失败可见性"的工具，不是真实判定。`);
const verdict = judgeAudits(runs, REQUIRED_LAYERS, { chainLive: lock.live });
// 负控自证：--negctl-fail 指定的层如果**被跳过**，强制失败就没生效 → 整个负控空转，
// 而空转看起来和"通过"一模一样（2026-09-18 实测：链条在飞时 ⑤ 被跳过，负控静默失效）。
// 故此处显式判为工具错误（exit 3），让空转**大声失败**，而不是伪装成一次成功的负控。
if (negKey) {
  const target = runs.find((r) => r.key === negKey);
  if (!target || target.skipped) {
    console.log(`\n[INSTRUMENT-ERROR] 负控空转：--negctl-fail ${negKey} 指定的层${target ? '本轮被跳过（链条运行中）' : '不存在'} → 强制失败未生效。`);
    console.log('  这不是"审计通过"，而是"负控没有真正执行"。请改用不会被跳过的层（如 chainRun），或在链条空闲时再跑。');
    process.exit(3);
  }
}
console.log(`\n=== 分层审计总判定：${verdict.verdict} ===`);
console.log(`  ${verdict.reason}`);

const at = new Date().toISOString();
const md = [
  `# 分层审计（③门禁自审 / ④链条运行 / ⑤交付接地 / ⑥事实复跑）`,
  ``,
  `- 时间：${at}`,
  `- 总判定：**${verdict.verdict}**（exit ${verdict.exit}）`,
  `- 说明：${verdict.reason}`,
  ``,
  `| 层 | 退出码 | 末行 |`,
  `| --- | --- | --- |`,
  ...runs.map((r) => `| ${r.name} | ${r.code === null ? `信号 ${r.signal}` : r.code} | ${r.tail.replace(/\|/g, '\\|')} |`),
  ``,
].join('\n');
fs.writeFileSync(path.join(WORK, negKey ? '_audit-negctl.md' : '_audit-latest.md'), md, 'utf8');
// 负控运行**不写** audit.log：否则日志里会留下一条假的 ACTION-NEEDED，污染"历史上真出过问题吗"这个问题。
try {
  if (!negKey) fs.appendFileSync(path.join(WORK, 'audit.log'), `${at} ${verdict.verdict} ${runs.map((r) => `${r.key}=${r.code}`).join(' ')} ${verdict.reason}\n`, 'utf8');
} catch { /* 日志写不了不影响判定 */ }

if (process.argv.includes('--json')) fs.writeFileSync(path.join(WORK, 'audit-latest.json'), JSON.stringify({ at, verdict, runs }, null, 2), 'utf8');
process.exit(verdict.exit);
