// V1 验收证据包：对 V1-1 / V1-2 的真实落地做可复跑取证（供第 3 步「V1 版间门校验与合入」的协议 note 使用）
// 用法: node verify-v1-acceptance.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = 'D:\\dsh-web-relay';
const WORK = 'D:\\dsh relay test';
const stepsPath = path.join(WORK, 'web-relay', 'experiments', 'expr-2026-09-13_17-36-07.steps.json');
const out = [];
const line = (s) => { out.push(s); console.log('  ' + s); };

// ---- A. 计划状态 ----
const st = JSON.parse(fs.readFileSync(stepsPath, 'utf8'));
line(`A. 计划状态: iterations=${st.iterations} currentIteration=${st.currentIteration} autoDecision=${st.autoDecision} finalAcceptance=${JSON.stringify(st.finalAcceptance)}`);
for (const s of st.steps.slice(0, 2)) line(`   [${s.id}] ${s.status} reviewedBy=${JSON.stringify(s.reviewedBy || null)} :: ${s.title.slice(0, 40)}`);

// ---- B. V1-1 门禁：对真实计划做三态判定（直接 import 模块，不依赖宿主是否重启） ----
const mod = await import(`file:///${REPO.replace(/\\/g, '/')}/lib/breakthrough-gate.js`);
const realSteps = st.steps; // 7 步，breakthrough_type 全为 null
const declaredTypes = realSteps.map((s) => s.breakthrough_type);
line(`B. V1-1 突破度门禁（对真实计划 7 步，breakthrough_type=${JSON.stringify(declaredTypes)}）`);
if (typeof mod.evaluateBreakthroughPlan !== 'function') {
  line('   [FAIL] evaluateBreakthroughPlan 不存在——V1-1 未落地');
} else {
  delete process.env.DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED;
  const r1 = mod.evaluateBreakthroughPlan({ steps: realSteps, history: [] });
  line(`   ① 默认（全未声明）→ gatePassed=${r1.gatePassed} verdict=${r1.verdict} requiredType=${r1.requiredType}`);
  line(`      reasons: ${JSON.stringify(r1.reasons)}`);
  process.env.DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED = '1';
  const r2 = mod.evaluateBreakthroughPlan({ steps: realSteps, history: [] });
  line(`   ② ALLOW_UNDECLARED=1 → gatePassed=${r2.gatePassed} verdict=${r2.verdict}`);
  delete process.env.DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED;
  const declared = realSteps.map((s, i) => (i === 0 ? { ...s, breakthrough_type: 'structural' } : s));
  const r3 = mod.evaluateBreakthroughPlan({ steps: declared, history: ['incremental', 'incremental', 'incremental'] });
  line(`   ③ 声明 structural + 历史 3 连增 → gatePassed=${r3.gatePassed} verdict=${r3.verdict} consecutive=${r3.consecutiveIncremental}`);
  const thresh = mod.evaluateBreakthroughPlan({ steps: declared.map((s) => ({ ...s, breakthrough_type: 'incremental' })), history: ['incremental', 'incremental'] });
  line(`   ④ 全 incremental + 历史 2 连增（阈值 3）→ gatePassed=${thresh.gatePassed} verdict=${thresh.verdict} consecutive=${thresh.consecutiveIncremental}`);
  const ok = r1.gatePassed === false && r1.verdict === 'gate-needs-declaration' && r2.gatePassed === true && r3.gatePassed === true && thresh.gatePassed === false;
  line(`   → 判定: ${ok ? 'PASS（保守拦截/放行开关/突破重置/阈值拦截 四态均正确）' : 'FAIL'}`);
}

