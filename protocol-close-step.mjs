// 通用协议收口器 v2：读权威状态 → 按状态机决定动作 → start/complete(带证据)/auto-review → 输出裁决（可机器消费）
// 用法: node protocol-close-step.mjs <stepId> [--dry-run] [--json] [--channel cc|web-gemini|gemini-free]
//                                [--task <taskId>] [--sha <commit>] [--min-reviewer external|web-gemini|cc|swarm|dialog]
// 退出码: 0=已 approved（或 dry-run 通过）| 1=审核未通过(rejected/仍 review) | 2=入参/端点错误 | 3=拒绝收口（未落地）| 5=审核通道强度不足
// 设计要点：
//   ① 先读 /steps 权威状态，按 pending→executing→review→approved 决定动作；已 approved 直接退出 0
//      （本会话曾收到乱序/陈旧唤醒要求重做已批准步骤，状态机前置判断可根除此类错误）；
//   ② 证据自动组装：链条定义取 taskId/commit；verify-cc-task 五项；git show --stat；任务 result.json；
//   ③ 只做协议动作，不代批：裁决一律由 /steps/auto-review 的独立通道给出（high+review:true 禁止自审自批）；
//   ④ --min-reviewer 用于无人值守：若最终 reviewedBy 弱于要求（如只拿到 dialog 兜底），退出码 5 让调用方停下等人。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadChainDefPath } from './chain-def-resolve.mjs';

const BASE = 'http://127.0.0.1:3080/dsh-web-relay';
const REPO = 'D:\\dsh-web-relay';
const WORK = 'D:\\dsh relay test';
const exprId = 'expr-2026-09-13_17-36-07';
const ws = WORK;
const sessionId = process.env.DSH_SESSION_ID || '';

// 强度表必须覆盖 relay **实际写入**的 reviewedBy 取值（查证来源：lib/index.js L3377/L3388/L3406/L3418/L3431/L3514/L3528/L2948）：
//   external（外部 API；注意 web-gemini 成功时也记 'external'，L3406）
//   claude-code（cc 通道审计的记法，L3514：reviewer==='cc' → 'claude-code'——**不是** 'cc'）
//   dialog / manual / mainagent（mainagent 出现于 review:false 的步骤由主 agent 直接置 approved）
// 未覆盖的值一律按 0（强度不足 → 停止等人），宁可误停不可误放。
const STRENGTH = { external: 4, swarm: 4, 'web-gemini': 3, 'claude-code': 3, cc: 3, claude: 3, dialog: 1, manual: 0, mainagent: 0 };
// 自审风险通道：本步由 cc 实现（链条项存在即视为 cc 实现），则这些裁决不接受——
// 即便其强度数值与 web-gemini 同级，也不能让「实施方审自己」通过。
const SELF_REVIEW_CHANNELS = new Set(['cc', 'claude', 'claude-code']);

