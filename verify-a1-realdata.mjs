// A1 端到端验证（真实数据形状，只读仓库）：unclaimed-pending 在**真实 7 步 expr** 上是否按预期工作
// 动机：A1 的 8 个单测全部使用最小 fake（两三个 step 的对象字面量），从未用真实的 7 步 expr 形状
// （含 depends_on 链、notes、archived 守卫、maxAgeMs 过滤）跑过。单测全绿 ≠ 真实形状下可用。
// 本脚本只读取仓库文件并 import 纯函数，不写任何仓库文件。
import fs from 'node:fs';

const STEPS_FILE = 'D:/dsh relay test/web-relay/experiments/expr-2026-09-13_17-36-07.steps.json';
let scanExprSignals;
try {
  ({ scanExprSignals } = await import('file:///D:/dsh-web-relay/lib/heartbeat-scan.js'));
} catch (e) {
  console.error('  import 失败（A2 可能正在改该文件）：' + String(e && e.message).slice(0, 120));
  process.exit(2);
}

const real = JSON.parse(fs.readFileSync(STEPS_FILE, 'utf8'));
const now = Date.now();
const MIN = 60000;
const clone = () => JSON.parse(JSON.stringify(real));

let pass = 0; const fails = [];
const T = (name, cond, extra = '') => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const sig = (st, opts) => scanExprSignals(st, { now, ...opts });

console.log(`  真实 expr: ${real.exprId} | steps=${real.steps.length} | status=${real.status} | finalized=${real.finalized}`);

// ① 真实终态（finalized）→ 归档守卫生效，必须 0 信号（否则会在已收口任务上误报）
{
  const r = sig(clone());
  T('① 已 finalized 的真实 expr → 0 信号（archived 守卫）', r.signals.length === 0, JSON.stringify(r.signals));
}

// ② 复现事故形状：未收口 + step7 pending + 依赖(6)已 approved + 40 分钟无写入 → 必须报 unclaimed-pending
{
  const st = clone();
  st.status = 'executing'; st.finalized = false;
  st.steps.forEach((s) => { if (s.status === 'approved' && s.id !== '7') s.status = 'approved'; });
  st.steps.find((s) => String(s.id) === '7').status = 'pending';
  st.updatedAt = new Date(now - 40 * MIN).toISOString();
  const r = sig(st);
  T('② 事故形状（step7 可执行且超龄）→ 报 unclaimed-pending', r.signals.includes('unclaimed-pending'), JSON.stringify(r.signals));
  const d = r.detail.find((x) => x.includes('无人认领')) || '';
  T('② detail 含 step7 标识与「没人会去做」指引', d.includes('Step 7') && /链条|调度/.test(d), d.slice(0, 80));
}

// ③ 同形状但只过了 5 分钟 → 不应报（阈值生效）
{
  const st = clone();
  st.status = 'executing'; st.finalized = false;
  st.steps.find((s) => String(s.id) === '7').status = 'pending';
  st.updatedAt = new Date(now - 5 * MIN).toISOString();
  const r = sig(st);
  T('③ 未超阈值 → 不报 unclaimed-pending', !r.signals.includes('unclaimed-pending'), JSON.stringify(r.signals));
}

// ④ 全部 approved 但未收口 → 只报 finalize-pending，不得被 unclaimed-pending 吞并（真实形状上再验一次）
{
  const st = clone();
  st.status = 'executing'; st.finalized = false;
  st.updatedAt = new Date(now - 40 * MIN).toISOString();
  const r = sig(st);
  T('④ 全 approved → 报 finalize-pending', r.signals.includes('finalize-pending'), JSON.stringify(r.signals));
  T('④ 全 approved → 不报 unclaimed-pending（不吞并）', !r.signals.includes('unclaimed-pending'), JSON.stringify(r.signals));
}

// ⑤ 依赖链：step7 依赖 6，若 6 未 approved 则 step7 不算可执行
{
  const st = clone();
  st.status = 'executing'; st.finalized = false;
  st.steps.find((s) => String(s.id) === '6').status = 'review';
  st.steps.find((s) => String(s.id) === '7').status = 'pending';
  st.updatedAt = new Date(now - 40 * MIN).toISOString();
  const r = sig(st);
  T('⑤ 依赖(6)未 approved → step7 不算可执行', !r.signals.includes('unclaimed-pending'), JSON.stringify(r.signals));
  T('⑤ 但 step6 处于 review → 仍报 review-pending（既有信号未被破坏）', r.signals.includes('review-pending'), JSON.stringify(r.signals));
}

// ⑥ 阈值可注入（与 A1 规格一致），且默认值确为 30 分钟
{
  const st = clone();
  st.status = 'executing'; st.finalized = false;
  st.steps.find((s) => String(s.id) === '7').status = 'pending';
  st.updatedAt = new Date(now - 5 * MIN).toISOString();
  T('⑥ 注入 unclaimedMs=60000 后 5 分钟即触发', sig(st, { unclaimedMs: 60000 }).signals.includes('unclaimed-pending'));
  T('⑥ 默认 1800000ms 下 5 分钟不触发（即默认 30min）', !sig(st).signals.includes('unclaimed-pending'));
}

// ⑦ maxAgeMs 陈旧过滤仍生效（不应把数周前的历史 expr 当待办）
{
  const st = clone();
  st.status = 'executing'; st.finalized = false;
  st.updatedAt = new Date(now - 30 * 24 * 60 * MIN).toISOString();
  st.steps.find((s) => String(s.id) === '7').status = 'pending';
  T('⑦ maxAgeMs 过滤：30 天前的 expr → 0 信号', sig(st, { maxAgeMs: 7 * 24 * 60 * MIN }).signals.length === 0);
}

console.log(`\n  RESULT: ${pass}/${pass + fails.length} ${fails.length ? 'FAIL' : 'PASS'}`);
for (const f of fails) console.log('    FAIL: ' + f);
process.exit(fails.length ? 1 : 0);
