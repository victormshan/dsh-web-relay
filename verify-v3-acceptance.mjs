// V3 终验证据包（计划第 7 步，主 agent 步）：按 V3-2 的 7 条清单机械核对 → 输出 V3_GATE=PASS|BLOCKED
// 用法: node verify-v3-acceptance.mjs [--write]
// 与收口器的约定：证据包内含 `V3_GATE=PASS|BLOCKED`，protocol-close-step.mjs 7 --evidence-file 会据此硬判定。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = 'D:\\dsh-web-relay';
const WORK = 'D:\\dsh relay test';
const RELAY = 'http://127.0.0.1:3080/dsh-web-relay';
const stepsPath = path.join(WORK, 'web-relay', 'experiments', 'expr-2026-09-13_17-36-07.steps.json');
const TRACE = path.join(WORK, 'web-relay', 'traces', 'expr-2026-09-13_17-36-07.md');
const out = [];
const line = (s) => { out.push(s); console.log('  ' + s); };
const reasons = [];

// ---- ① 全量测试 ----
const files = fs.readdirSync(path.join(REPO, 'test')).filter((f) => f.endsWith('.test.js') || f.endsWith('.test.mjs')).map((f) => path.join(REPO, 'test', f));
const jsFiles = files.filter((f) => f.endsWith('.test.js'));
const runTap = (list) => {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...list], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tap = String(r.stdout || '') + String(r.stderr || '');
  const pick = (k) => { const m = tap.match(new RegExp(`^# ${k} (\\d+)$`, 'm')); return m ? Number(m[1]) : -1; };
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail'), notok: [...tap.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()).slice(0, 8) };
};
const all = runTap(files);
const js = runTap(jsFiles);
line(`① 全量测试: tests=${all.tests} pass=${all.pass} fail=${all.fail} | *.test.js 子集 tests=${js.tests} pass=${js.pass} fail=${js.fail}`);
if (all.fail !== 0) reasons.push(`全量测试有 ${all.fail} 个失败`);
if (js.fail !== 0) reasons.push(`*.test.js 子集有 ${js.fail} 个失败`);

// ---- ② 步骤状态 ----
const st = JSON.parse(fs.readFileSync(stepsPath, 'utf8'));
const ccSteps = ['1', '2', '4', '5', '6'];
// 步骤 3＝V1 版间门（主 agent 步，须 approved）；步骤 7＝**本次要收口的终验本身**，
// 不能要求它「收口前已 approved」（否则永久 BLOCKED——2026-09-15 实测踩到这个循环依赖）。
const agentSteps = ['3'];
const selfStep = '7';
const statusOf = (id) => (st.steps.find((s) => String(s.id) === id) || {}).status || '缺失';
line(`② 步骤状态: ${st.steps.map((s) => `${s.id}:${s.status}`).join(' ')}（${selfStep} 为本次收口对象，不计入前置）`);
const ccUnapproved = ccSteps.filter((id) => statusOf(id) !== 'approved');
const agentUnapproved = agentSteps.filter((id) => statusOf(id) !== 'approved');
if (ccUnapproved.length) reasons.push(`cc 步骤未 approved: [${ccUnapproved.join(',')}]`);
if (agentUnapproved.length) reasons.push(`主 agent 步骤未 approved: [${agentUnapproved.join(',')}]`);

// ---- ③ 版间门记录 ----
const gateNotes = [];
for (const id of ['3', '7']) {
  const s = st.steps.find((x) => String(x.id) === id);
  const notes = (s && s.notes) || [];
  gateNotes.push(`${id}:${statusOf(id)}${notes.length ? '（notes=' + notes.length + '）' : ''}`);
}
line(`③ 版间门/终验记录: ${gateNotes.join(' | ')} | incrementalStreak=${st.incrementalStreak} currentIteration=${st.currentIteration}`);
if (Number(st.incrementalStreak) >= 3) reasons.push(`incrementalStreak=${st.incrementalStreak} 达阈值，须已补齐 breakthroughBlocked 记录`);

// ---- ④ finalAcceptance ----
const fa = st.finalAcceptance;
line(`④ finalAcceptance: ${fa ? `已声明（${String(fa).length} 字符）` : 'null'}`);
if (!fa) reasons.push('finalAcceptance 未声明（终验硬条件之一）');

