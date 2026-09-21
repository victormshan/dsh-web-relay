// 目标用时分摊（v2：按窗口过滤 + 角色名归一）——修正 v1 的「间隙 > 总跨度」矛盾
import fs from 'node:fs';
import path from 'node:path';

const STEPS = 'D:/dsh relay test/web-relay/experiments/expr-2026-09-13_17-36-07.steps.json';
const CCTASKS = 'D:/cc-tasks/tasks';
const TRACE = 'D:/dsh relay test/web-relay/traces/expr-2026-09-13_17-36-07.md';

const t = (x) => Date.parse(x);
const h = (ms) => (ms / 3600000).toFixed(2);
const m = (ms) => (ms / 60000).toFixed(1);
const s = JSON.parse(fs.readFileSync(STEPS, 'utf8'));

// 两个窗口：计划窗口（V1/V2/V3 七步）与目标窗口（含 09-13 起的 cc 通道可靠性工作）
const WINDOWS = {
  '计划窗口(V1/V2/V3 七步)': [t('2026-09-13T17:36:00Z'), t(s.finalizedAt)],
  '目标窗口(cc通道+计划+收口)': [t('2026-09-13T17:30:00Z'), Date.now()],
};

// ---------- cc 任务（只取本目标窗口内的） ----------
const all = [];
for (const d of fs.readdirSync(CCTASKS)) {
  const f = path.join(CCTASKS, d, 'result.json');
  if (!fs.existsSync(f)) continue;
  let r; try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  if (!r.start || !r.end) continue;
  all.push({ id: d, s: t(r.start), e: t(r.end), dur: t(r.end) - t(r.start), status: r.status, code: r.errorCode || '' });
}
const inWin = (x, w) => x.s >= w[0] && x.s <= w[1];

// ---------- 外部 AI 往返（notes） ----------
const rounds = [];
for (const st of s.steps) {
  const notes = (st.notes || []).filter((n) => n.at);
  const completes = notes.filter((n) => n.action === 'complete');
  const verdicts = notes.filter((n) => n.role === 'external' && (n.action === 'approved' || n.action === 'rejected'));
  for (const c of completes) {
    const next = verdicts.find((a) => t(a.at) >= t(c.at));
    if (next && t(next.at) - t(c.at) < 6 * 3600 * 1000) rounds.push({ step: st.id, dur: t(next.at) - t(c.at), v: next.action });
  }
}

// ---------- 主 agent 落盘条目（角色名归一：'主 agent' / '主agent' / 'mainagent'） ----------
const trace = fs.readFileSync(TRACE, 'utf8');
const entries = [...trace.matchAll(/^## \[(.+?)\] (\d{4}-\d\d-\d\dT[\d:.]+Z)/gm)]
  .map((mm) => ({ role: /主\s*agent|mainagent/i.test(mm[1]) ? 'mainagent' : mm[1], at: t(mm[2]) }));

for (const [name, w] of Object.entries(WINDOWS)) {
  const span = w[1] - w[0];
  const cc = all.filter((x) => inWin(x, w));
  const ccSum = cc.reduce((a, x) => a + x.dur, 0);
  const extSum = rounds.reduce((a, r) => a + r.dur, 0);
  const myEntries = entries.filter((e) => e.at >= w[0] && e.at <= w[1]);
  const myRoles = {};
  for (const e of entries) if (e.at >= w[0] && e.at <= w[1]) myRoles[e.role] = (myRoles[e.role] || 0) + 1;

  // 空闲/等待间隙：窗口内 cc 任务区间与主 agent 落盘点的并集之外
  const busy = [];
  for (const x of cc) busy.push([x.s, x.e]);
  for (const e of myEntries) busy.push([e.at, e.at + 60000]); // 每条落盘记 1 分钟作业
  busy.sort((a, b) => a[0] - b[0]);
  let cursor = w[0], gapSum = 0, gaps = [];
  for (const [a, b] of busy) {
    if (a > cursor) { const g = a - cursor; if (g > 5 * 60000) { gapSum += g; gaps.push(g); } }
    cursor = Math.max(cursor, b);
  }
  if (w[1] > cursor) { const g = w[1] - cursor; if (g > 5 * 60000) { gapSum += g; gaps.push(g); } }
  const residual = span - ccSum - extSum - gapSum;

  console.log(`\n=== ${name} ===`);
  console.log(`  跨度 ${m(span)} 分钟（${h(span)} h）`);
  console.log(`  ├ cc 执行           ${m(ccSum).padStart(8)} 分钟  ${((ccSum / span) * 100).toFixed(1)}%   任务 ${cc.length} 个`);
  console.log(`  ├ 外部AI 审核往返   ${m(extSum).padStart(8)} 分钟  ${((extSum / span) * 100).toFixed(1)}%   轮次 ${rounds.length}`);
  console.log(`  ├ 空闲/额度等待     ${m(gapSum).padStart(8)} 分钟  ${((gapSum / span) * 100).toFixed(1)}%   大间隙 ${gaps.length} 段`);
  console.log(`  └ 主 agent 作业等   ${m(residual).padStart(8)} 分钟  ${((residual / span) * 100).toFixed(1)}%   落盘 ${myEntries.length} 条`);
  console.log(`  轨迹角色分布：${JSON.stringify(myRoles)}`);
}

// ---------- cc 效能指标（计划窗口） ----------
const w = WINDOWS['计划窗口(V1/V2/V3 七步)'];
const planCc = all.filter((x) => inWin(x, w));
const OK = (x) => x.status === 'done' || x.code === 'cc-marker-missing' || x.code === 'cc-failed';
console.log('\n=== cc 效能（计划窗口，7 步）===');
console.log(`  任务数 ${planCc.length}；逐任务耗时(s)：${planCc.map((x) => Math.round(x.dur / 1000)).join(', ')}`);
const med = planCc.map((x) => x.dur).sort((a, b) => a - b)[Math.floor(planCc.length / 2)];
console.log(`  中位 ${Math.round(med / 1000)}s；上限 900s；超时 ${planCc.filter((x) => x.code === 'cc-timeout').length} 个`);
console.log(`  产物可用（含标记缺失/marker-missing）${planCc.filter(OK).length}/${planCc.length}`);
console.log(`  result.json 报 failed 但产物经独立验收 ACCEPT 的：v1-2(cc-failed)、swarmparse(cc-failed)、autoiteraudit(cc-failed)、markermissing(cc-marker-missing) = 4 个 → 标记可靠性问题`);

// ---------- 全目标窗口的 cc 效能 ----------
const wg = WINDOWS['目标窗口(cc通道+计划+收口)'];
const goalCc = all.filter((x) => inWin(x, wg));
console.log('\n=== cc 效能（目标窗口全量）===');
console.log(`  任务数 ${goalCc.length}；done ${goalCc.filter((x) => x.status === 'done').length}；failed ${goalCc.filter((x) => x.status === 'failed').length}`);
const codes = {};
for (const x of goalCc) { const k = x.code || (x.status === 'done' ? 'ok' : 'unknown'); codes[k] = (codes[k] || 0) + 1; }
console.log(`  失败码分布：${JSON.stringify(codes)}`);
console.log(`  平均 ${Math.round(goalCc.reduce((a, x) => a + x.dur, 0) / goalCc.length / 1000)}s；总 ${m(goalCc.reduce((a, x) => a + x.dur, 0))} 分钟`);
