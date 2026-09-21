// phase 2 收尾：把 deferred-dispatch.ps1 的桥改指无空格 shim，并删除我这侧的副本 quota-classify.mjs。
// 后置断言：shim 调用生效、旧路径不再被引用、被删文件确实消失、其余引用者（链条）已改指仓库模块。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const PS = 'D:\\cc-tasks\\deferred-dispatch.ps1';
const MINE = 'D:\\dsh relay test\\quota-classify.mjs';
const CHAIN = 'D:\\dsh relay test\\cc-chain.mjs';
const problems = [];

// 1) PS 改指 shim
let ps = fs.readFileSync(PS, 'utf8');
if (ps.includes('quota-classify-cli.mjs')) {
  console.log('PS 已指向 shim（幂等跳过）');
} else {
  const OLD = '& node "D:\\dsh relay test\\quota-classify.mjs" $flat';
  if (!ps.includes(OLD)) { console.error('✗ PS 里找不到旧调用'); process.exit(1); }
  fs.writeFileSync(`${PS}.bak-phase2-${Date.now()}`, ps, 'utf8');
  ps = ps.replace(OLD, '& node "D:\\cc-tasks\\quota-classify-cli.mjs" $flat');
  fs.writeFileSync(PS, ps, 'utf8');
  console.log('PS 已改指 shim');
}
const psOut = fs.readFileSync(PS, 'utf8');
if (!psOut.includes('quota-classify-cli.mjs')) problems.push('PS 未改指 shim');
if (psOut.includes('dsh relay test')) problems.push('PS 仍引用含空格的工作区路径');
const parse = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile('${PS}',[ref]$t,[ref]$e)|Out-Null; if($e.Count -gt 0){ $e|ForEach-Object{$_.Message}; exit 1 } else { 'parse-ok' }`], { encoding: 'utf8' });
if (!/parse-ok/.test(`${parse.stdout || ''}`)) problems.push('PS 解析失败');

// 2) 删除我这侧的副本（其判据已完全由仓库模块承担）
if (fs.existsSync(MINE)) {
  fs.writeFileSync(`${MINE}.bak-phase2`, fs.readFileSync(MINE), 'utf8');
  fs.rmSync(MINE);
  console.log('已删除工作区副本（留 .bak-phase2 备查）');
} else console.log('副本已不存在（幂等）');
if (fs.existsSync(MINE)) problems.push('副本仍存在');

// 3) 链条必须已改指仓库模块
const chain = fs.readFileSync(CHAIN, 'utf8');
if (!chain.includes('lib/quota-parser.mjs')) problems.push('链条未指向仓库唯一模块');
if (chain.includes("from './quota-classify.mjs'")) problems.push('链条仍 import 已删除的副本');

// 4) 链条自测（走仓库模块）
const t = spawnSync(process.execPath, [CHAIN, '--selftest-quota'], { encoding: 'utf8', timeout: 120000 });
if (t.status !== 0) problems.push(`链条自测失败：${(t.stdout || '').split('\n').slice(-3).join(' | ')}`);

if (problems.length) { console.error('✗ 后置断言失败：\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('✓ 后置断言通过：PS→shim→仓库模块；工作区副本已删；链条自测通过');
