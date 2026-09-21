// 链条装载器：把「装填下一条链条」从"手改 run-chain.cmd"变成"一条命令 + 校验"。
//
// 动机（今天的实测代价）：本轮为装填 v4-a4 / v4-a4b / v5-classify / v6-ab / v6-ab-b / v6-gen / v6-gen-d / v6-gen-s26
// 共手改 run-chain.cmd 约 8 次，每次都依赖"我记得该不该带 --close-after-accept"。
// 手改的两类真实后果：① 误带该开关 → 无 planStepId 的项会被标成 approved-and-closed（L410 缺陷，已修）；
// ② 忘记改 → 调度器继续指向已完成的旧链（空转，看起来"配置好了"实则不干活）。
//
// 用法:
//   node arm-chain.mjs cc-chains/v6-gen-s26.mjs                 # 装填（不带收口开关）
//   node arm-chain.mjs cc-chains/v1-v3.mjs --close-after-accept  # 需要协议收口时显式给出
//   node arm-chain.mjs --show                                    # 只显示当前装填
//   node arm-chain.mjs --selftest                                # 校验器自测
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WORK = 'D:\\dsh relay test';
const CC = 'D:\\cc-tasks';
const POINTER = path.join(CC, 'current-chain.txt');

/** 校验一条链条定义是否可安全装填（纯函数，便于自测）。
 *  strictClose: true 时，「请求收口但存在无 planStepId 的项」视为**错误**而非告警——
 *  理由是这种组合几乎必然是误操作（今天实测：我在测试里就误把带该开关的指针写了进去）。
 *  确有需要时用 --allow-close-without-planstep 显式放行。 */
export function validateChain({ chainFile, chain, specExists, closeAfterAccept, strictClose = true }) {
  const errs = [];
  const warns = [];
  if (!chainFile) errs.push('未给出链条文件');
  if (!chain) return { errs: [...errs, '链条定义无法载入（缺 export const chain）'], warns };
  if (!chain.id) errs.push('链条缺少 id（chainId 是状态隔离的依据，必须有）');
  if (!Array.isArray(chain.items) || chain.items.length === 0) errs.push('链条 items 为空');
  const ids = (chain.items || []).map((it) => it.taskId).filter(Boolean);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (dup.length) errs.push(`taskId 重复（cc-dispatch 会判同名任务已存在并去读旧结果）：${[...new Set(dup)].join(', ')}`);
  for (const it of chain.items || []) {
    if (!it.taskId) errs.push(`项「${it.label || '?'}」缺 taskId`);
    if (!it.spec) errs.push(`项「${it.label || '?'}」缺 spec`);
    else if (!specExists(it.spec)) errs.push(`项「${it.label || '?'}」的 spec 不存在：${it.spec}`);
  }
  // L410 场景：请求收口但存在无 planStepId 的项 → 那些项不会被收口
  const noStep = (chain.items || []).filter((it) => !it.planStepId);
  if (closeAfterAccept && noStep.length) {
    const msg = `传了 --close-after-accept，但有 ${noStep.length} 项没有 planStepId —— 这些项不会被协议收口`
      + `（正确状态是 accepted-awaiting-review；L410 修复已保证不再误标 approved-and-closed）。`
      + `若本意就是要收口，请给这些项补 planStepId 并确认该步骤在权威计划中真实存在；`
      + `若确实要混挂（部分项收口），请显式加 --allow-close-without-planstep。`;
    if (strictClose) errs.push(msg); else warns.push(msg);
  }
  if (!closeAfterAccept && (chain.items || []).some((it) => it.planStepId)) {
    warns.push('链条项带 planStepId 但未传 --close-after-accept —— 将不会自动协议收口（需主 agent 后补）。');
  }
  return { errs, warns };
}

