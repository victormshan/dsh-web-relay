// 把 runner.sh 的额度判据**桥接到唯一模块**（此前只是放宽了它自己的正则 —— 那仍是第五份判据）。
// 桥接方式：调 `node "<canonical>/quota-classify.mjs" "<日志文本>"`，按输出 limited=true 判定。
// 失败方向：桥不可用（node/模块缺失）→ 打醒目告警并**按"非配额"继续**（可预测，且告警会暴露断裂）；
// 绝不在桥失败时悄悄用本文件里另写的一份判据兜底 —— 那正是要根除的漂移源。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const P = 'D:\\cc-tasks\\runner.sh';
const CANON = '/mnt/d/dsh relay test/quota-classify.mjs';
let s = fs.readFileSync(P, 'utf8');
const before = s.length;

const OLD = "  elif printf '%s' \"$LOGTXT\" | grep -qiE 'session[[:space:]]*limit|rate[[:space:]]*limit|weekly[[:space:]]*limit|usage[[:space:]]*limit|hit your .*limit|quota'; then ERRCODE=\"cc-quota-exhausted\"";
const NEW = [
  '  elif printf \'%s\' "$LOGTXT" | grep -qE "$(', '\\', ')"> /dev/null; then ERRCODE="cc-quota-exhausted"',
].join('\n');

// 用更清晰的实现：先桥接取判定，再据此分支
const BLOCK = [
  '  # 额度判定**桥接到唯一模块**（2026-09-19，收敛第五处副本）：不再在本文件里维护一份限额正则。',
  '  # 桥不可用（node 缺失/模块缺失）→ 醒目告警并**按非配额继续**（可预测；绝不用本文件另写的判据兜底，那正是漂移源）。',
  `  QUOTA_CLS=$(node "${CANON}" "$LOGTXT" 2>/dev/null || true)`,
  '  if [ -z "$QUOTA_CLS" ]; then',
  '    echo "[runner] WARN 额度判定桥不可用（node 或唯一模块缺失）：按非配额继续，请检查 ' + CANON + '" >> "$TD/runner.log" 2>&1 || true',
  '  fi',
  '  if [ $CC_EXIT -eq 124 ]; then ERRCODE="cc-timeout"',
  '  elif printf \'%s\' "$QUOTA_CLS" | grep -q \'limited=true\'; then ERRCODE="cc-quota-exhausted"',
].join('\n');

if (s.includes('quota-classify.mjs')) {
  console.log('已桥接（幂等跳过）');
} else {
  // 1) 在 "if [ $CC_EXIT -eq 124 ]; then ERRCODE=..." 之前插入桥接块，并把额度那一条 elif 换掉
  const anchor = '  if [ $CC_EXIT -eq 124 ]; then ERRCODE="cc-timeout"';
  if (!s.includes(anchor)) { console.error('✗ 找不到 CC_EXIT 锚点'); process.exit(1); }
  if (!s.includes(OLD)) { console.error('✗ 找不到旧的额度 elif（可能已被改）'); process.exit(1); }
  const bak = `${P}.bak-prebridge-${Date.now()}`;
  fs.writeFileSync(bak, s, 'utf8');
  s = s.replace(OLD, '');                       // 去掉那条自带判据（含换行处理见后）
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(anchor, BLOCK);
  fs.writeFileSync(P, s, 'utf8');
  console.log(`已桥接；备份 → ${bak}`);
}

const out = fs.readFileSync(P, 'utf8');
const problems = [];
if (!out.includes('quota-classify.mjs')) problems.push('未桥接唯一模块');
if (/grep -qiE 'session\[\[:space:\]\]\*limit/.test(out)) problems.push('自带判据仍在');
if (!/limited=true/.test(out)) problems.push('未见桥接判定分支');
if (out.length < before - 500) problems.push(`体量异常塌缩：${before} → ${out.length}`);
const chk = spawnSync('wsl.exe', ['-e', 'bash', '-n', '/mnt/d/cc-tasks/runner.sh'], { encoding: 'utf8' });
if (chk.status !== 0) problems.push(`bash -n 失败：${(chk.stderr || '').trim().slice(0, 200)}`);
if (problems.length) { console.error('✗ 后置断言失败：\n- ' + problems.join('\n- ')); process.exit(1); }
console.log(`✓ 后置断言通过（bash -n 通过；体量 ${before} → ${out.length}）`);

// 功能验证：桥接后的判定对真实文案必须为真、对普通输出必须为假（同一 CLI，两边都测）
const cli = (t) => spawnSync('wsl.exe', ['-e', 'bash', '-lc', `node "${CANON}" ${JSON.stringify(t)}`], { encoding: 'utf8' }).stdout || '';
const w = cli("You've hit your weekly limit · resets 2am (Asia/Shanghai)");
const n = cli('all tests passed');
const okW = /limited=true/.test(w) && /kind=weekly/.test(w);
const okN = /limited=false/.test(n);
console.log(`  ${okW ? 'PASS' : 'FAIL'}  weekly 文案经桥 → ${w.trim()}`);
console.log(`  ${okN ? 'PASS' : 'FAIL'}  普通输出经桥 → ${n.trim()}`);
process.exit(okW && okN ? 0 : 1);