// ---- C. V1-1 /ask 审计接线 + V1-2 落地探测（静态取证） ----
const idx = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8');
line('C. 接线静态取证');
line(`   lib/index.js: auditBreakthrough 命中 ${(idx.match(/auditBreakthrough/g) || []).length} 处；incrementalStreak 命中 ${(idx.match(/incrementalStreak/g) || []).length} 处`);
line(`   /ask 注入点 guidedPrompt（L2086-2096）存在 = ${/const guidedPrompt = \[/.test(idx)}；callGemini(guidedPrompt) = ${/callGemini\(guidedPrompt\)/.test(idx)}`);
const hasAssess = /export function assessAutoIterDecl/.test(fs.readFileSync(path.join(REPO, 'lib', 'autoiter-decl.js'), 'utf8'));
const hasDeclare = /steps\/declare/.test(idx);
line(`   V1-2 探针: assessAutoIterDecl = ${hasAssess ? '已落地' : '未落地'}；/steps/declare 入口 = ${hasDeclare ? '已落地' : '未落地'}`);

// ---- D. 测试基线 ----
const t = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(REPO, 'test', 'breakthrough-gate.test.js')], { encoding: 'utf8' });
const pick = (k) => { const m = String(t.stdout || '').match(new RegExp(`^# ${k} (\\d+)$`, 'm')); return m ? Number(m[1]) : -1; };
line(`D. breakthrough-gate 用例: tests=${pick('tests')} pass=${pick('pass')} fail=${pick('fail')}（契约要求 ≥13）`);
const files = fs.readdirSync(path.join(REPO, 'test')).filter((f) => f.endsWith('.test.js') || f.endsWith('.test.mjs')).map((f) => path.join(REPO, 'test', f));
const all = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const pickA = (k) => { const m = String(all.stdout || '').match(new RegExp(`^# ${k} (\\d+)$`, 'm')); return m ? Number(m[1]) : -1; };
line(`   全量: tests=${pickA('tests')} pass=${pickA('pass')} fail=${pickA('fail')}`);

// ---- E. V1 版间门判定（计划第 3 步：V1 两步 approved 且无未恢复的突破度阻断，方可进入 V2）----
line('E. V1 版间门判定');
const s1 = st.steps.find((s) => String(s.id) === '1');
const s2 = st.steps.find((s) => String(s.id) === '2');
const gateReasons = [];
const ok1 = s1 && s1.status === 'approved';
const ok2 = s2 && s2.status === 'approved';
if (!ok1) gateReasons.push(`step 1 状态=${s1 ? s1.status : '缺失'}（需 approved）`);
if (!ok2) gateReasons.push(`step 2 状态=${s2 ? s2.status : '缺失'}（需 approved）`);
const fullOk = (typeof pickA === 'function') && pickA('fail') === 0;
if (!fullOk) gateReasons.push('全量测试未全绿');
if (Number(st.incrementalStreak) >= 3) gateReasons.push(`incrementalStreak=${st.incrementalStreak} 已达阈值，进入 V2 前须含 structural/paradigm 突破项`);
line(`   step 1 = ${s1 ? s1.status : '?'}（reviewedBy=${s1 ? s1.reviewedBy || '-' : '-'}）| step 2 = ${s2 ? s2.status : '?'}（reviewedBy=${s2 ? s2.reviewedBy || '-' : '-'}）`);
line(`   incrementalStreak=${st.incrementalStreak} | autoDecision=${st.autoDecision} | finalAcceptance=${st.finalAcceptance ? '已声明' : 'null'}`);
line(`   → V1 版间门: ${gateReasons.length === 0 ? 'PASS — 可进入 V2（请外部 AI 输出 V2 修正 Step List）' : 'BLOCKED — ' + gateReasons.join('；')}`);

if (process.argv.includes('--json')) {
  const bundle = out.join('\n') + `\nV1_GATE=${gateReasons.length === 0 ? 'PASS' : 'BLOCKED'}\n`;
  fs.writeFileSync(path.join(WORK, '_v1-acceptance-bundle.txt'), bundle, 'utf8');
  console.log('  已写出 _v1-acceptance-bundle.txt（' + Buffer.byteLength(bundle, 'utf8') + ' 字节）');
}