const args = process.argv.slice(2);
const stepId = String(args.find((a) => !a.startsWith('--')) || '');
const dryRun = args.includes('--dry-run');
const asJson = args.includes('--json');
const chIdx = args.indexOf('--channel');
const reviewChannel = chIdx >= 0 ? args[chIdx + 1] : undefined;
const taskIdx = args.indexOf('--task');
const shaIdx = args.indexOf('--sha');
const minIdx = args.indexOf('--min-reviewer');
const minReviewer = minIdx >= 0 ? args[minIdx + 1] : null;
// 主 agent 步（无 cc 任务，如计划第 3 步「V1 版间门」/第 7 步「三版终验」）走这里：用外部证据文件作为 note 依据。
// 约定：证据文件若含 `<X>_GATE=BLOCKED`（如 V1_GATE=BLOCKED），则拒绝收口——门未通过不得置 review。
const evIdx = args.indexOf('--evidence-file');
const evidenceFile = evIdx >= 0 ? args[evIdx + 1] : null;
// 强度/自审映射自测（无副作用，不需要额度）：node protocol-close-step.mjs --selftest-reviewer
// 必须放在 !stepId 的 usage 守卫**之前**（否则无位置参数时先被 usage 拦下）。
// 用例取自 relay 实际会写入的 reviewedBy 取值（lib/index.js L3377/L3388/L3406/L3418/L3431/L3514/L3528/L2948）。
if (args.includes('--selftest-reviewer')) {
  const min = 'web-gemini';
  const need = STRENGTH[min];
  const cases = [
    ['external', true], ['swarm', true], ['web-gemini', true],
    ['claude-code', false], ['cc', false], ['claude', false],   // 自审：本步由 cc 实现
    ['dialog', false], ['manual', false], ['mainagent', false], ['gemini-free', false],
  ];
  console.log('  [selftest] reviewedBy 强度/自审映射（min-reviewer=web-gemini，need=3，视为 cc 实现的步骤）');
  let ok = true;
  for (const [rb, expect] of cases) {
    const selfRej = SELF_REVIEW_CHANNELS.has(rb);
    const got = STRENGTH[rb] ?? 0;
    const pass = !selfRej && got >= need;
    if (pass !== expect) ok = false;
    console.log(`    ${rb.padEnd(12)} 强度=${String(got).padEnd(2)} 自审=${String(selfRej).padEnd(5)} → ${pass ? '接受' : '停止'}${pass === expect ? '' : '  ✗ 与预期不符'}`);
  }
  console.log(`  RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

if (!stepId) { console.error('usage: node protocol-close-step.mjs <stepId> [--dry-run] [--json] [--min-reviewer external]'); process.exit(2); }

const emit = (obj) => { if (asJson) console.log('__JSON__' + JSON.stringify(obj)); };
const finish = (code, obj) => { emit(obj); process.exit(code); };

const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, json: await r.json().catch(() => null) }; };
const post = async (p, body) => {
  if (dryRun) { console.log(`  [dry-run] POST ${p}`); console.log('    ' + JSON.stringify(body).slice(0, 300)); return { status: 0, json: null }; }
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  console.log(`  POST ${p} → HTTP ${r.status}`);
  return { status: r.status, json: j };
};

// ---- 1) 权威状态 ----
const cur = await get(`/steps?cwd=${encodeURIComponent(ws)}&id=${encodeURIComponent(exprId)}`);
const state = cur.json || {};
const step = (state.steps || []).find((s) => String(s.id) === stepId);
if (!step) { console.error(`  step ${stepId} 不存在`); finish(2, { stepId, error: 'step-not-found' }); }
console.log(`  权威状态: step ${stepId} = ${step.status}（reviewedBy=${step.reviewedBy || '-'}）| expr.currentStep=${state.currentStep}`);
if (step.status === 'approved') {
  console.log('  → 已 approved，无需操作（拒绝重复执行/重复审核）');
  finish(0, { stepId, finalStatus: 'approved', reviewedBy: step.reviewedBy || null, action: 'noop' });
}

// ---- 2) 前置守卫 + 证据组装 ----
const chainStatePath = path.join('D:\\cc-tasks', 'chain-state.json');
// 链条定义解析（原为硬编码 cc-chains/v1-v3.mjs → 新链条收口会静默退回旧定义、绕过前置守卫）：
// 优先级 env DSH_CC_CHAIN_DEF → run-chain.cmd 实际引用 → 回退 v1-v3。解析结果打印出来以便审计。
const chainDefPath = loadChainDefPath({ work: WORK });
console.log(`  链条定义: ${chainDefPath}`);
let taskId = taskIdx >= 0 ? args[taskIdx + 1] : null;
let sha = shaIdx >= 0 ? args[shaIdx + 1] : null;
let chainItem = null;
let def = null;
try { def = (await import(`file:///${chainDefPath.replace(/\\/g, '/')}`)).chain; } catch { /* 无定义则退化 */ }
const defItem = def?.items?.find((it) => String(it.planStepId) === stepId) || null;
if (defItem) taskId = taskId || defItem.taskId;
if (fs.existsSync(chainStatePath)) {
  const cs = JSON.parse(fs.readFileSync(chainStatePath, 'utf8'));
  for (const [label, v] of Object.entries(cs.items || {})) {
    if (String(v.planStepId) === stepId || (defItem && label === defItem.label)) {
      chainItem = { label, ...v };
      sha = sha || v.commit?.sha || null;
    }
  }
}
const okStatuses = new Set(['accepted-awaiting-review', 'accepted', 'approved-and-closed']);
// 打回后重提（协议给出的恢复路径）：chain 状态为 review-rejected **且代码已落地（有 commit）** 时允许重新收口——
// 此时步骤为 rejected，收口器会先 reopen 再 complete+auto-review。无 commit 的暂停/等待态仍拒绝（代码根本没落地）。
const rejectedWithCommit = !!(chainItem && chainItem.status === 'review-rejected' && chainItem.commit && chainItem.commit.sha);
if (chainItem && !okStatuses.has(chainItem.status) && !rejectedWithCommit) {
  console.error(`  ✗ 拒绝收口：Step ${stepId} 在链条中状态为 ${chainItem.status}（${chainItem.detail || ''}）——代码尚未落地，不得置 review。`);
  finish(3, { stepId, error: 'not-landed', chainStatus: chainItem.status });
}
if (!chainItem && defItem) {
  console.error(`  ✗ 拒绝收口：Step ${stepId}（链条项「${defItem.label}」）在 chain-state 中无记录——尚未派发/未落地，不得置 review。`);
  finish(3, { stepId, error: 'no-chain-record' });
}

const evidence = [];
const artifacts = [];
if (chainItem) evidence.push(`链条记录：${chainItem.label} → ${chainItem.status}${chainItem.result ? ` / result.status=${chainItem.result.status} exit=${chainItem.result.exit}` : ''}`);
if (sha) {
  const st = String(spawnSync('git', ['-C', REPO, 'show', '--stat', '--oneline', sha], { encoding: 'utf8' }).stdout || '');
  const files = [...st.matchAll(/^\s+(\S+)\s+\|/gm)].map((m) => m[1]);
  artifacts.push(...files);
  evidence.push(`提交 ${sha}：${files.length} 文件（${files.join(', ')}）`);
}
if (taskId) {
  const rp = path.join('D:\\cc-tasks', 'tasks', taskId, 'result.json');
  if (fs.existsSync(rp)) evidence.push(`cc 任务 ${taskId} result.json = ${fs.readFileSync(rp, 'utf8').replace(/\s+/g, ' ')}`);
  const v = spawnSync(process.execPath, ['verify-cc-task.mjs', taskId], { cwd: WORK, encoding: 'utf8' });
  const vTail = String(v.stdout || '').split('\n').filter((l) => l.includes('[PASS]') || l.includes('[FAIL]') || l.includes('RESULT')).join(' ; ');
  evidence.push(`主 agent 独立验收 verify-cc-task = ${v.status === 0 ? 'ACCEPT' : 'REJECT'}：${vTail.slice(0, 600)}`);
}
if (!evidence.length) evidence.push(`（未自动取到任务/提交证据；step ${stepId} 请人工补充）`);

// 外部证据文件（主 agent 步：版间门/终验）——同时作为「门未通过则拒绝收口」的机器判据
if (evidenceFile) {
  let txt = '';
  try { txt = fs.readFileSync(evidenceFile, 'utf8'); } catch (e) {
    console.error(`  ✗ 证据文件不可读：${evidenceFile}（${e.code || e.message}）`);
    finish(2, { stepId, error: 'evidence-file-unreadable' });
  }
  const gateBlocked = /_GATE=BLOCKED/.test(txt);
  const gatePass = /_GATE=PASS/.test(txt);
  console.log(`  证据文件: ${evidenceFile}（${Buffer.byteLength(txt, 'utf8')} 字节；门标记 = ${gateBlocked ? 'BLOCKED' : gatePass ? 'PASS' : '未含'}）`);
  if (gateBlocked) {
    console.error('  ✗ 证据文件显示门未通过（*_GATE=BLOCKED）→ 拒绝收口，不得把未过门的步骤置为 review');
    finish(3, { stepId, error: 'gate-blocked-by-evidence', evidenceFile });
  }
  evidence.push(`证据文件 ${path.basename(evidenceFile)}（门标记 ${gatePass ? 'PASS' : '未含'}）：\n${txt.split('\n').filter((l) => l.trim()).slice(0, 24).join('\n')}`);
}
console.log('  证据组装：');
for (const e of evidence) console.log('    - ' + e);
if (artifacts.length) console.log('  artifacts: ' + artifacts.join(', '));

// ---- 3) 按状态机执行 ----
const role = 'mainagent';
const comment = ['V1/V2/V3 计划步骤协议收口（主 agent）', ...evidence].join('\n');
// rejected（审核打回后）→ 先 reopen 才能重新 complete；否则后续 complete/review 都因状态不符被拒。
if (step.status === 'rejected') {
  console.log('  检测到 rejected：先 reopen 再重提');
  const rp = await post('/steps/update', { workspacePath: ws, exprId, stepId, action: 'reopen', role, sessionId, comment: `审核打回后重开：${comment.slice(0, 400)}` });
  if (rp.status && rp.status >= 400) {
    console.error(`  ✗ reopen 失败（HTTP ${rp.status}）——需人工处理`);
    finish(1, { stepId, finalStatus: step.status, error: 'reopen-failed', httpStatus: rp.status });
  }
}
if (step.status === 'pending' || step.status === 'rejected') {
  await post('/steps/update', { workspacePath: ws, exprId, stepId, action: 'start', role, sessionId, comment: `主 agent 收口：开始 Step ${stepId}` });
}
if (['pending', 'executing', 'rejected'].includes(step.status)) {
  await post('/steps/update', { workspacePath: ws, exprId, stepId, action: 'complete', role, sessionId, artifacts: artifacts.length ? artifacts : undefined, comment });
}
console.log('  独立审核（降级链，非自批）...');
// --no-swarm：绕过 Swarm 双角色盲审，走标准独立审核链（external → web-gemini → dialog）。
// 用途：Swarm 路径已定性存在「空打回」缺陷（lib/swarm-prompts.js parseRoleReview 在角色输出不可解析时
// 静默默认 rejected、findings/suggestion 全空，实测 step 4：2/3 命中；step 7：2/2 命中）。
// 该缺陷修复前，对无法整改的空打回改用标准链取可执行裁决，并在证据里说明原因。
const noSwarm = args.includes('--no-swarm');
const rev = await post('/steps/auto-review', { workspacePath: ws, exprId, stepId, sessionId, ...(reviewChannel ? { reviewChannel } : {}), ...(noSwarm ? { enableSwarm: false } : {}) });

// ---- 4) 裁决与强度门 ----
let finalStatus = step.status;
let reviewedBy = step.reviewedBy || null;
if (rev.json) {
  const s2 = (rev.json.stepState?.steps || []).find((s) => String(s.id) === stepId);
  if (s2) { finalStatus = s2.status; reviewedBy = s2.reviewedBy || null; }
}
console.log(`  → step ${stepId} 最终状态 = ${finalStatus}（reviewedBy=${reviewedBy || '-'}）`);
if (dryRun) finish(0, { stepId, finalStatus, reviewedBy, action: 'dry-run' });

if (finalStatus !== 'approved') {
  console.error(`  ✗ 审核未通过：step ${stepId} 状态为 ${finalStatus}——停止自动化，等待人工/主 agent 处理`);
  finish(1, { stepId, finalStatus, reviewedBy, error: 'not-approved' });
}
if (minReviewer) {
  const rb = String(reviewedBy || '').toLowerCase();
  if (chainItem && SELF_REVIEW_CHANNELS.has(rb)) {
    console.error(`  ✗ 自审风险：本步由 cc 实现，裁决来自 ${reviewedBy}——不接受自审，停止自动化`);
    finish(5, { stepId, finalStatus, reviewedBy, error: 'self-review-rejected', required: minReviewer });
  }
  const need = STRENGTH[minReviewer] ?? 4;
  const got = STRENGTH[rb] ?? 0;
  if (got < need) {
    console.error(`  ✗ 审核通道强度不足：reviewedBy=${reviewedBy}（强度 ${got}）< 要求 ${minReviewer}（强度 ${need}）——停止自动化`);
    finish(5, { stepId, finalStatus, reviewedBy, error: 'reviewer-too-weak', required: minReviewer });
  }
}
console.log(`  ✓ step ${stepId} 已 approved（reviewedBy=${reviewedBy}），可继续`);
finish(0, { stepId, finalStatus: 'approved', reviewedBy, action: 'closed' });