const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  const specExists = (s) => s === 'cc-specs/ok.mjs';
  const cases = [
    ['[POS] 合法链条 → 通过', { chainFile: 'a.mjs', chain: { id: 'c', items: [{ label: 'x', taskId: 't1', spec: 'cc-specs/ok.mjs', planStepId: '1' }] }, specExists, closeAfterAccept: true }, 0, 0],
    ['[NEG] 缺 id → 报错', { chainFile: 'a.mjs', chain: { items: [{ label: 'x', taskId: 't1', spec: 'cc-specs/ok.mjs' }] }, specExists, closeAfterAccept: false }, 1, 0],
    ['[NEG] taskId 重复 → 报错', { chainFile: 'a.mjs', chain: { id: 'c', items: [{ label: 'x', taskId: 't1', spec: 'cc-specs/ok.mjs' }, { label: 'y', taskId: 't1', spec: 'cc-specs/ok.mjs' }] }, specExists, closeAfterAccept: false }, 1, 0],
    ['[NEG] spec 不存在 → 报错', { chainFile: 'a.mjs', chain: { id: 'c', items: [{ label: 'x', taskId: 't1', spec: 'cc-specs/nope.mjs' }] }, specExists, closeAfterAccept: false }, 1, 0],
    ['[NEG] 请求收口但项无 planStepId → strict 下视为**错误**（防误装）', { chainFile: 'a.mjs', chain: { id: 'c', items: [{ label: 'x', taskId: 't1', spec: 'cc-specs/ok.mjs' }] }, specExists, closeAfterAccept: true }, 1, 0],
    ['[POS] 同上但显式放行 → 降级为告警', { chainFile: 'a.mjs', chain: { id: 'c', items: [{ label: 'x', taskId: 't1', spec: 'cc-specs/ok.mjs' }] }, specExists, closeAfterAccept: true, strictClose: false }, 0, 1],
    ['[NEG] 空 items → 报错', { chainFile: 'a.mjs', chain: { id: 'c', items: [] }, specExists, closeAfterAccept: false }, 1, 0],
  ];
  let bad = 0;
  for (const [name, input, expErrs, expWarns] of cases) {
    const r = validateChain(input);
    const ok = r.errs.length === expErrs && r.warns.length === expWarns;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}（errs=${r.errs.length} 期望 ${expErrs}；warns=${r.warns.length} 期望 ${expWarns}）`);
  }
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} 通过`);
  process.exit(bad ? 1 : 0);
}

if (args.includes('--show')) {
  console.log(fs.existsSync(POINTER) ? `  当前装填: ${fs.readFileSync(POINTER, 'utf8').trim()}` : '  (未装填任何链条)');
  process.exit(0);
}

const chainFile = args.find((a) => !a.startsWith('--'));
const closeAfterAccept = args.includes('--close-after-accept');
const minReviewerIdx = args.indexOf('--min-reviewer');
const minReviewer = minReviewerIdx >= 0 ? args[minReviewerIdx + 1] : null;
if (!chainFile) { console.error('用法: node arm-chain.mjs <chainFile> [--close-after-accept] [--min-reviewer X]'); process.exit(2); }

const abs = path.join(WORK, chainFile);
if (!fs.existsSync(abs)) { console.error(`  ✗ 链条文件不存在: ${abs}`); process.exit(2); }
const chk = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
if (chk.status !== 0) { console.error(`  ✗ 链条文件语法错误:\n${chk.stderr}`); process.exit(2); }

