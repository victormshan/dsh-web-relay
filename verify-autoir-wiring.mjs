// 接线断言（静态兜底）—— 防"行为验证过了，但接线被后续重构悄悄摘掉"。
//
// 定位说明：本探针**只证明接线还在**，不证明行为正确（行为由 verify-autoir-events.mjs 用生产路径合成事件验证）。
// 静态断言的价值在于**便宜且能进周期**：它每 30 分钟能跑，而行为验证要写真实状态。
//
// 断言清单（针对 v20 落地的两条事件路径）：
//   A1 熔断登记在两处熔断点都被调用（手动打回 / 审核打回）—— 少一处就是"有一条路熔断了却无人被叫醒"。
//   A2 每处调用都**紧跟**在 `state.status = 'paused'` 之后（防止被挪到 trip 条件之外，那样永不触发）。
//   A3 版间门三种决策分支都落 iterationGates（advance / blocked / finalized）—— 漏一种就有"决策无记录"。
//   A4 iterationGates 出现在 readStepState 的**重建白名单**里 —— 漏了就是"读回来丢字段，下次写盘即丢"
//      （v3.7.1 曾漏 iterationBaseCommit，实测写盘即丢）。
//   A5 信号 taskId 用规范 ref（exprTaskRef / makeRef），不手写裸串 —— 统一身份的唯一入口。
//
// 两侧自检：对文件文本做**内存副本**变异（不碰真实文件），断言每种破坏都被抓到。
// 用法: node verify-autoir-wiring.mjs [--json]
//       node verify-autoir-wiring.mjs --selftest     # 两侧（[POS] 真实文件通过 / [NEG] 每种破坏必被抓）
import fs from 'node:fs';

export const REPO = 'D:\\dsh-web-relay';
export const INDEX = `${REPO}\\lib\\index.js`;

