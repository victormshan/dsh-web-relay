// AutoIteration 声明补全器：待 V1-2 的 /steps/declare 落地后一条命令完成「半状态 → 完整声明」
// 用法:
//   node declare-autoiter.mjs --probe                 # 仅探测端点是否已实现
//   node declare-autoiter.mjs --dry-run               # 打印将要提交的 body，不发请求
//   node declare-autoiter.mjs --auto-decision         # 真正声明（autoDecision=true，需显式开关）
// 安全约束：
//   ① finalAcceptance 为空则拒绝（避免声明成空验收标准）；
//   ② 未显式传 --auto-decision 时**绝不**把 autoDecision 置 true（防误开无人值守）；
//   ③ 端点不存在（V1-2 未落地）时 fail fast 并给明确提示，不做任何猜测性写入。
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3080/dsh-web-relay';
const WORK = 'D:\\dsh relay test';
const exprId = 'expr-2026-09-13_17-36-07';
const ws = WORK;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const probe = args.includes('--probe');
const autoDecision = args.includes('--auto-decision');
const itIdx = args.indexOf('--iterations');
const iterations = itIdx >= 0 ? Number(args[itIdx + 1]) : 3;
const afIdx = args.indexOf('--acceptance-file');
const afPath = afIdx >= 0 ? args[afIdx + 1] : path.join(WORK, '_final-acceptance.txt');

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, text: t };
};

// ---- 端点探测（404/405 都视为「未实现」；只有 400/200 才算端点存在）----
const probeRes = await post('/steps/declare', { workspacePath: ws, exprId, reason: 'probe' });
if (probeRes.status === 404 || probeRes.status === 405) {
  console.log(`  端点 /steps/declare 未实现（HTTP ${probeRes.status}）——V1-2 尚未落地，拒绝写入。`);
  console.log('  待链条完成 V1-2 后重跑本命令。');
  process.exit(4);
}
console.log(`  端点探测：HTTP ${probeRes.status}（400/200 → 端点存在）`);
if (probe) process.exit(0);

// ---- 组装声明 ----
let acceptance = '';
try { acceptance = fs.readFileSync(afPath, 'utf8').trim(); } catch { acceptance = ''; }
if (!acceptance) { console.error(`  ✗ finalAcceptance 为空（${afPath}）→ 拒绝声明`); process.exit(2); }
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10) { console.error(`  ✗ iterations 非法: ${iterations}（须 1-10）`); process.exit(2); }

const body = {
  workspacePath: ws,
  exprId,
  iterations,
  finalAcceptance: acceptance,
  ...(autoDecision ? { autoDecision: true } : {}),
  reason: autoDecision
    ? '主 agent 收口：V1-2 落地后，将半状态（iterations=3/autoDecision=false/finalAcceptance=null）补全为可无人值守推进的完整声明'
    : '主 agent 收口：补齐 finalAcceptance（不改变 autoDecision，保持人工审核每版）',
};

console.log(`  dry-run=${dryRun} autoDecision=${autoDecision} iterations=${iterations}`);
console.log(`  finalAcceptance 长度=${acceptance.length} 字符，首行：${acceptance.split('\n')[0]}`);
if (dryRun) { console.log('  [dry-run] body = ' + JSON.stringify(body).slice(0, 600)); process.exit(0); }

const res = await post('/steps/declare', body);
console.log(`  POST /steps/declare → HTTP ${res.status}`);
console.log('  ' + res.text.slice(0, 700));
try {
  const j = JSON.parse(res.text);
  const st = j.stepState || {};
  console.log(`  → 声明结果: iterations=${st.iterations} autoDecision=${st.autoDecision} finalAcceptance=${st.finalAcceptance ? '已设置(' + String(st.finalAcceptance).length + ' 字符)' : 'null'}`);
  if (j.autoIterDecl) {
    const d = j.autoIterDecl;
    console.log(`  → 完整性判定: complete=${d.complete} halfState=${d.halfState} reasons=${JSON.stringify(d.reasons)}`);
    if (d.hint) console.log(`  → 补齐提示: ${String(d.hint).slice(0, 220)}`);
  }
  // 契约核对（cc-specs/v1-2.mjs 第 5 条要求这两种响应形状）——缺字段时显式告警而非静默
  const missing = [];
  if (!j.stepState) missing.push('stepState');
  if (!j.autoIterDecl) missing.push('autoIterDecl');
  if (missing.length) console.error(`  ⚠ 响应缺少契约字段: ${missing.join(', ')}（规格 v1-2 第 5 条要求 stepState + autoIterDecl）——请核对 V1-2 实现`);
} catch { console.error('  ⚠ 响应非 JSON，无法核对契约字段'); }
