// 重启后工具链全量回归：逐个跑核心工具并判定，确认 relay 路由契约未漂移
// 用法: node regression-post-restart.mjs
//
// 2026-09-15 修复「假失败」：原套件把**计划完成态**硬编码成期望——计划 7/7 全部 approved、
// expr 已 finalized 之后，5 项立刻变成假失败（收口 step2 已 approved 却仍期望「拒绝收口」、
// finalAcceptance 已声明却仍期望「BLOCKED」、/steps/declare 已落地却仍期望「未实现」、
// v1-2 已产出却仍期望「无产物」、v1-1 提交滑出 20 条窗口导致已 ACCEPT 的任务被判 REJECT）。
// 后果：一个专门用来发现漂移的套件若长期报假失败，运维/自动化会去追不存在的缺陷——
// 这正是它存在意义（L-069 同类：诊断说谎比不诊断更糟）。现改为**先读权威状态再推导期望**，
// 使套件随计划推进仍保持有效；负路径覆盖改由不复存在/不受状态影响的对象承担。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { chainLive, waitForChainIdle } from './chain-lock.mjs';

const WORK = 'D:\\dsh relay test';
const STEPS_FILE = 'D:\\dsh relay test\\web-relay\\experiments\\expr-2026-09-13_17-36-07.steps.json';
const DECLARE_URL = 'http://127.0.0.1:3080/dsh-web-relay/steps/declare';

// ---- 独占守卫（2026-09-18 实测事故）----
// cc 正在写仓库时跑本套件，会同时踩三处：① 链条自测见锁即"本次跳过"→ 关键字缺失被读成失败；
// ② verify-cc-task 见工作区脏（正是 cc 在改的文件）→ 把**正在执行**的任务判成 REJECT；
// ③ 验收接线契约会改写 current-chain.txt / chain-state.json → 直接干扰在飞的链条。
// 结论：本套件需要**独占**仓库与链条状态；不满足时给工具错误(exit 3)，而不是给一个无意义的判定——
// 与"诊断说谎比不诊断更糟"同一条原则（L-069）。
const CHAIN_LOCK = 'D:\\cc-tasks\\chain.lock';
const startIdle = waitForChainIdle({ maxWaitMs: 90000 });
if (!startIdle.idle) {
  const age = (() => { try { return ((Date.now() - fs.statSync(CHAIN_LOCK).mtimeMs) / 60000).toFixed(1); } catch { return '?'; } })();
  console.log(`\n[INSTRUMENT-ERROR] 链条运行中（锁 ${age} 分钟前创建，${CHAIN_LOCK}）`);
  console.log(`  ${startIdle.reason || ''}（等待 ${(startIdle.waitedMs / 1000).toFixed(1)}s）`);
  console.log('  本套件会读仓库状态、并且会改写链条指针/状态文件 → 与在飞的链条互踩。');
  console.log('  已拒绝执行（exit 3）：这不是"回归失败"，而是"此刻的回归结论无意义"。');
  console.log('  处理：等这次链条项结束（锁释放）后重跑；或临时把该 cc 任务停掉。\n');
  process.exit(3);
}

// ---- 权威状态（用于推导期望，而非硬编码）----
const st = (() => {
  try { return JSON.parse(fs.readFileSync(STEPS_FILE, 'utf8')); } catch { return null; }
})();
const steps = (st && Array.isArray(st.steps)) ? st.steps : [];
const stepStatus = (id) => { const s = steps.find((x) => String(x.id) === String(id)); return s ? s.status : '(缺失)'; };
const allApproved = steps.length > 0 && steps.every((s) => s.status === 'approved');
const finalAcceptanceDeclared = !!(st && st.finalAcceptance);
const finalized = !!(st && st.finalized);

