// V1 计划第 1 步的协议收口：start → complete(带证据) → /steps/auto-review（独立审核，绝不代批）
const BASE = 'http://127.0.0.1:3080/dsh-web-relay';
const exprId = 'expr-2026-09-13_17-36-07';
const ws = 'D:\\dsh relay test';
const sessionId = process.env.DSH_SESSION_ID || '';

async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  const t = await r.text();
  let short = t;
  try {
    const j = JSON.parse(t);
    short = JSON.stringify(j).slice(0, 900);
  } catch { /* 非 JSON 原样 */ }
  console.log(`  ${p} → HTTP ${r.status}`);
  console.log(`    ${short}`);
  return { status: r.status, text: t };
}

console.log('=== 第 1 步协议收口（V1-1 突破度硬门禁）===');
await post('/steps/update', {
  workspacePath: ws, exprId, stepId: '1', action: 'start', role: 'mainagent', sessionId,
  comment: 'V1-1 由 cc 任务 v1-1-breakthrough-gate 实现（见 chain.log 与 tasks/v1-1-breakthrough-gate/result.json）',
});

await post('/steps/update', {
  workspacePath: ws, exprId, stepId: '1', action: 'complete', role: 'mainagent', sessionId,
  artifacts: ['lib/breakthrough-gate.js', 'lib/index.js', 'test/breakthrough-gate.test.js'],
  comment: [
    '证据：① cc 任务 result.json = {"status":"done","exit":0}，用时 496s；',
    '② 主 agent 独立验收 verify-cc-task.mjs = 7/7 ACCEPT（写入范围合规、node --check 通过、全量 473/473、*.test.js 333/333、verify-files-coverage OK、无 BOM/CRLF）；',
    '③ test/breakthrough-gate.test.js 用例 5 → 20（契约要求 ≥13）；',
    '④ 实现要点复核：evaluateBreakthroughPlan({steps,history}) 纯函数；全未声明 → verdict=gate-needs-declaration 保守拦截（DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED=1 可放行）；历史与当前版双计数、unknown 不计不重置；阈值 DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL 默认 3 → gate-blocked + requiredType=structural；',
    '⑤ 提交：4d43ea1（链条自动提交，暂定；本次收口为其补协议审核）。',
  ].join('\n'),
});

console.log('=== 独立审核（降级链，非自批）===');
await post('/steps/auto-review', { workspacePath: ws, exprId, stepId: '1', sessionId });
