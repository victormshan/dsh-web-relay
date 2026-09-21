// 装填验证：把调度器指向 v4 链条时，链条状态隔离（chainId 变化 → 重开）是否真的生效。
//
// 对照设计（额度无关，跑在真实 cc-tasks 目录上）：
//   修复前：v1-v3 状态被继承（index=5）→ 命中已完成守卫 → 「链条已于 … 完成，本次跳过」exit 0（永不派发）
//   修复后：检测到换链条 → 旧状态备份 → index=0 → 推进到额度门（探针后 quota-paused exit 3 或直接派发）
// 关键断言：修复前的输出**不得**出现在修复后；且修复后 chain-state.json 的 chainId 必须变成 v4-a4。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const WORK = 'D:\\dsh relay test';
const CC = 'D:\\cc-tasks';
const SRC = path.join(WORK, 'cc-chain.mjs');
const STATE = path.join(CC, 'chain-state.json');
const BACKUP = path.join(CC, 'chain-state.v1-v3.json');
const CHAIN = 'cc-chains/v4-a4.mjs';
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  ok ? pass++ : fail++;
};

const src = fs.readFileSync(SRC, 'utf8');
const pre = JSON.parse(fs.readFileSync(STATE, 'utf8'));
console.log('=== 前置：当前链条状态必须还是 v1-v3 已完成态（否则本对照无意义）===');
check(`chain-state.chainId = ${pre.chainId}`, !!pre.chainId && pre.chainId !== 'v4-a4', `实际=${pre.chainId}`);
check(`completedAt 已设置（index=${pre.index}）`, !!pre.completedAt, `completedAt=${pre.completedAt}`);
if (!pre.completedAt || pre.chainId === 'v4-a4') {
  console.log('\n前置不满足：状态已被重置，无法做 before/after 对照。请恢复 chain-state.json 后重跑。');
  process.exit(2);
}

function runCli(file, timeoutMs = 200000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file, CHAIN], { cwd: WORK });
    let out = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; p.kill(); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code: killed ? 'timeout' : code, out }); });
  });
}

// ---- 对照组：禁用状态隔离，等价于修复前行为 ----
const marker = 'if (state && state.chainId && state.chainId !== chain.id) {';
if (!src.includes(marker)) throw new Error('未找到状态隔离判断，验证脚本需与 cc-chain.mjs 同步');
const ctrlPath = path.join(WORK, '_arm-control-cc-chain.mjs');
fs.writeFileSync(ctrlPath, src.replace(marker, 'if (false) {'), 'utf8');

console.log('=== ① 修复前（禁用隔离）→ 必须空转、绝不派发 ===');
const before = fs.readFileSync(STATE, 'utf8');
const ctrl = await runCli(ctrlPath);
const ctrlSkipped = /完成，本次跳过/.test(ctrl.out);
check('输出「链条已于 … 完成，本次跳过」', ctrlSkipped, `exit=${ctrl.code} 输出尾部=${ctrl.out.trim().slice(-160)}`);
check('exit=0（静默空转，容易被误认为「已装填成功」）', ctrl.code === 0, `exit=${ctrl.code}`);
check('对照运行未改动 chain-state.json', fs.readFileSync(STATE, 'utf8') === before, '状态被改动了');
try { fs.unlinkSync(ctrlPath); } catch { /* 已删 */ }

console.log('=== ② 修复后（真实 cc-chain.mjs）→ 必须识别换链条并推进 ===');
const real = await runCli(SRC);
const swapped = /检测到换链条/.test(real.out);
const startedZero = new RegExp(`链条 v4-a4 启动，共 1 项，当前 index=0`).test(real.out);
const reachedQuotaGate = /额度不可用，暂停链条|派发:/.test(real.out);
check('识别换链条并备份旧状态', swapped, `输出=${real.out.trim().slice(0, 240)}`);
check('index 从 0 开始（未被继承为 5）', startedZero, `输出=${real.out.trim().slice(0, 240)}`);
check('推进到额度门/派发（未再被已完成守卫拦截）', reachedQuotaGate, `exit=${real.code} 输出尾部=${real.out.trim().slice(-240)}`);
check('修复后**不再**出现「完成，本次跳过」', !/完成，本次跳过/.test(real.out), '仍被守卫拦截');

console.log('=== ③ 落盘核对：状态归属已切到 v4-a4 且旧状态有备份 ===');
const post = JSON.parse(fs.readFileSync(STATE, 'utf8'));
check('chain-state.chainId = v4-a4', post.chainId === 'v4-a4', `实际=${post.chainId}`);
check('chain-state.index = 0（本链条从头开始）', post.index === 0, `实际=${post.index}`);
check('旧链条状态已备份为 chain-state.v1-v3.json', fs.existsSync(BACKUP), `缺失 ${BACKUP}`);
if (fs.existsSync(BACKUP)) {
  const b = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
  check('备份内容确为 v1-v3 完成态', b.chainId === 'v1-v3' && b.index === 5, `chainId=${b.chainId} index=${b.index}`);
}
check('v4 项已落到 quota-paused（额度耗尽时不派发）', ['quota-paused', 'waiting', 'accepted-awaiting-review'].includes(post.items?.['A4a 编码通道统计（纯逻辑层 + 有界读取器 + 用例）']?.status), `实际=${JSON.stringify(post.items)}`.slice(0, 240));

console.log(`\nRESULT: ${pass}/${pass + fail} 通过${fail ? `（${fail} 失败）` : ''}`);
process.exit(fail ? 1 : 0);
