// 把第五处（deferred-dispatch.ps1）的额度判据改为**桥接唯一模块**，不再自带一份正则。
// 背景：该脚本休眠（最后使用 2026-09-14，deferred/ 目录已不存在），但它仍携带着第三份旧判据；
// 一旦有人在 weekly-limit 窗口里跑它，日志会显示 limit=False（误导），且它是第五处漂移源。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const P = 'D:\\cc-tasks\\deferred-dispatch.ps1';
let s = fs.readFileSync(P, 'utf8');
const before = s.length;

const OLD = "  $isLimit = $flat -match 'session limit|rate limit|quota'";
const NEW = [
  '  # 判据桥接到唯一模块（2026-09-19）：不再自带正则，避免"同一判断五处实现"再次漂移。',
  '  $cls = ((& node "D:\\dsh relay test\\quota-classify.mjs" $flat) -join \' \')',
  '  $isLimit = $cls -match \'limited=true\'',
].join('\r\n');

if (s.includes('quota-classify.mjs')) {
  console.log('已桥接（幂等跳过）');
} else {
  if (!s.includes(OLD.replace(/\r?\n/g, '\n')) && !s.includes(OLD)) { console.error('✗ 找不到旧判据行，拒绝盲改'); process.exit(1); }
  const bak = `${P}.bak-prequota-${Date.now()}`;
  fs.writeFileSync(bak, s, 'utf8');
  s = s.replace(OLD, NEW);
  fs.writeFileSync(P, s, 'utf8');
  console.log(`已桥接；备份 → ${bak}`);
}

const out = fs.readFileSync(P, 'utf8');
const problems = [];
if (!out.includes('quota-classify.mjs')) problems.push('未桥接唯一模块');
if (/-match 'session limit\|rate limit\|quota'/.test(out)) problems.push('旧正则仍在');
if (out.length <= before) problems.push(`体量未增（可能没改）：${before} → ${out.length}`);
// PowerShell 语法自检（用官方解析器，比"跑一遍"安全：该脚本会 sleep 20 分钟）
const chk = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile('${P}',[ref]$t,[ref]$e)|Out-Null; if($e.Count -gt 0){ $e | ForEach-Object { $_.Message } ; exit 1 } else { 'parse-ok' }`],
  { encoding: 'utf8' });
const chkOut = `${chk.stdout || ''}${chk.stderr || ''}`.trim();
if (!/parse-ok/.test(chkOut)) problems.push(`PowerShell 解析失败：${chkOut.slice(0, 200)}`);
if (problems.length) { console.error('✗ 后置断言失败：\n- ' + problems.join('\n- ')); process.exit(1); }
console.log(`✓ 后置断言通过（体量 ${before} → ${out.length}；PowerShell 解析器通过）`);
console.log('--- 改动后 ---');
console.log(out.split('\n').filter((l) => /isLimit|cls|quota-classify/.test(l)).map((l) => l.trim()).join('\n'));
