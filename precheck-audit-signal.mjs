// 功能性检查：审计失败的"升级通路"是否真的成立（判定非 0 → 写信号；判定 0 → 自动销账；同源只叫一次）。
//
// 两个模式：
//   · 默认（快，可当门禁跑）：用**假审计**（注入 DSH_AUDIT_CMD）验证包装器接线，秒级、无递归风险；
//   · --real（慢，约 1 分钟）：用**真正的四层审计** + `--negctl-fail chainRun` 强制失败，走一遍真路径。
// 两个模式都用**临时信号文件**（DSH_AUDIT_SIGNAL_PATH）→ 绝不去动真实告警文件（否则会凭空叫醒主 agent）。
//
// ⚠ 为什么不能做成 ⑥ 的 claim：claims 是在 audit-all 的第 ⑥ 层里跑的，而本检查会启动审计包装器 →
//   audit-all → ⑥ → 本检查 → audit-all **无限递归**。故它是独立门禁（--selftest 只跑快的部分）。
//
// 用法: node precheck-audit-signal.mjs            # 假审计（快）
//       node precheck-audit-signal.mjs --real     # 真审计 + 强制失败
//       node precheck-audit-signal.mjs --selftest # 门禁用（等价于默认，但输出带 [POS]/[NEG] 标记）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readHumanSignal, acknowledgeHumanSignal, readQueue } from './chain-human-signal.mjs';

