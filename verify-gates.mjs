// ③ 门禁自审 meta-gate：**给门禁装门禁**。
//
// 动机（本会话最贵的教训）：说谎的验证器比没有验证器更糟，而本会话出现过**三次假守卫**——
//   ① 自检契约切片守卫：对源码做变异后**仍然全绿**（假守卫）；
//   ② 通用 parity 脚本：把协议标题写死，换一组 spec 就误报 FAIL；
//   ③ 设计2 探针：只有"坏输入必须失败"一侧，导致**误杀我的正确参考修复**（加上"好输入必须通过"一侧才暴露）。
// 由此确立本 meta-gate 的两条硬规则：
//   规则 A（双侧自检）：每个门禁的自检必须**同时**出现 [NEG] 与 [POS] 标记——
//     只证明"能失败"会误杀正确输入；只证明"能通过"就是永真门禁。
//   规则 B（变异负控）：对以文件为输入的门禁，meta-gate **真的把目标文件改坏**再跑，要求门禁报失败。
//   另：每个门禁必须被 regression-post-restart.mjs 引用（否则它不会被持续执行）。
//
// 用法: node verify-gates.mjs [--json]
//       node verify-gates.mjs --selftest      # meta-gate 自身的两侧自检
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chainLive } from './chain-lock.mjs';

// ⚠ 注意：不能用 new URL(import.meta.url).pathname —— 它给出 URL 编码路径（D:\dsh%20relay%20test），
// 会让所有子进程的 cwd 失效、并把 ENOENT 伪装成"门禁失败"。本文件初版正是这么错的（被自己的输出暴露）。
const WORK = path.dirname(fileURLToPath(import.meta.url));
const REGRESSION = 'regression-post-restart.mjs';