const mod = await import(`file:///${abs.replace(/\\/g, '/')}`);
const chain = mod.chain ?? mod.default;
const specExists = (s) => fs.existsSync(path.join(WORK, s.replace(/\//g, '\\')));
const strictClose = !args.includes('--allow-close-without-planstep');
const { errs, warns } = validateChain({ chainFile, chain, specExists, closeAfterAccept, strictClose });

console.log(`  链条 ${chainFile}: id=${chain?.id} items=${chain?.items?.length}`);
for (const w of warns) console.log(`  ⚠ ${w}`);
if (errs.length) { for (const e of errs) console.error(`  ✗ ${e}`); console.error('  → 拒绝装填'); process.exit(1); }

// ---- 装填门禁（2026-09-17 新增）----
// 教训：本轮我为装填链条手改 8 次、其中**三次带着坏规格装填**（语料反引号导致生成物语法错、假锚点、
// 引用不存在的测试文件）。这些本该在**装填前**被拦下，而不是等 cc 派发出去才发现。
// 门禁两项：
//   ① 逐项跑 check-spec（真 import + 锚点/引用/编码校验）；
//   ② 若规格声明了 acceptanceScript（执行接地验收），则该探针**必须自带负控**：
//      `node <probe> --selftest` 必须通过 —— 即它能证明自己**在坏输入上会失败**。
//      没有负控的探针 = 可能永真的门禁，装上等于没装（本会话已出现三次"假守卫"）。
const probeHasSelftest = (probePath) => {
  const r = spawnSync(process.execPath, [probePath, '--selftest'], { cwd: WORK, encoding: 'utf8', timeout: 120000 });
  const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  return { ok: r.status === 0, tail: tail.slice(0, 160) };
};

const gateErrs = [];
let declaredProbes = 0;
for (const it of chain.items || []) {
  const specAbs = path.join(WORK, it.spec.replace(/\//g, '\\'));
  // ① 规格门禁
  const cs = spawnSync(process.execPath, ['check-spec.mjs', it.spec], { cwd: WORK, encoding: 'utf8' });
  const csOut = `${cs.stdout || ''}${cs.stderr || ''}`;
  if (cs.status !== 0 || !/RESULT: OK/.test(csOut)) {
    const why = csOut.split('\n').filter((l) => /FAIL|WARN|RESULT/.test(l)).join(' | ').slice(0, 200);
    gateErrs.push(`项「${it.label}」规格门禁未通过：${why}`);
    continue;
  }
  // ② acceptanceScript 负控
  let task = null;
  try { task = (await import(`file:///${specAbs.replace(/\\/g, '/')}`)).task; } catch { /* 门禁①已捕获语法问题 */ }
  const decl = task && typeof task.acceptanceScript === 'string' ? task.acceptanceScript.trim() : '';
  if (!decl) continue;
  declaredProbes++;
  const cand = [path.join(WORK, decl), path.join('D:\\dsh-web-relay', decl)];
  const probePath = cand.find((p) => fs.existsSync(p));
  if (!probePath) { gateErrs.push(`项「${it.label}」声明了 acceptanceScript 但文件不存在：${decl}`); continue; }
  const sc = probeHasSelftest(probePath);
  if (!sc.ok) gateErrs.push(`项「${it.label}」的验收探针负控未通过（--selftest 应证明它能在坏输入上失败）：${decl}｜${sc.tail}`);
  // ③ 探针必须**落在双方共享的命名空间里**（2026-09-18 实测坑，见 v10 任务）：
  //    runner（WSL，生产路径）与独立验收器都按「仓库根 → 任务目录」解析 acceptanceScript。
  //    探针若只在主 agent 工作区，runner 会报 [acceptance-script][INSTRUMENT] 找不到 → 任务被结算成 failed。
  //    故装填时**自动把探针同步到 <仓库>/probes/ 下**（该目录已在 .gitignore 中，不污染 cc 范围校验），
  //    并断言同步后确实可解析——把这个坑从"每次靠人记得"变成"装填器负责"。
  if (/^[^\s;&|<>()$`"']+\.(mjs|cjs|js)$/i.test(decl)) {
    const base = path.basename(decl.replace(/\\/g, '/'));
    // 以 `_` 开头的是**测试夹具**（如验收接线契约自检临时造的 _badselftest.mjs），不是真实验收仪器：
    // 同步它们只会往仓库里丢垃圾（初版就漏过一次 _badselftest.mjs），故跳过。
    if (base.startsWith('_')) {
      console.log(`  ℹ 探针 ${base} 以 _ 开头（测试夹具）→ 不同步到仓库`);
    } else {
      const dest = path.join('D:\\dsh-web-relay', 'probes', base);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(probePath, dest);
        if (!fs.existsSync(dest)) throw new Error('复制后仍不存在');
        console.log(`  ✓ 探针已同步到仓库共享命名空间：probes/${base}`);
      } catch (e) {
        gateErrs.push(`项「${it.label}」的验收探针无法同步到仓库 probes/（runner 侧会解析不到）：${e.message}`);
      }
    }
  } else {
    console.log(`  ℹ 验收探针为命令形态，不做同步：${decl.slice(0, 80)}`);
  }
}

if (declaredProbes === 0) {
  console.log('  ⚠ 本条链条**没有任何执行接地验收**（无 acceptanceScript）——全部依赖散文 acceptance 条款；');
  console.log('    这类任务的判定只能靠人工/模型阅读，而三轮实验显示该路径无法给出干净判定。');
} else {
  console.log(`  ✓ 执行接地验收：${declaredProbes} 项声明了 acceptanceScript，负控全部通过`);
}
if (gateErrs.length) { for (const e of gateErrs) console.error(`  ✗ ${e}`); console.error('  → 拒绝装填（门禁未通过）'); process.exit(1); }
console.log('  ✓ 规格门禁：所有项 check-spec 通过');

const line = [chainFile, closeAfterAccept ? '--close-after-accept' : '', minReviewer ? `--min-reviewer ${minReviewer}` : ''].filter(Boolean).join(' ');
fs.writeFileSync(POINTER, line + '\n', 'utf8');
console.log(`  ✓ 已装填: ${line}`);
console.log(`  指针文件: ${POINTER}（run-chain.cmd 读取它，故无需再手改 .cmd）`);
