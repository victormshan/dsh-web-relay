#!/usr/bin/env node
// 修 runner.sh 的额度判据：只认 session/rate/quota → 漏掉本机真实文案 "You've hit your weekly limit"。
// 后果：weekly 限额导致的失败被误分类（非 cc-quota-exhausted）→ ccChainStats 失败归因错、
// 不写 cc-quota-state.json、插件侧"已知耗尽不盲等"短路失效。
// 约束：runner.sh 在 WSL 里由 bash 执行；改动后必须 bash -n 通过，且新判据要对真实文案与旧文案都命中。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const P = 'D:\\cc-tasks\\runner.sh';
const from = "grep -qi 'session limit\\|rate limit\\|quota'";
const to = "grep -qiE 'session[[:space:]]*limit|rate[[:space:]]*limit|weekly[[:space:]]*limit|usage[[:space:]]*limit|hit your .*limit|quota'";

const before = fs.readFileSync(P, 'utf8');
if (before.includes('weekly[[:space:]]*limit')) {
  console.log('已包含新判据（幂等跳过）');
} else {
  if (!before.includes(from)) { console.error('✗ 找不到待替换的旧判据，拒绝盲改'); process.exit(1); }
  const bak = `${P}.bak-prequota-${Date.now()}`;
  fs.writeFileSync(bak, before, 'utf8');
  fs.writeFileSync(P, before.replace(from, to), 'utf8');
  console.log(`已替换判据；备份 → ${bak}`);
}

const s = fs.readFileSync(P, 'utf8');
const problems = [];
if (!s.includes('weekly[[:space:]]*limit')) problems.push('新判据未写入');
if (s.includes(from)) problems.push('旧判据仍在');
if (s.length < before.length - 200) problems.push(`体量塌缩：${before.length} → ${s.length}`);
// bash 语法检查（WSL 侧）
const chk = spawnSync('wsl.exe', ['-e', 'bash', '-n', '/mnt/d/cc-tasks/runner.sh'], { encoding: 'utf8' });
if (chk.status !== 0) problems.push(`bash -n 失败：${(chk.stderr || '').trim().slice(0, 200)}`);
if (problems.length) { console.error('✗ 后置断言失败：\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('✓ 后置断言通过（bash -n 通过、旧判据已替换、体量正常）');

// 功能验证：新判据对"真实 weekly 文案"必须命中；对普通日志必须不命中
const pat = "session[[:space:]]*limit|rate[[:space:]]*limit|weekly[[:space:]]*limit|usage[[:space:]]*limit|hit your .*limit|quota";
const tryMatch = (text) => spawnSync('wsl.exe', ['-e', 'bash', '-lc', `printf '%s' ${JSON.stringify(text)} | grep -qiE '${pat}'`], { encoding: 'utf8' }).status === 0;
const cases = [
  ["You've hit your weekly limit · resets 2am (Asia/Shanghai)", true],
  ["You've hit your session limit · resets 7am (Asia/Shanghai)", true],
  ['rate limit reached', true],
  ['Weekly Limit reached', true],
  ['all good, tests passed', false],
  ['error: cannot find module', false],
];
let ok = true;
for (const [text, want] of cases) {
  const got = tryMatch(text);
  if (got !== want) ok = false;
  console.log(`  ${got === want ? 'PASS' : 'FAIL'}  命中=${got}（期望 ${want}）← ${text.slice(0, 50)}`);
}
console.log(ok ? '\nRESULT: PASS' : '\nRESULT: FAIL');
process.exit(ok ? 0 : 1);