// ---- 门禁清单 ----
// 范围界定：只审**判定产物的门禁**。纯解析器/工具函数的单元自测（如 cc-chain --selftest-quota）不入此清单——
// 它们没有"坏输入必失败"的语义，纳进来只会稀释规则 A。
const GATES = [
  { name: '链条装载器校验', script: 'arm-chain.mjs', args: ['--selftest'] },
  { name: '改动范围判定（含只读任务语义）', script: 'verify-cc-task.mjs', args: ['--selftest-scope'] },
  { name: '验收接线四类契约', script: 'verify-acceptance-wiring.mjs', args: [] },
  { name: '项终态判定（L410）', script: 'cc-chain.mjs', args: ['--selftest-final-status'] },
  { name: '验收探针负控', script: 'probes/accept-smoke.mjs', args: ['--selftest'] },
  { name: '设计2 探针两侧区分力', script: 'probes/selftest-probes.mjs', args: [] },
  { name: '链条运行审计（④）', script: 'verify-chain-run.mjs', args: ['--selftest'] },
  { name: '交付接地（⑤）', script: 'verify-delivery-live.mjs', args: ['--selftest'] },
  { name: '事实复跑门禁（⑥）', script: 'verify-claims.mjs', args: ['--selftest'] },
  { name: '四层审计入口', script: 'audit-all.mjs', args: ['--selftest'] },
  { name: '周期审计入口契约', script: 'verify-run-audit-cmd.mjs', args: ['--selftest'] },
  { name: '需要人介入信号（含"额度耗尽不得登记"负控）', script: 'verify-human-signal.mjs', args: ['--selftest'] },
  { name: '探针双平台可移植性对照（含"一边过一边挂"负控）', script: 'precheck-probes-portable.mjs', args: ['--selftest'] },
  { name: '审计失败升级通路（同源只叫一次 / 销账后复发能再叫 / 自愈自动销账）', script: 'precheck-audit-signal.mjs', args: ['--selftest'] },
  { name: '沉淀校验层（registry 断言 + lessons schema + 条目数不收缩）', script: 'verify-sediment.mjs', args: ['--selftest'] },
  // 2026-09-19 收敛后补登（此前刻意不登记：当时它们如实报 FAIL，登记会让分层审计连续 15 小时刷"需要人"信号）
  { name: '配额判据跨实现一致性（四处实现 + runner 桥接行为）', script: 'verify-quota-patterns.mjs', args: ['--selftest'] },
  { name: '配额判定的调用点穷举（唯一收敛原语 + 白名单）', script: 'verify-quota-single-source.mjs', args: ['--selftest'] },
  { name: '影子沙盒可用性（运行 + 代码自持回退 + 新降级扫描）', script: 'verify-shadow-availability.mjs', args: ['--selftest'] },
  // 2026-09-19 v18 落地后补登：策略层（cap 复用 + 缺失/不可解析 fail-open）
  { name: '额度跳过策略（cap 复用 + 边界/差异/缺失用例）', script: 'probes/quota-skip-policy-accept.mjs', args: [] },
  // 2026-09-20 新增：唤醒通路「实际发生」（⑨）。入清单理由：它有真判定产物（A 存在性 / B 因果性 /
  // B2 历史成功证据 / C 欠条纪律 四条判据 + "未验证≠失败≠工具错误"三分），且自检两侧齐全（13 例）。
  { name: '唤醒通路实际发生（痕迹 + 欠条纪律）', script: 'verify-wake-occurrence.mjs', args: ['--selftest'] },
  // 2026-09-20 补登：**解析器与写方契约**。当天同类格式 bug 连犯两次（readSignals 把扁平记录当 {entry}、
  // readDebtLedger 按 requestedAt 过滤而写方写 at），两次都骗过了"只测判定函数"的自检 → 单独立项钉死契约。
  { name: '唤醒通路：解析器与写方契约（含字段名不符负控）', script: 'verify-wake-occurrence.mjs', args: ['--selftest-parsers'] },
  // 2026-09-20 新增：⑩ 迭代状态机（step list）。入清单理由：真判定产物（J1..J5 + "未验证≠失败≠工具错误"三分），
  // 自检两侧齐全（12 例），且范围复用仓库权威实现（导入失败 → 显式未验证而非静默通过）。
  { name: '迭代状态机（停滞 / 熔断登记 / 终态与声明自洽）', script: 'verify-iteration-state.mjs', args: ['--selftest'] },
  { name: '迭代状态机：解析器与权威实现契约（含 paused 残留步骤负控）', script: 'verify-iteration-state.mjs', args: ['--selftest-parsers'] },
  // 2026-09-20 新增：信号通道**写入守卫**（路径断言 + 主槽形状校验 + "不得绕过权威直写"的调用点穷举）。
  // 入清单理由：它防的正是当天**我造成的**事故（内联 PowerShell 吃掉正则 `$` → 算错路径落回主槽 → 写入 `[]`
  // 销毁了一条未销账信号）；且自检两侧齐全（16 例，含"合成违例必须被抓到"的负控，证明扫描非永真）。
  { name: '信号通道写入守卫（路径断言 + 主槽形状 + 绕过扫描）', script: 'verify-signal-write-guard.mjs', args: ['--selftest'] },
  // 2026-09-20 新增：当前手机链接（从权威启动行现读 + **两侧实测 token 是否仍有效**）。
  // 入清单理由：它防的是"把可能已失效的凭证贴给人"——token 每次宿主重启轮换，只贴日志值＝写死旧值陷阱。
  { name: '当前手机链接（现读 + 实测有效）', script: 'current-link.mjs', args: ['--selftest'] },
  // 2026-09-20 新增：**乐观检测**（覆写前发现"工作树已不是我记得的样子"）。
  // 入清单理由：单写者锁只覆盖 信号/交付/重启，普通文件编辑与 git commit 没有锁；本工具补的是
  // "世界变了就停下重读"这一半，且有端到端"合成改动必须被抓到"的负控（证明非永真）。
  { name: '乐观检测（工作树指纹 record/check）', script: 'optimistic-guard.mjs', args: ['--selftest'] },
  // 2026-09-20 新增：乐观检测的**接线**（--guard 真的在"任何落盘之前"拦住）。
  // 入清单理由：只证明工具本身对没用——必须证明**它被接在**交付/重启的落盘之前（否则"忘记 check"这个洞还在）。
  { name: '乐观检测接线（--guard 落盘前拦截 + 重启顺序断言）', script: 'verify-guard-wiring.mjs', args: [] },
  // 2026-09-21 新增：**活工具清单**校验（清单 vs 权威引用点穷举）。
  // 入清单理由：工作区 254 个 .mjs 此前"没人知道哪些是活的"；本门禁让"新工具被引用却没登记"当场失败。
  { name: '活工具清单（清单 vs 权威引用点穷举）', script: 'verify-tool-inventory.mjs', args: ['--selftest'] },
  // 2026-09-20 新增：**事件驱动路径的行为验证**（熔断登记 / 版间门落盘）。
  // 用生产代码路径合成真实事件（临时 base，零污染）；这是唯一能验"事件路径真的会留下产物"的手段。
  { name: '事件驱动路径行为验证（熔断登记 + 版间门落盘）', script: 'verify-autoir-events.mjs', args: [] },
  // 2026-09-20 新增：**接线断言（静态兜底）**。行为验证只证明"曾经对过"，接线断言防"之后被重构摘掉"。
  { name: '自动迭代事件路径接线（静态兜底，含变异空转自证）', script: 'verify-autoir-wiring.mjs', args: ['--selftest'] },
  // 2026-09-20 新增：单写者锁（用户刷新造出两个会话并发写同一工作区，实测曾销毁一条信号记录）。
  { name: '单写者锁（锁语义两侧 + 三个破坏性写入者接线，含变异自证）', script: 'verify-single-writer.mjs', args: ['--selftest'] },
];

