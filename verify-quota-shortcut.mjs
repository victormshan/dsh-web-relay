// 验证「探针落盘恢复时刻 → 后续触发短路」这条修复真的生效（2026-09-16 补）
// 必须证明：① 首次探针确实写入 quotaResetsAt ② 第二次触发走短路分支、不再探针
//          ③ 诊断模式（--selftest-quota / --probe-only）不产生状态副作用（不换链条、不写多余备份）
//
// 注意（本轮踩到的坑）：不能用「耗时 > 10s」当「探针跑过」的判据 —— 额度已耗尽时
// `claude -p` 会立刻回限额文案（实测 5.0s），探针很快也会返回。判据必须是**走了哪个分支**。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const WORK = 'D:\\dsh relay test';
const CC = 'D:\\cc-tasks';
const STATE = path.join(CC, 'chain-state.json');
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  ok ? pass++ : fail++;
};

function runCli(argv, timeoutMs = 200000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, argv, { cwd: WORK });
    let out = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; p.kill(); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code: killed ? 'timeout' : code, out, ms: Date.now() - t0 }); });
  });
}
const backups = () => fs.readdirSync(CC).filter((f) => /^chain-state\..+\.json$/.test(f)).sort().join(',');
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));

// 前置：确保断言起点确定（本脚本可重复运行）
const s0 = readState();
check('chainId = v4-a4（已装填的目标链条）', s0.chainId === 'v4-a4', `实际=${s0.chainId}`);
if (s0.chainId !== 'v4-a4') { console.log('前置不满足，终止'); process.exit(2); }
s0.quotaResetsAt = null;
fs.writeFileSync(STATE, JSON.stringify(s0, null, 2), 'utf8');

console.log('=== ① 首次触发：走探针分支并把恢复时刻落盘 ===');
const r1 = await runCli(['cc-chain.mjs', 'cc-chains/v4-a4.mjs']);
check('未走短路分支（说明真的探针了）', !/已知额度耗尽/.test(r1.out), `输出=${r1.out.trim().slice(-260)}`);
check('日志出现「探针确认额度耗尽，记录恢复时刻」', /探针确认额度耗尽/.test(r1.out), `输出=${r1.out.trim().slice(-260)}`);
const stored1 = readState().quotaResetsAt;
check('chain-state.quotaResetsAt 已落盘', !!stored1, `实际=${stored1}`);
if (stored1) {
  const dt = Date.parse(stored1) - Date.now();
  check('恢复时刻在未来且在 ≤6h 短路窗口内', dt > 0 && dt <= 6 * 3600 * 1000, `距现在 ${(dt / 3600000).toFixed(2)}h`);
}
check('额度耗尽时未派发任务', !/\[queued\]/.test(r1.out), '出现了派发');

console.log('=== ② 二次触发：必须走短路分支、不再探针 ===');
const r2 = await runCli(['cc-chain.mjs', 'cc-chains/v4-a4.mjs']);
check('日志出现「已知额度耗尽…短路」', /已知额度耗尽/.test(r2.out), `输出=${r2.out.trim().slice(-260)}`);
check('未再出现探针落盘记录（本次没探针）', !/探针确认额度耗尽/.test(r2.out), `耗时 ${(r2.ms / 1000).toFixed(1)}s`);
check('耗时显著低于首次', r2.ms < r1.ms / 2, `首次 ${(r1.ms / 1000).toFixed(1)}s → 二次 ${(r2.ms / 1000).toFixed(1)}s`);
check('未派发任务', !/\[queued\]/.test(r2.out), '出现了派发');

console.log('=== ③ 短路路径未破坏状态 ===');
const post = readState();
check('chainId 仍为 v4-a4', post.chainId === 'v4-a4', `实际=${post.chainId}`);
check('quotaResetsAt 未被改早（只向后推进）', post.quotaResetsAt === stored1, `实际=${post.quotaResetsAt}`);

console.log('=== ④ 诊断模式不得有状态副作用（本轮新修）===');
const bBefore = backups();
const idBefore = `${post.chainId}|${post.index}`;
const d1 = await runCli(['cc-chain.mjs', '--selftest-quota']);
check('--selftest-quota 退出码 0', d1.code === 0, `exit=${d1.code}`);
check('--selftest-quota 不触发换链条', !/检测到换链条/.test(d1.out), `输出=${d1.out.trim().slice(0, 200)}`);
check('--selftest-quota 后 chainId/index 未变', `${readState().chainId}|${readState().index}` === idBefore, `实际=${readState().chainId}|${readState().index}`);
check('--selftest-quota 未新增备份文件', backups() === bBefore, `${bBefore} → ${backups()}`);

const d2 = await runCli(['cc-chain.mjs', '--probe-only']);
check('--probe-only 不触发换链条', !/检测到换链条/.test(d2.out), `输出=${d2.out.trim().slice(0, 200)}`);
check('--probe-only 后 chainId/index 未变', `${readState().chainId}|${readState().index}` === idBefore, `实际=${readState().chainId}|${readState().index}`);
check('--probe-only 未新增备份文件', backups() === bBefore, `${bBefore} → ${backups()}`);

console.log(`\nRESULT: ${pass}/${pass + fail} 通过${fail ? `（${fail} 失败）` : ''}`);
process.exit(fail ? 1 : 0);