const WORK = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '));
const selftestMode = process.argv.includes('--selftest');
const realMode = process.argv.includes('--real');
const results = [];
const check = (label, cond, detail = '') => { results.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditsig-'));
const signalFile = path.join(tmpDir, 'sig.json');
const fakeFail = path.join(tmpDir, 'fake-fail.mjs');
const fakeOk = path.join(tmpDir, 'fake-ok.mjs');
fs.writeFileSync(fakeFail, 'console.log("fake audit: forced fail");\nprocess.exit(1);\n', 'utf8');
fs.writeFileSync(fakeOk, 'console.log("fake audit: ok");\nprocess.exit(0);\n', 'utf8');

/** 跑一次包装器；env 注入临时信号文件与（可选的）审计命令 */
const runWrapper = (auditCmd, extraArgs = []) => {
  const env = { ...process.env, DSH_AUDIT_SIGNAL_PATH: signalFile };
  if (auditCmd) env.DSH_AUDIT_CMD = auditCmd;
  const r = spawnSync(process.execPath, [path.join(WORK, 'run-audit-signal.mjs'), '--quiet', ...extraArgs], { cwd: WORK, encoding: 'utf8', env, timeout: 600000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
// 注入的审计命令必须是**绝对路径**才能被包装器解析；故把假审计放到工作区同名文件下更稳妥。
const fakeFailLocal = path.join(WORK, `_fake-audit-fail-${Date.now()}.mjs`);
const fakeOkLocal = path.join(WORK, `_fake-audit-ok-${Date.now()}.mjs`);
fs.copyFileSync(fakeFail, fakeFailLocal);
fs.copyFileSync(fakeOk, fakeOkLocal);
// 真实告警文件的**事前快照**：用它做"本自检没碰真实文件"的判据。
// 为什么改成内容比对（2026-09-19 实测）：原判据写成"真实文件里不该有未销账的 four-layer-audit 条目"——
// 那是把**当时的真实世界状态**编码进了断言；等审计真的发出告警后，这条正确的行为反而被判失败（门禁假失败）。
const REAL_SIGNAL = 'D:\\cc-tasks\\chain-needs-human.json';
const realBefore = fs.existsSync(REAL_SIGNAL) ? fs.readFileSync(REAL_SIGNAL, 'utf8') : null;
if (realMode) {
  const env = { ...process.env, DSH_AUDIT_SIGNAL_PATH: signalFile };
  const r = spawnSync(process.execPath, [path.join(WORK, 'run-audit-signal.mjs'), '--quiet', '--negctl-fail', 'chainRun'], { cwd: WORK, encoding: 'utf8', env, timeout: 600000 });
  check('[POS] 真审计强制失败：退出码仍透传为 1（"隐藏失败"是不可接受的回归）', r.status === 1, `exit=${r.status}`);
  const e = readHumanSignal(signalFile);
  check('[POS] 真审计强制失败：写下了 audit-action-needed 信号（带稳定键）', e.ok && e.entry.reason === 'audit-action-needed' && e.entry.stableKey === 'four-layer-audit', `reason=${e.ok ? e.entry.reason : e.error}`);
  if (e.ok) {
    const before = e.entry.id;
    const r2 = spawnSync(process.execPath, [path.join(WORK, 'run-audit-signal.mjs'), '--quiet', '--negctl-fail', 'chainRun'], { cwd: WORK, encoding: 'utf8', env, timeout: 600000 });
    const e2 = readHumanSignal(signalFile);
    check('[NEG] 真审计连续失败第二次：同源不重写（id 不变 → 插件不会重复唤醒）', e2.ok && e2.entry.id === before, `id=${e2.ok ? e2.entry.id : '?'}`);
  }
} else {
  // [POS] 判定非 0 → 写信号，且退出码透传
  const r1 = runWrapper(fakeFailLocal);
  check('[POS] 审计失败 → 信号已登记（reason=audit-action-needed，稳定键 four-layer-audit）', (() => { const e = readHumanSignal(signalFile); return e.ok && e.entry.reason === 'audit-action-needed' && e.entry.stableKey === 'four-layer-audit' && e.entry.id === 'four-layer-audit#g1'; })(), `exit=${r1.code}`);
  check('[POS] 退出码透传：审计 exit 1 → 包装器 exit 1', r1.code === 1, `exit=${r1.code}`);
  // [NEG] 同源再次失败 → 不重写（方案 A：同源只叫一次）
  runWrapper(fakeFailLocal);
  const e1 = readHumanSignal(signalFile);
  check('[NEG] 同源连续失败第二次 → 不重复登记（仍是 g1；否则每轮审计都吵一次人）', e1.ok && e1.entry.id === 'four-layer-audit#g1', `id=${e1.ok ? e1.entry.id : '?'}`);
  // [POS] 人销账后复发 → 代数 +1（新 id → 会再次叫醒）
  acknowledgeHumanSignal('自检：模拟人已处理', signalFile);
  runWrapper(fakeFailLocal);
  const e2 = readHumanSignal(signalFile);
  check('[POS] 销账后复发 → 代数 +1 重新登记（复发必须能再次叫醒）', e2.ok && e2.entry.id === 'four-layer-audit#g2', `id=${e2.ok ? e2.entry.id : '?'}`);
  // [POS] 审计自愈 → 自动销账
  const r3 = runWrapper(fakeOkLocal);
  const e3 = readHumanSignal(signalFile);
  check('[POS] 审计恢复通过 → 自动销账同源信号（不留一条早已自愈的告警）', r3.code === 0 && e3.ok && !!e3.entry.acknowledgedAt, `exit=${r3.code} acked=${e3.ok ? !!e3.entry.acknowledgedAt : '?'}`);
  check('[POS] 通过时退出码为 0（不得因为写信号而改变判定）', r3.code === 0);
  // [NEG] 全程不得碰真实告警文件：按**内容比对**（不依赖真实文件里恰好有什么）
  const realAfter = fs.existsSync(REAL_SIGNAL) ? fs.readFileSync(REAL_SIGNAL, 'utf8') : null;
  check('[NEG] 自检全程未改动真实告警文件（内容比对，用的是临时路径）', realAfter === realBefore,
    realBefore === realAfter ? `真实文件未变（${realAfter ? realAfter.length + ' 字节' : '不存在'}）` : '真实文件被改动了！');
  check('[NEG] 队列未被本次自检污染', readQueue(signalFile).length === 0, `queue=${readQueue(signalFile).length}`);
}

for (const f of [tmpDir, fakeFailLocal, fakeOkLocal]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* 尽力清理 */ } }
const ok = results.filter((r) => r.cond).length;
console.log(`\nRESULT: ${ok}/${results.length} ${ok === results.length ? 'PASS' : 'FAIL'}${selftestMode ? '' : `（${realMode ? '真审计' : '假审计'}模式）`}`);
process.exit(ok === results.length ? 0 : 1);