// ---- 变异负控：改坏目标文件，要求指定门禁报失败 ----
const MUTATIONS = [
  {
    name: '调度器入口（注入非 ASCII 字节）',
    target: 'D:\\cc-tasks\\run-chain.cmd',
    apply: (txt) => txt.replace('@echo off', '@echo off\nrem 中文注释注入'),
    gate: { script: 'verify-run-chain-cmd.mjs', args: ['--path', '__TARGET__'] },
  },
  {
    name: '规格锚点（改成不存在的 pattern）',
    tempIn: 'cc-specs/genexp2-s01.mjs',
    apply: (txt) => txt.replace(/pattern: '[^']+'/, "pattern: '__definitely_not_in_repo__'"),
    gate: { script: 'check-spec.mjs', args: ['__TARGET__'] },
  },
  {
    // 周期审计入口若"吞掉退出码"，审计失败在计划任务里就永远看不见（静默失败的假守卫）
    name: '周期审计入口（把退出码吞成 0）',
    tempIn: 'D:\\cc-tasks\\run-audit.cmd',
    apply: (txt) => txt.replace(/exit\s+\/b\s+%ERRORLEVEL%/i, 'exit /b 0'),
    gate: { script: 'verify-run-audit-cmd.mjs', args: ['--path', '__TARGET__'] },
  },
];

// 允许在"链条运行中"跳过的门禁（它需要独占链条状态 / 稳定仓库快照）。
// 清单是白名单：不在里面的一律不许跳过，避免用"跳过"把门禁悄悄做空。
const SKIPPABLE_GATES = new Set(['verify-acceptance-wiring.mjs']);

const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, ok: cond, detail }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ' — ' + detail}`); };

/** 纯函数：判定一份自检输出是否满足双侧规矩（供 --selftest 直接测，不经子进程）。 */
export function auditSelftestOutput({ exitCode, output, allowNoNeg = false }) {
  const reasons = [];
  if (exitCode !== 0) reasons.push(`自检退出码非 0（${exitCode}）`);
  const neg = ((output || '').match(/\[NEG\]/g) || []).length;
  const pos = ((output || '').match(/\[POS\]/g) || []).length;
  if (pos < 1) reasons.push('缺少 [POS] 正控（只证明"能失败"会误杀正确输入）');
  if (neg < 1) reasons.push('缺少 [NEG] 负控（没有负控 → 可能是永真门禁）');
  return { ok: reasons.length === 0, reasons, neg, pos };
}

if (process.argv.includes('--selftest')) {
  // meta-gate 自身的两侧自检：它必须能**放过**合法输出、**拦下**两类坏输出
  const good = auditSelftestOutput({ exitCode: 0, output: '[POS] x\n[NEG] y\n' });
  const noNeg = auditSelftestOutput({ exitCode: 0, output: '[POS] x\n' });
  const noPos = auditSelftestOutput({ exitCode: 0, output: '[NEG] y\n' });
  const badExit = auditSelftestOutput({ exitCode: 1, output: '[POS] x\n[NEG] y\n' });
  const cases = [
    ['[POS] 合法输出（有 POS 有 NEG、退出 0）→ 放行', good.ok === true],
    ['[NEG] 缺 [NEG] 标记 → 必须拦下（永真门禁）', noNeg.ok === false],
    ['[NEG] 缺 [POS] 标记 → 必须拦下（会误杀正确输入）', noPos.ok === false],
    ['[NEG] 自检退出码非 0 → 必须拦下', badExit.ok === false],
  ];
  let bad = 0;
  for (const [n, cond] of cases) { if (!cond) bad++; console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${n}`); }
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