// ---- ⑤ cc 通道四项可靠性 ----
let hc = null;
try {
  const r = await fetch(`${RELAY}/health-check`);
  hc = await r.json();
} catch (e) { reasons.push(`/health-check 不可达: ${e.message}`); }
let probe = {};
const pr = spawnSync('wsl.exe', ['-e', 'bash', '/mnt/d/cc-tasks/doctor-probe.sh'], { encoding: 'utf8' });
for (const l of String(pr.stdout || '').split('\n')) { const i = l.indexOf('='); if (i > 0) probe[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
line(`⑤ cc 通道: unit=${probe.unit_active} linger=${probe.linger} restart=${probe.restart_policy} heartbeat=${probe.heartbeat_age_s}s 已装入=${probe.watchdog_has_touch || probe.watchdog_has_heartbeat_touch} | /health-check ccWatchdogWarning=${JSON.stringify(hc && hc.ccWatchdogWarning)} bootId=${hc && hc.bootId}`);
if (probe.unit_active !== 'active') reasons.push('watchdog 服务非 active');
if (probe.linger !== 'yes') reasons.push('linger 未开启');
if (!(Number(probe.heartbeat_age_s) <= 60)) reasons.push(`心跳不新鲜（${probe.heartbeat_age_s}s）`);
if (hc && !('ccWatchdogWarning' in hc)) reasons.push('运行中宿主未加载新代码（/health-check 缺 ccWatchdogWarning 字段）');

// ---- ⑥ 文档一致性 ----
// 注意：spawnSync 跑 `node <缺失文件>` 会返回 status=1 且**没有 error 字段**（node 自身启动成功、内部报错），
// 因此不能靠 error.code==='ENOENT' 判断「脚本不存在」——必须先 fs.existsSync（2026-09-15 实测踩到该误判）。
const syncScript = path.join(REPO, 'scripts', 'sync-engine-docs.mjs');
if (!fs.existsSync(syncScript)) {
  line('⑥ 文档一致性: scripts/sync-engine-docs.mjs 不存在 → V3-1 未落地');
  reasons.push('scripts/sync-engine-docs.mjs 不存在（V3-1 未落地）');
} else {
  const sc = spawnSync(process.execPath, [syncScript, '--check'], { encoding: 'utf8' });
  const scOut = (String(sc.stdout || '') + String(sc.stderr || '')).trim().split('\n');
  line(`⑥ 文档一致性: sync-engine-docs --check exit=${sc.status} ${(scOut.slice(-1)[0] || '').slice(0, 120)}`);
  if (sc.status !== 0) reasons.push('文档与引擎存在漂移（sync-engine-docs --check 非 0）');
}

// ---- ⑦ 轨迹完整性 ----
const traceText = fs.readFileSync(TRACE, 'utf8');
const marks = ['V1 Step 0 建模', 'V2 Step 0 建模', 'V3 Step 0 建模'];
const have = marks.filter((m) => traceText.includes(m));
const lessons = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'main-agent-lessons.json'), 'utf8')).lessons.length;
line(`⑦ 轨迹: ${traceText.split('\n').length} 行 | 三代 Step 0 = ${have.length}/3 | 教训库 ${lessons} 条`);
if (have.length !== 3) reasons.push(`轨迹缺 Step 0 建模（有 ${have.length}/3）`);

// ---- 判定 ----
const gate = reasons.length === 0 ? 'PASS' : 'BLOCKED';
line('');
line(`V3 终验判定: ${gate}`);
if (reasons.length) for (const r of reasons) line(`  - 未满足: ${r}`);

const bundle = out.join('\n') + `\nV3_GATE=${gate}\n`;
if (process.argv.includes('--write')) {
  const p = path.join(WORK, '_v3-acceptance-bundle.txt');
  fs.writeFileSync(p, bundle, 'utf8');
  console.log(`  已写出 ${p}（${Buffer.byteLength(bundle, 'utf8')} 字节，含 V3_GATE=${gate}）`);
}
process.exit(gate === 'PASS' ? 0 : 1);