/** 纯函数：对给定的 lib/index.js 文本做接线断言。返回 { ok, violations[] }。 */
export function checkWiring(text) {
  const lines = String(text).split('\n');
  const violations = [];
  const hits = (re) => lines.map((l, i) => ({ l, i })).filter((x) => re.test(x.l));

  // A1 熔断登记：两处熔断点都要调
  const regCalls = hits(/registerCircuitBreakerSignal\s*\(/).filter((x) => !/^\s*(?:\/\/|\*)/.test(x.l) && !/async function registerCircuitBreakerSignal/.test(x.l));
  if (regCalls.length !== 2) violations.push(`A1 熔断登记调用点 = ${regCalls.length}，期望 2（手动打回 + 审核打回各一处）`);

  // A2 每处调用都紧跟 state.status = 'paused'
  for (const c of regCalls) {
    const window = lines.slice(Math.max(0, c.i - 12), c.i);
    if (!window.some((l) => /state\.status\s*=\s*'paused'/.test(l))) {
      violations.push(`A2 第 ${c.i + 1} 行的熔断登记前 12 行内没有 state.status = 'paused'（调用被挪出了 trip 分支？）`);
    }
  }

  // A3 每种门决策都必须有落盘处（不硬数次数：2026-09-20 引入 early-close 后从 3 种变 4 种，
  //    硬编码计数会把"架构演进"误报成"接线断裂"——按**决策种类**断言才既有判别力又不脆）。
  const gateDecisions = ['advance', 'blocked', 'finalized', 'early-close'];
  for (const dec of gateDecisions) {
    const found = lines.some((l, i) => /iterationGates\.push\s*\(/.test(l) && lines.slice(i, i + 12).some((x) => new RegExp(`decision:\\s*'${dec}'`).test(x)));
    if (!found) violations.push(`A3 未找到 decision: '${dec}' 的门记录落盘处（该决策不会留痕）`);
  }

  // A4 重建白名单必须含 iterationGates
  if (!lines.some((l) => /iterationGates:\s*Array\.isArray\(state\.iterationGates\)/.test(l))) {
    violations.push('A4 readStepState 重建白名单缺 iterationGates（读回来丢字段 → 下次写盘即丢）');
  }

  // A5 taskId 走规范 ref
  if (!/exprTaskRef\s*\(/.test(text)) violations.push('A5 未使用 exprTaskRef()（统一身份入口）构造 taskId/ref');
  if (!/from\s+'\.\/task-ref\.mjs'/.test(text) && !/from\s+'\.\/pending-human\.mjs'/.test(text)) {
    violations.push('A5 未从 task-ref / pending-human 引入身份构造函数');
  }

  // A6 提前收口必须落 early-close 记录（主 agent 决策 (b)），且必须挂在"全 approved 即置 done"的收口处
  const closeSites = lines.map((l, i) => ({ l, i })).filter((x) => /steps\.every\(\(s\) => s\.status === 'approved'\)/.test(x.l));
  const earlyCloseSites = closeSites.filter((x) => lines.slice(x.i, x.i + 20).some((y) => /decision:\s*'early-close'/.test(y)));
  if (earlyCloseSites.length === 0) violations.push('A6 未找到任何挂 early-close 记录的收口点（手动收口会静默忽略声明的版数）');

  return { ok: violations.length === 0, violations };
}

if (process.argv.includes('--selftest')) {
  const real = fs.readFileSync(INDEX, 'utf8');
  const cases = [];
  const t = (label, text, expectOk) => {
    const r = checkWiring(text);
    const pass = r.ok === expectOk;
    cases.push({ pass, label });
    console.log(`  [${pass ? 'PASS' : (expectOk ? 'FAIL' : 'NEG-OK')}] ${label}${pass ? '' : `（期望 ok=${expectOk}，实际 ${r.ok}：${r.violations.join('；')}）`}`);
  };
  // 变异负控带**空转自证**：变异必须真的改变文本，否则"负控空转"看起来和"断言失效"一模一样
  // （本文件初版就栽在这：A2 的正则没匹配上 → 文本没变 → 断言当然"抓不到"，却报成负控失败）。
  const mut = (label, fn) => {
    const m = fn(real);
    if (m === real) { cases.push({ pass: false, label }); console.log(`  [FAIL] ${label} — ⚠ 负控空转：变异没有改变文本（正则未命中），不能据此判定断言有效性`); return; }
    t(label, m, false);
  };
  t('[POS] 真实 lib/index.js 接线完整 → 放行', real, true);
  mut('[NEG] 删掉一处熔断登记调用 → 抓（A1）', (s) => s.replace(/^\s*await registerCircuitBreakerSignal\(.*$/m, ''));
  mut('[NEG] 删掉 trip 分支里的 state.status = \'paused\' → 抓（A2）', (s) => s.replace(/state\.status = 'paused'/, "state.status = state.status"));
  mut('[NEG] 把 finalized 的门记录删掉 → 抓（A3）', (s) => s.replace(/decision:\s*'finalized'/, "decision: 'x'"));
  mut('[NEG] 从重建白名单删掉 iterationGates → 抓（A4）', (s) => s.replace(/^\s*iterationGates: Array\.isArray\(state\.iterationGates\) \? state\.iterationGates : \[\],\s*$/m, ''));
  mut('[NEG] 去掉 exprTaskRef 用法 → 抓（A5）', (s) => s.replace(/exprTaskRef/g, 'String'));
  mut('[NEG] 去掉 early-close 记录（手动收口将静默忽略版数）→ 抓（A6）', (s) => s.replace(/decision: 'early-close'/, "decision: 'x'"));
  const bad = cases.filter((c) => !c.pass).length;
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

// ---- 实跑 ----
const text = fs.readFileSync(INDEX, 'utf8');
const r = checkWiring(text);
console.log('=== 接线断言（静态兜底，仅证明"接线还在"）===');
console.log(`  目标 = ${INDEX}`);
for (const v of r.violations) console.log(`  ✗ ${v}`);
console.log(`\n  RESULT: ${r.ok ? 'PASS（接线完整）' : `FAIL（${r.violations.length} 项接线缺失）`}`);
if (process.argv.includes('--json')) {
  const out = `${import.meta.dirname}\\autoir-wiring.json`;
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), ok: r.ok, violations: r.violations }, null, 2), 'utf8');
}
process.exit(r.ok ? 0 : 1);