console.log('=== ③ 门禁自审（规则 A：双侧自检）===');
const SKIPPED = [];
for (const g of GATES) {
  const r = spawnSync(process.execPath, [g.script, ...g.args], { cwd: WORK, encoding: 'utf8', timeout: 600000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // exit 4 = NOT-APPLICABLE（该门禁此刻需要独占链条状态，而链条正在飞）。
  // 只在**确有链锁**时允许跳过；否则就是"非法跳过"，必须拦下（防止用跳过把门禁做空）。
  if (r.status === 4) {
    const lk = chainLive();
    if (!lk.live) { ok(g.name, false, '门禁返回 exit 4（NOT-APPLICABLE）但当前并无链条在飞 → 非法跳过'); continue; }
    if (!SKIPPABLE_GATES.has(g.script)) { ok(g.name, false, `链条运行中，但该门禁不在可跳过清单里 → 非法跳过（${g.script}）`); continue; }
    SKIPPED.push(g.name);
    console.log(`  [SKIP] ${g.name} — 链条运行中（锁 ${lk.ageMin} 分钟），本项**未验证**（不等于通过）`);
    continue;
  }
  const v = auditSelftestOutput({ exitCode: r.status, output: out, allowNoNeg: !!g.allowNoNeg });
  ok(g.name, v.ok, `NEG=${v.neg} POS=${v.pos}${v.reasons.length ? ' ｜ ' + v.reasons.join('；') : ''}`);
}
if (SKIPPED.length === GATES.length) ok('至少有一项门禁被真正执行（不能全跳过）', false, '全部门禁都被跳过 → 等于没有自审');

console.log('\n=== 规则 B：变异负控（真把目标改坏，要求门禁报失败）===');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gatemut-'));
for (const m of MUTATIONS) {
  const src = m.tempIn ? path.resolve(WORK, m.tempIn.replace(/\//g, '\\')) : m.target;
  if (!fs.existsSync(src)) { ok(m.name, false, `目标不存在：${src}`); continue; }
  const ext = path.extname(src);
  const tmpFile = path.join(TMP, `mutated${ext}`);
  const original = fs.readFileSync(src, 'utf8');
  const mutated = m.apply(original);
  // ★ 负控必须自证"我真的改坏了"。若 apply() 是空操作（正则没命中、目标文件已变），
  //   那么"门禁没报失败"只说明负控是空的，不说明门禁有问题——本文件初版正是这样误判过一次
  //   （拿一份没有 anchors 的老规格去改锚点，变异为空转）。故此处单列为 FAIL。
  if (mutated === original) {
    ok(m.name, false, '变异无效：apply() 未改变内容 → 该负控空转，等同于假门禁（先修负控，再谈门禁）');
    continue;
  }
  fs.writeFileSync(tmpFile, mutated, 'utf8');
  const args = m.gate.args.map((a) => (a === '__TARGET__' ? tmpFile : a));
  const r = spawnSync(process.execPath, [m.gate.script, ...args], { cwd: WORK, encoding: 'utf8', timeout: 300000 });
  ok(m.name, r.status !== 0, `门禁退出码=${r.status}（要求非 0：改坏后必须报失败）`);
}
fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n=== 规则 C：每个门禁必须被回归套件引用（否则不会持续执行）===');
const reg = fs.readFileSync(path.join(WORK, REGRESSION), 'utf8');
for (const g of GATES) {
  const base = path.basename(g.script);
  const referenced = reg.includes(`'${g.script}'`) || reg.includes(`'${base}'`);
  if (!referenced) console.log(`  [WARN] ${g.name}（${g.script}）未被 ${REGRESSION} 引用`);
  else console.log(`  [PASS] ${g.name} 已被回归套件引用`);
}

const failed = results.filter((r) => !r.ok);
// 跳过项必须**出现在结论行里**：否则 "N 项通过" 会被读成"N 项都被验证过"，
// 而实际有一项因链条在飞根本没跑（未验证 ≠ 通过）。
const skipNote = SKIPPED.length ? `，${SKIPPED.length} 项因链条运行中跳过（未验证：${SKIPPED.join('、')}）` : '';
console.log(`\n  RESULT: ${failed.length ? 'FAIL（' + failed.length + ' 项）' : 'PASS（' + results.length + ' 项门禁自审通过' + skipNote + '）'}`);
if (process.argv.includes('--json')) {
  fs.writeFileSync(path.join(WORK, '..', 'cc-tasks', 'gates-audit.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2), 'utf8');
}
process.exit(failed.length ? 1 : 0);
