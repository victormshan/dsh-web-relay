// 诊断：重开 step 4 → 重提 → 触发 Swarm 审核并**打印完整响应**（看角色原始输出/裁决细节）
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:3080/dsh-web-relay';
const exprId = 'expr-2026-09-13_17-36-07';
const ws = 'D:\\dsh relay test';
const sessionId = process.env.DSH_SESSION_ID || '';
const evidence = fs.readFileSync('D:\\dsh relay test\\_step4-resubmit-evidence.txt', 'utf8');

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* raw */ }
  console.log(`  ${p} → HTTP ${r.status}`);
  return { status: r.status, json: j, text: t };
};

console.log('=== 1) reopen ===');
await post('/steps/update', { workspacePath: ws, exprId, stepId: '4', action: 'reopen', role: 'mainagent', sessionId, comment: '空打回复核：重开以获取可执行裁决' });

console.log('=== 2) complete（带补充证据）===');
await post('/steps/update', { workspacePath: ws, exprId, stepId: '4', action: 'complete', role: 'mainagent', sessionId, artifacts: ['lib/case-library.js', 'lib/index.js', 'test/case-library.test.js', 'docs/CC-HYBRID.md'], comment: '重提证据：\n' + evidence.slice(0, 1500) });

console.log('=== 3) auto-review（完整响应）===');
const rev = await post('/steps/auto-review', { workspacePath: ws, exprId, stepId: '4', sessionId });
const j = rev.json || {};
// 打印与 Swarm 相关的全部字段
for (const k of ['ok', 'result', 'reason', 'reviewer', 'reviewerLabel', 'fallbackReason', 'manual', 'swarm']) {
  if (k in j) console.log(`  ${k} = ${JSON.stringify(j[k]).slice(0, 1200)}`);
}
const st = (j.stepState && j.stepState.steps || []).find((s) => String(s.id) === '4');
if (st) {
  console.log(`  最终: status=${st.status} reviewedBy=${JSON.stringify(st.reviewedBy || null)}`);
  const last = (st.notes || []).slice(-1)[0];
  if (last) { console.log('  末条 note 全文:'); console.log('  ' + String(last.text || '').replace(/\n/g, '\n  ').slice(0, 2000)); }
}
if (!rev.json) console.log('  原始响应: ' + rev.text.slice(0, 800));
