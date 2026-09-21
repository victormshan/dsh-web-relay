// cc 通道体检：一条命令给出「守护/探活/额度/派发/失败分类」全貌（目标 (1) 端到端可验证 + 失败分类可审计）
// 用法: node cc-doctor.mjs [--json] [--heartbeat-max 60]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CC = 'D:\\cc-tasks';
const REPO = 'D:\\dsh-web-relay';
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const hbMaxIdx = args.indexOf('--heartbeat-max');
const hbMax = hbMaxIdx >= 0 ? Number(args[hbMaxIdx + 1]) : 60;

const checks = [];
const info = {};
const chk = (name, level, detail) => checks.push({ name, level, detail });

// ---- Linux 侧探针 ----
let probe = {};
const pr = spawnSync('wsl.exe', ['-e', 'bash', '/mnt/d/cc-tasks/doctor-probe.sh'], { encoding: 'utf8' });
if (pr.status === 0 || pr.stdout) {
  for (const line of String(pr.stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) probe[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
} else {
  chk('Linux 侧探针', 'FAIL', `wsl 调用失败: ${String(pr.stderr || '').slice(0, 120)}`);
}

chk('watchdog 服务运行', probe.unit_active === 'active' ? 'PASS' : 'FAIL', `ActiveState=${probe.unit_active} SubState=${probe.unit_substate} MainPID=${probe.mainpid}`);
chk('开机/登出常驻(linger)', probe.linger === 'yes' ? 'PASS' : 'WARN', `Linger=${probe.linger}（no 时登出即停）`);
chk('自愈策略', probe.restart_policy === 'always' ? 'PASS' : 'WARN', `Restart=${probe.restart_policy} RestartSec=${probe.restart_sec} NRestarts=${probe.nrestarts}（NRestarts>0 即自愈曾生效）`);
if (probe.heartbeat_present === '1') {
  const age = Number(probe.heartbeat_age_s);
  chk('心跳新鲜度', age <= hbMax ? 'PASS' : 'WARN', `watchdog.heartbeat 距今 ${probe.heartbeat_age_s}s（阈值 ${hbMax}s）`);
} else {
  chk('心跳新鲜度', 'FAIL', 'watchdog.heartbeat 不存在——ccWatchdogAlive 将走 alive-unverified 告警路径');
}
chk('心跳已装入运行脚本', Number(probe.watchdog_has_heartbeat_touch) > 0 ? 'PASS' : 'WARN', `cc-watchdog.sh 内 touch 命中 ${probe.watchdog_has_heartbeat_touch} 次`);
chk('cc 认证方式', probe.creds_file === '1' && probe.api_key_set === '0' ? 'PASS' : 'WARN', `OAuth 凭据=${probe.creds_file} ANTHROPIC_API_KEY=${probe.api_key_set === '1' ? '已设置(走 API 计费)' : '未设置(走订阅额度)'}`);
info.claudeVersion = probe.claude_version;
info.claudeProcesses = probe.claude_processes;

// ---- Windows 侧 ----
const q = fs.existsSync(path.join(CC, 'queue')) ? fs.readdirSync(path.join(CC, 'queue')).filter((f) => f.endsWith('.task.json')) : [];
info.queue = q;
const df = fs.existsSync(path.join(CC, 'deferred')) ? fs.readdirSync(path.join(CC, 'deferred')).filter((f) => f.endsWith('.task.json')) : [];
info.deferred = df;
chk('队列深度', q.length === 0 ? 'PASS' : 'WARN', `queue=${q.length}（>0 说明有任务待 watchdog 取走）`);

const qs = path.join(CC, 'cc-quota-state.json');
let quotaNote = '无记录';
if (fs.existsSync(qs)) {
  try {
    const st = JSON.parse(fs.readFileSync(qs, 'utf8'));
    info.quotaState = st;
    quotaNote = JSON.stringify(st);
    const reset = st.resetsAt ? Date.parse(st.resetsAt) : NaN;
    if (Number.isFinite(reset) && reset > Date.now()) chk('额度状态', 'WARN', `已知配额耗尽，预计 ${st.resetsAt} 前不可用`);
    else chk('额度状态', 'PASS', `有历史记录但已过重置时间: ${quotaNote}`);
  } catch { chk('额度状态', 'WARN', 'cc-quota-state.json 存在但解析失败'); }
} else chk('额度状态', 'PASS', '无耗尽记录');

// 最近任务与失败分类
const tasksDir = path.join(CC, 'tasks');
const rows = [];
if (fs.existsSync(tasksDir)) {
  for (const d of fs.readdirSync(tasksDir)) {
    const rp = path.join(tasksDir, d, 'result.json');
    if (!fs.existsSync(rp)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
      rows.push({ id: d, status: r.status, errorCode: r.errorCode || null, reason: String(r.reason || r.error || '').slice(0, 60), end: r.end || '', exit: r.exit });
    } catch { rows.push({ id: d, status: 'unparsable', errorCode: null, reason: '', end: '', exit: null }); }
  }
}
rows.sort((a, b) => String(a.end).localeCompare(String(b.end)));
const recent = rows.slice(-10);
info.recentTasks = recent;
const byCode = {};
// errorCode 分类是 2026-09-14T07:40Z 之后才有的（runner.sh s2v7 + 插件 classifyCcFailure）。
// 此前的失败没有 errorCode，不能算「分类规则缺口」——按生效时间切成 recent / legacy 两类，避免永久误报。
const sinceIdx = args.indexOf('--since');
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : '2026-09-14T07:40:00Z';
for (const r of rows) {
  if (r.status === 'done') continue;
  const code = r.errorCode || (String(r.end) >= since ? 'unclassified-recent' : 'legacy-unclassified');
  byCode[code] = (byCode[code] || 0) + 1;
}
info.failuresByCode = byCode;
info.since = since;
const unclassified = byCode['unclassified-recent'] || 0;

// 计划任务
const sch = spawnSync('schtasks.exe', ['/Query', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
const planned = String(sch.stdout || '').split('\n').filter((l) => l.includes('dsh-cc')).map((l) => l.split('","')[0].replace(/^"|"$/g, ''));
info.scheduledTasks = planned;

// git 状态
const gs = spawnSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' });
const dirty = String(gs.stdout || '').split('\n').filter(Boolean).length;
const head = (spawnSync('git', ['-C', REPO, 'log', '--oneline', '-1'], { encoding: 'utf8' }).stdout || '').trim();
info.repoHead = head;
info.repoDirty = dirty;
chk('仓库工作树', dirty === 0 ? 'PASS' : 'WARN', `改动 ${dirty} 个文件；HEAD ${head}`);

// 链条状态（cc-chain.mjs 的断点续跑进度）
const csPath = path.join(CC, 'chain-state.json');
let chainInfo = null;
if (fs.existsSync(csPath)) {
  try {
    const cs = JSON.parse(fs.readFileSync(csPath, 'utf8'));
    const items = Object.entries(cs.items || {});
    chainInfo = { chainId: cs.chainId, index: cs.index, completedAt: cs.completedAt || null, items };
    const paused = items.find(([, v]) => v.status === 'quota-paused');
    const rej = items.find(([, v]) => v.status === 'verify-rejected' || v.status === 'dispatch-failed');
    if (rej) chk('自动链条', 'FAIL', `${rej[0]} → ${rej[1].status}: ${rej[1].detail || ''}`);
    else if (paused) chk('自动链条', 'WARN', `${paused[0]} → quota-paused（等下次触发续跑）；index=${cs.index}`);
    else if (cs.completedAt) chk('自动链条', 'PASS', `已完成（${cs.completedAt}）`);
    else chk('自动链条', 'PASS', `index=${cs.index}，未暂停`);
  } catch { chk('自动链条', 'WARN', 'chain-state.json 解析失败'); }
} else chk('自动链条', 'PASS', '未启用链条');

// 计划状态（权威 steps.json）：每轮一条命令即可看全计划/链条/通道三面
const stepsPath = path.join('D:\\dsh relay test', 'web-relay', 'experiments', 'expr-2026-09-13_17-36-07.steps.json');
let planInfo = null;
if (fs.existsSync(stepsPath)) {
  try {
    const st = JSON.parse(fs.readFileSync(stepsPath, 'utf8'));
    const counted = { approved: 0, pending: 0, executing: 0, review: 0, rejected: 0 };
    for (const s of st.steps || []) counted[s.status] = (counted[s.status] || 0) + 1;
    planInfo = {
      iterations: st.iterations, currentIteration: st.currentIteration, autoDecision: st.autoDecision,
      finalAcceptance: st.finalAcceptance ? `已声明(${String(st.finalAcceptance).length}字符)` : null,
      incrementalStreak: st.incrementalStreak,
      statuses: counted,
      steps: (st.steps || []).map((s) => ({ id: s.id, status: s.status, reviewedBy: s.reviewedBy || null, title: String(s.title || '').slice(0, 30) })),
    };
    const approved = counted.approved || 0;
    chk('计划进度', approved === 0 ? 'WARN' : 'PASS', `approved=${approved}/${(st.steps || []).length}；iterations=${st.iterations} autoDecision=${st.autoDecision} finalAcceptance=${planInfo.finalAcceptance || 'null'}`);
  } catch { chk('计划状态', 'WARN', 'steps.json 解析失败'); }
} else chk('计划状态', 'WARN', 'steps.json 不存在');

if (asJson) {
  const payload = JSON.stringify({ checks, info, chain: chainInfo }, null, 2);
  const outIdx = args.indexOf('--out');
  if (outIdx >= 0 && args[outIdx + 1]) {
    // 由 node 直接写文件（UTF-8 无 BOM）——避免经 PowerShell 管道/重定向时被插入 BOM 而破坏 JSON 消费方
    fs.writeFileSync(args[outIdx + 1], payload, 'utf8');
    console.log(`  已写出 JSON: ${args[outIdx + 1]}（${Buffer.byteLength(payload, 'utf8')} 字节，无 BOM）`);
  } else {
    console.log(payload);
  }
} else {
  console.log('=== cc 通道体检 ===\n');
  const icon = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' };
  for (const c of checks) console.log(`  [${icon[c.level]}] ${c.name} — ${c.detail}`);
  console.log('\n  最近任务（末尾 10 条）:');
  for (const r of recent) console.log(`    ${r.id.padEnd(28)} ${String(r.status).padEnd(7)} ${(r.errorCode || '-').padEnd(22)} exit=${r.exit} ${r.reason}`);
  console.log('\n  失败分类计数:', Object.keys(byCode).length ? JSON.stringify(byCode) : '(无失败)');
  if (unclassified) console.log(`  ⚠ 分类生效（${since}）后仍有 ${unclassified} 条失败未分类——规则需补齐`);
  else console.log(`  分类覆盖: 生效后（${since}）的失败均已分类；legacy-unclassified 为分类上线前的历史记录`);
  console.log(`  计划任务: ${planned.join(', ') || '(无)'}`);
  if (chainInfo) {
    console.log(`  自动链条: ${chainInfo.chainId} index=${chainInfo.index}${chainInfo.completedAt ? ' 完成于 ' + chainInfo.completedAt : ''}`);
    for (const [label, v] of chainInfo.items) console.log(`    - ${label}: ${v.status}${v.commit?.sha ? ' @' + v.commit.sha : ''}`);
  }
  if (planInfo) {
    console.log(`  计划: ${planInfo.steps.filter((s) => s.status === 'approved').length}/${planInfo.steps.length} approved | iterations=${planInfo.iterations} autoDecision=${planInfo.autoDecision} finalAcceptance=${planInfo.finalAcceptance || 'null'} streak=${planInfo.incrementalStreak}`);
    for (const s of planInfo.steps) console.log(`    [${s.id}] ${s.status.padEnd(9)} ${(s.reviewedBy || '-').padEnd(9)} ${s.title}`);
  }
  console.log(`  deferred 待派发: ${df.join(', ') || '(无)'} | queue: ${q.join(', ') || '(空)'}`);
  console.log(`  claude: ${info.claudeVersion} | 进程 ${info.claudeProcesses}`);
}
const fails = checks.filter((c) => c.level === 'FAIL').length;
console.log(`\n  RESULT: ${fails ? `${fails} 项 FAIL` : '全部通过（含 WARN 提示）'}`);
process.exit(fails ? 1 : 0);
