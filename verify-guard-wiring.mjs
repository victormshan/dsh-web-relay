// 乐观检测**接线**的两侧验证（② 的验收）：证明 `--guard` 真的在**任何落盘之前**拦住。
//
// 为什么交付用 dry-run 测：`deliver-three-copies.mjs` 不加 `--apply` 就不写盘，而 `--guard` 检查在
// **落盘分支之前**执行 —— 所以 dry-run 足以证明"拒绝发生在交付循环之前"，且探针本身零副作用（可进周期门禁）。
// 为什么重启只做**静态**接线断言：行为测试需要**真的请求一次重启**（副作用！），不值得为了测它重启宿主
// ——与 runbook "触发型工具必须标注副作用" 同一取舍。
//
// 用法: node verify-guard-wiring.mjs [--selftest]   # 默认即执行全部用例；--selftest 等价（供门禁统一调用）
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { recordGuard, readGuard, GUARD_DIR } from './optimistic-guard.mjs';

const WORK = 'D:\\dsh relay test';
const results = [];
const ck = (label, cond, detail = '') => { results.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: WORK, encoding: 'utf8', timeout: 120000 });
const outOf = (r) => `${r.stdout || ''}${r.stderr || ''}`;

const FRESH = '__probe-guard-fresh';
const STALE = '__probe-guard-stale';
const stalePath = `${GUARD_DIR}\\${STALE}.json`;

console.log('=== ① deliver-three-copies.mjs：--guard 是否真在落盘前拦住（dry-run 测，零副作用）===');
// 基线：不加 --guard → 应正常走完（证明加了检查没破坏原路径）
const r0 = run('deliver-three-copies.mjs', []);
ck('[POS] 不带 --guard → 正常走完（含"汇总"行）', r0.status === 0 && /\[deliver\] 汇总/.test(outOf(r0)), `exit=${r0.status}`);

// 新记录 → 放行
recordGuard(FRESH);
const r1 = run('deliver-three-copies.mjs', ['--guard', FRESH]);
ck('[POS] --guard <新鲜记录> → 放行并继续交付', r1.status === 0 && /未变动/.test(outOf(r1)) && /\[deliver\] 汇总/.test(outOf(r1)), `exit=${r1.status}`);

// 无记录 → 未验证(4)，且**不得**继续
const r2 = run('deliver-three-copies.mjs', ['--guard', '__probe-guard-not-exist']);
ck('[NEG] --guard <无记录> → 4 未验证，且**不发生交付**（无"汇总"行）',
  r2.status === 4 && /无记录/.test(outOf(r2)) && !/\[deliver\] 汇总/.test(outOf(r2)), `exit=${r2.status}`);

// 伪造一条"已变动"的记录（改哈希）→ 拒绝(1)，且不得继续
const g = readGuard(FRESH);
if (g) {
  fs.writeFileSync(stalePath, JSON.stringify({ ...g, name: STALE, workspace: { ...g.workspace, filesHash: 'deadbeefdeadbeef' } }, null, 2), 'utf8');
  const r3 = run('deliver-three-copies.mjs', ['--guard', STALE]);
  ck('[NEG] --guard <已变动> → 1 拒绝，且**不发生交付**（无"汇总"行）+ 列出变化',
    r3.status === 1 && /已变动/.test(outOf(r3)) && /活工具链内容变化/.test(outOf(r3)) && !/\[deliver\] 汇总/.test(outOf(r3)), `exit=${r3.status}`);
  try { fs.unlinkSync(stalePath); } catch { /* 忽略 */ }
} else ck('[NEG] --guard <已变动> → 1 拒绝', false, '无法构造夹具（工具错误）');
try { fs.unlinkSync(`${GUARD_DIR}\\${FRESH}.json`); } catch { /* 忽略 */ }

console.log('\n=== ② restart-with-checklist.mjs：静态接线断言（不真跑——它会请求重启）===');
{
  let txt = '';
  try { txt = fs.readFileSync('restart-with-checklist.mjs', 'utf8'); } catch { /* 缺文件 */ }
  const wired = /optimistic-guard/.test(txt) && /guardGate\s*\(/.test(txt) && /--guard/.test(txt);
  ck('[POS] 已接线 --guard（import + guardGate + 参数解析齐备）', wired, wired ? 'ok' : '未接线：重启会绕过乐观检测');
  const beforeSignal = txt.indexOf('guardGate(') < txt.indexOf('writeHumanSignalIfNew(');
  ck('[POS] 检查位于"登记信号/请求重启"**之前**（顺序断言）', beforeSignal, beforeSignal ? 'ok' : '顺序不对：检查跑到落盘之后了');
  const hasWarn = /触发型工具|真的请求一次重启|⚠/.test(txt);
  ck('[POS] 文件头有"会真的请求重启"的副作用警示', hasWarn, hasWarn ? 'ok' : '缺副作用警示');
}

const bad = results.filter((r) => !r.cond).length;
console.log(`\nRESULT: ${results.length - bad}/${results.length} ${bad ? 'FAIL' : 'PASS'}`);
process.exit(bad ? 1 : 0);