// /steps/declare 端点是否存在（400/200 都算「端点存在」，连接失败才算未实现）
let declareHttp = null;
try {
  const r = await fetch(DECLARE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  declareHttp = r.status;
} catch { declareHttp = null; }

console.log(`  [STATE] step2=${stepStatus(2)} | step1=${stepStatus(1)} | 全 approved=${allApproved} | finalAcceptance=${finalAcceptanceDeclared ? '已声明' : 'null'} | finalized=${finalized}`);
console.log(`  [STATE] /steps/declare 探测 HTTP=${declareHttp === null ? '(不可达)' : declareHttp} → 端点${declareHttp === null ? '不存在' : '存在'}`);

// ---- 用例（期望由上面的状态推导）----
const cases = [
  { name: 'cc-doctor 体检', args: ['cc-doctor.mjs'], expectExit: 0, mustInclude: ['RESULT'] },
  // 归属窗口已放宽（DSH_RELAY_SCOPE_LOG_N 默认 500），v1-1 的提交仍在窗口内 → 应 ACCEPT
  { name: 'verify-cc-task(v1-1 已提交)', args: ['verify-cc-task.mjs', 'v1-1-breakthrough-gate'], expectExit: 0, mustInclude: ['RESULT: ACCEPT'] },
  // 负路径：用一个**不存在**的任务 id，与计划是否完成无关，永久有效。
  // 实测契约：任务目录不存在属**前置条件错误** → exit 2 + 「任务目录不存在」（不是 exit 1/REJECT）。
  { name: 'verify-cc-task(不存在任务→拒绝)', args: ['verify-cc-task.mjs', '__no-such-task-regression__'], expectExit: 2, mustInclude: ['任务目录不存在'] },
  { name: '规格模板扫描', args: ['scan-spec-templates.mjs'], expectExit: 0, mustInclude: ['需要修复的规格数 = 0'] },
  // stateInvariant：诊断模式**不得改写 chain-state 的归属**。2026-09-16 实测缺口——原先的「无副作用」
  // 只查了退出码与输出关键字，没查状态文件；结果 --probe-only / --selftest-quota（默认落到 v1-v3）
  // 会在探针成功后 save()，把活跃链条的 chainId 写成 v1-v3，导致调度器下次触发误判「换链条」
  // → 重开状态 → **把已完成的项重新派发一遍**。故此处加状态不变式。
  { name: '链条探针模式(无副作用)', args: ['cc-chain.mjs', '--probe-only'], expectExit: 0, mustInclude: ['quota='], stateInvariant: true },
  { name: '规格门控(v1-1)', args: ['check-spec.mjs', 'cc-specs/v1-1.mjs'], expectExit: 0, mustInclude: ['RESULT: OK'] },
  { name: 'clearStaleAttempt 自测', args: ['cc-chain.mjs', '--selftest-clear'], expectExit: 0, mustInclude: ['RESULT: PASS'] },
  { name: '额度解析自测', args: ['cc-chain.mjs', '--selftest-quota'], expectExit: 0, mustInclude: ['RESULT: PASS'], stateInvariant: true },
  { name: '协议门自测(V2-1 前需 step3)', args: ['cc-chain.mjs', '--selftest-gate'], expectExit: 0, mustInclude: ['RESULT: PASS', '门判定'] },
  { name: '审核映射自测(含 claude-code)', args: ['protocol-close-step.mjs', '--selftest-reviewer'], expectExit: 0, mustInclude: ['RESULT: PASS', 'claude-code'] },
  // 2026-09-16 新增三条：把本轮真实犯过的错变成永久护栏
  // ① 调度器入口必须可被 cmd.exe 解析（事故：UTF-8 中文注释 → exit=255、伪命令；入口坏了会导致自动化静默失效）
  { name: '调度器入口校验(ASCII/指针化)', args: ['verify-run-chain-cmd.mjs'], expectExit: 0, mustInclude: ['RESULT: PASS'] },
  // ② 链条装载器校验器（防误装：缺 id / taskId 重复 / spec 缺失 / 收口开关误用）
  { name: '链条装载器校验自测', args: ['arm-chain.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 7/7'] },
  // ③ L410 修复（无 planStepId 时不得声称已闭环）
  { name: '项终态判定自测(L410)', args: ['cc-chain.mjs', '--selftest-final-status'], expectExit: 0, mustInclude: ['RESULT: 5/5'] },
  // ④ 执行接地验收的接线契约（探针通过/缺失/判不合格/负控失败 四类 + 正向装填）
  { name: '验收接线四类契约', args: ['verify-acceptance-wiring.mjs'], expectExit: 0, mustInclude: ['RESULT: PASS'] },
  // ⑤ 验收探针自身的负控（证明它在坏输入上会失败，不是永真门禁）
  { name: '验收探针负控自检', args: ['probes/accept-smoke.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: PASS'] },
  // ⑥ 设计2 探针的两侧区分力（bug 版必失败 + 修复版必通过）
  { name: '设计2 探针两侧区分力', args: ['probes/selftest-probes.mjs'], expectExit: 0, mustInclude: ['RESULT: PASS'] },
  // ⑦ 门禁自审 meta-gate 自身的两侧自检（它必须能拦下缺 POS/NEG 的输出与坏退出码）
  { name: '门禁自审自检(meta)', args: ['verify-gates.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 8/8 PASS'] },
  // ⑧ 链条运行审计（状态不变量 + 重派循环签名识别）
  { name: '链条运行审计自检', args: ['verify-chain-run.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 12/12'] },
  // ⑨ 交付接地（宿主是否真的加载了仓库代码；此处只跑其自检，实跑按需）
  { name: '交付接地自检', args: ['verify-delivery-live.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 11/11'] },
  // ⑩ 事实复跑门禁（报告/注释里的数字可复跑；此处只跑其自检，实跑按需）
  { name: '事实复跑门禁自检', args: ['verify-claims.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 8/8'] },
  // ⑪ 四层审计统一入口（③④⑤⑥ 必须能被一条命令跑完，且"层级缺失/工具崩溃"要与"判定失败"区分）
  { name: '分层审计入口自检', args: ['audit-all.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 15/15 PASS'] },
  // ⑫ 周期审计入口 run-audit.cmd 的静态契约（ASCII/**可传递地**真的跑到审计/退出码必须透传，不得吞成 0）
  { name: '周期审计入口契约', args: ['verify-run-audit-cmd.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 19/19'] },
  // ⑬ 「需要人介入」信号（会触发唤醒主 agent，故必须证明"不该唤醒的不唤醒" + 同源只叫一次 + 队列不丢告警）
  { name: '需要人介入信号自检', args: ['verify-human-signal.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 26/26'] },
  // ⑭ 探针双平台对照（生产路径在 WSL 跑声明的探针，主 agent 在 Windows 跑同一份 —— 判据必须一致）
  { name: '探针双平台对照自检', args: ['precheck-probes-portable.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 5/5'] },
  // ⑮ 审计失败的升级通路（否则审计喊再多次也没人会被叫醒；同源只叫一次，销账后复发能再叫）
  { name: '审计失败升级通路自检', args: ['precheck-audit-signal.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 8/8'] },
  // ⑯ 沉淀校验层（registry 机验 + lessons schema + 条目数不收缩）——"沉淀"必须和代码一样有回归门
  { name: '沉淀校验层自检', args: ['verify-sediment.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 12/12'] },
  // ⑰⑱⑲ 2026-09-19 收敛后补登：配额跨实现一致 / 调用点穷举 / 影子沙盒可用性
  { name: '配额跨实现一致性自检', args: ['verify-quota-patterns.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 5/5'] },
  { name: '配额调用点穷举自检', args: ['verify-quota-single-source.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 11/11'] },
  { name: '影子沙盒可用性自检', args: ['verify-shadow-availability.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 8/8'] },
  // ⑳ v18 的策略层：cap 复用 + 边界/差异/缺失（实跑，不是自检）
  { name: '额度跳过策略（cap 复用）', args: ['probes/quota-skip-policy-accept.mjs'], expectExit: 0, mustInclude: ['RESULT: 10/10'] },
  // ㉑ 2026-09-20 新增：⑨ 唤醒通路「实际发生」（A 存在性 / B 因果性 / B2 历史成功证据 / C 欠条纪律 / D 清单不得提前消费）
  { name: '唤醒通路实际发生自检', args: ['verify-wake-occurrence.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 19/19'] },
  // ㉒ 解析器与写方契约（当天同类格式 bug 连犯两次：readSignals 扁平记录 / readDebtLedger 字段名 → 钉死契约）
  { name: '唤醒通路解析器契约自检', args: ['verify-wake-occurrence.mjs', '--selftest-parsers'], expectExit: 0, mustInclude: ['RESULT: 5/5'] },
  // ㉓㉔ 2026-09-20 新增：⑩ 迭代状态机（唯一没有审计层的任务载体）
  { name: '迭代状态机自检', args: ['verify-iteration-state.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 39/39 PASS'] },
  { name: '迭代状态机解析器契约自检', args: ['verify-iteration-state.mjs', '--selftest-parsers'], expectExit: 0, mustInclude: ['RESULT: 13/13'] },
  // ㉕ 2026-09-20 新增：**事件驱动路径的行为验证**（熔断登记 / 版间门落盘）。
  // 用生产代码路径合成真实事件（临时 base，零污染）；信号侧带"只清自己条目"护栏，故可进回归套件常驻覆盖。
  { name: '事件驱动路径行为验证（熔断登记 + 版间门落盘 + 队列收敛·零副作用）', args: ['verify-autoir-events.mjs'], expectExit: 0, mustInclude: ['RESULT: 14/14 PASS'] },
  // ㉖ 接线断言（静态兜底）——防"行为验证过的接线被后续重构摘掉"
  { name: '自动迭代接线断言自检', args: ['verify-autoir-wiring.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 7/7'] },
  // ㉗ 演练模式（插件 dryRun）：零副作用的行为验证（--selftest 含"真写一次"的负控，故只在回归里跑，不进周期审计）
  { name: '事件路径演练（dryRun 零副作用）自检', args: ['verify-autoir-drill.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 5/5'] },
  // ㉘ 单写者锁（refresh 造出两个会话并发写工作区的机制性修复）
  { name: '单写者锁自检', args: ['verify-single-writer.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 13/13'] },
  // ㉙ 信号通道写入守卫（路径断言 + 主槽形状 + 绕过扫描）——防"算错路径落回主槽把信号写成 []"
  { name: '信号通道写入守卫自检', args: ['verify-signal-write-guard.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 22/22'] },
  // ㉚ 当前手机链接：解析与"token 是否仍有效"的两侧判定（不打印未经验证的凭证）
  { name: '当前手机链接自检', args: ['current-link.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 8/8'] },
  // ㉚b 手机链路端到端：鉴权语义 + SPA 外壳 + 静态资源字节一致性。
  // 运行器只认 expectExit/mustInclude/stateInvariant（无退出码白名单）；瞬时网络错误会以 exit=4 出现，
  // 此时本项 FAIL 属预期（未验证不得读成通过），重跑即可恢复。
  { name: '手机链路判据自检(正控+负控)', args: ['verify-mobile-link.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 16/16'] },
  // 手机链路端到端**实测**（真实网络）：瞬时错误会以 exit=4 出现，此时 FAIL 属预期，重跑恢复。
  { name: '手机链路端到端实测', args: ['verify-mobile-link.mjs'], expectExit: 0, mustInclude: ['RESULT: 7/7'] },
  // ㉛ 乐观检测：工作树指纹 record/check（覆写前发现"世界变了"）
  { name: '乐观检测自检', args: ['optimistic-guard.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 7/7'] },
  // ㉜ 乐观检测接线：--guard 在落盘前拦截（含"无记录→4"与"已变动→1"两条负控 + 重启顺序断言）
  { name: '乐观检测接线验证', args: ['verify-guard-wiring.mjs'], expectExit: 0, mustInclude: ['RESULT: 7/7'] },
  // ㉝ 活工具清单：清单 vs 权威引用点穷举（防"新工具加了没登记"）
  { name: '活工具清单自检', args: ['verify-tool-inventory.mjs', '--selftest'], expectExit: 0, mustInclude: ['RESULT: 5/5'] },
];

// 收口器：已 approved → noop（exit 0）；未批准 → 拒绝收口（exit 3）。按真实状态取期望。
const closeArgs = (id) => ['protocol-close-step.mjs', String(id), '--dry-run'];
for (const id of [1, 2]) {
  const approved = stepStatus(id) === 'approved';
  cases.splice(2, 0, {
    name: `收口器 step${id}(${approved ? '已 approved → noop' : '未落地 → 拒绝'})`,
    args: closeArgs(id),
    expectExit: approved ? 0 : 3,
    mustInclude: approved ? ['无需操作'] : ['拒绝收口'],
  });
}

// 版间门：完成态 → PASS；未完成 → BLOCKED。按真实状态取期望。
{
  const gatePass = allApproved && finalAcceptanceDeclared;
  cases.splice(4, 0, {
    name: `V1 验收+版间门(${gatePass ? '完成态 → PASS' : '未完成 → BLOCKED'})`,
    args: ['verify-v1-acceptance.mjs'],
    expectExit: 0,
    mustInclude: ['V1 版间门', gatePass ? 'PASS' : 'BLOCKED'],
  });
}

// 声明器探测：端点已落地 → exit 0；未落地 → exit 4。
cases.splice(5, 0, {
  name: `声明器探测(${declareHttp === null ? '未落地 → 拒绝' : '已落地 → 通过'})`,
  args: ['declare-autoiter.mjs', '--probe'],
  expectExit: declareHttp === null ? 4 : 0,
  mustInclude: declareHttp === null ? ['未实现'] : ['端点存在'],
});

// PRECONDITION：verify-cc-task 以**工作树**为准判「改动可归属」，工作树脏时会把无关文件判为越界。
// 2026-09-15 实测复现：造一个未提交文件 .dirty-probe → [FAIL] 越界 → REJECT(exit 1)；移除后恢复 ACCEPT。
// 该现象曾导致一次 9/11 假失败（真因=同一条命令里先改了 OPS 文档未提交再跑套件，并非代码回归）。
const dirtyNow = String(spawnSync('git', ['-C', 'D:\\dsh-web-relay', 'status', '--porcelain'], { encoding: 'utf8' }).stdout || '').trim();
if (dirtyNow) {
  console.log(`  [PRECONDITION] 仓库工作树非干净（${dirtyNow.split('\n').filter(Boolean).length} 处）——verify-cc-task 用例预期会失败；请先提交或 stash 再跑本套件。`);
}

let pass = 0; const fails = [];
let caseNo = 0;
// 状态不变式：只取「归属」相关字段（chainId/index/completedAt/项名），不比对整文件（探针会合法地写 quotaResetsAt）
const CHAIN_STATE = 'D:\\cc-tasks\\chain-state.json';
const stateSig = () => {
  try {
    const s = JSON.parse(fs.readFileSync(CHAIN_STATE, 'utf8'));
    return JSON.stringify({ chainId: s.chainId, index: s.index, completedAt: s.completedAt, items: Object.keys(s.items || {}).sort() });
  } catch (e) { return `(读不到: ${e.code || e.message})`; }
};
for (const c of cases) {
  caseNo++;
  // 中途竞态守卫（2026-09-18 实测）：计划任务每 20 分钟触发，链条锁可能在**本套件跑到一半时**才出现。
  // 初版只在启动时查一次锁 → 实测得到 19/26 的**混合判定**（前半段真跑、后半段"已有运行中的链条，本次跳过"
  // 被读成关键字缺失=失败）。跨锁转变产生的结论不可信，故一旦发现锁在运行中途出现，**作废整轮**(exit 3)，
  // 而不是给一个半真半假的判定（与"诊断说谎比不诊断更糟"同一条原则）。
  if (chainLive()) {
    // 先给它一个"自证是不是瞬时锁"的机会：计划任务每 20 分钟取一次锁（即使无事可做），
    // 那种 <1s 的瞬时锁不该作废整轮；但真在干活的链条（锁已存在 ≥1 分钟）必须作废。
    const w = waitForChainIdle({ maxWaitMs: 60000 });
    if (!w.idle) {
      console.log(`\n[INSTRUMENT-ERROR] 链条锁在回归运行**中途**出现（第 ${caseNo}/${cases.length} 项：${c.name}）`);
      console.log(`  ${w.reason}（锁 ${w.ageMin} 分钟，等待 ${(w.waitedMs / 1000).toFixed(1)}s 仍未释放）`);
      console.log('  前半段结论与后半段不可比（后半段会因"已有运行中的链条"而改变行为）。');
      console.log('  已作废本轮（exit 3）：请在链条空闲时重跑。\n');
      process.exit(3);
    }
    console.log(`  [INFO] 第 ${caseNo} 项前遇到瞬时链锁（${(w.waitedMs / 1000).toFixed(1)}s 内自行释放）→ 继续`);
  }
  const sigBefore = c.stateInvariant ? stateSig() : null;
  const r = spawnSync(process.execPath, c.args, { cwd: WORK, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const exitOk = r.status === c.expectExit;
  const textOk = (c.mustInclude || []).every((k) => out.includes(k));
  const invariantOk = !c.stateInvariant || stateSig() === sigBefore;
  const ok = exitOk && textOk && invariantOk;
  if (ok) pass++; else fails.push({ name: c.name, expectExit: c.expectExit, gotExit: r.status, missing: (c.mustInclude || []).filter((k) => !out.includes(k)), invariantOk });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${c.name.padEnd(38)} exit=${r.status}（期望 ${c.expectExit}）${textOk ? '' : ' 缺关键字: ' + (c.mustInclude || []).filter((k) => !out.includes(k)).join(',')}${c.stateInvariant ? ` 状态不变=${invariantOk}` : ''}`);
  if (c.stateInvariant && !invariantOk) {
    console.log(`        | 归属被改写！前=${sigBefore}`);
    console.log(`        |              后=${stateSig()}`);
  }
  // 失败时打印输出尾部，便于定位瞬时失败（此前一次 9/11 因无诊断输出而无法归因）
  if (!ok) {
    const tail = out.split('\n').filter((l) => l.trim()).slice(-6);
    for (const l of tail) console.log('        | ' + l.trim().slice(0, 160));
  }
}
console.log(`\n  RESULT: ${pass}/${cases.length} 通过${fails.length ? '；失败项需人工查看' : '（重启后工具链与路由契约无漂移）'}`);
process.exit(fails.length ? 1 : 0);
