// 门禁：周期审计入口 run-audit.cmd 的静态契约。
//
// 为什么单独一个门禁：它和 run-chain.cmd 的契约**不同**（不读指针、不派发链条），
// 套用 verify-run-chain-cmd.mjs 会误报 4 项失败——门禁必须校验"该文件真正该满足的性质"，否则就是假守卫。
//
// 本文件真正该满足的性质：
//   A 纯 ASCII + 无 BOM：cmd.exe 按 ANSI 解析，非 ASCII 字节会破坏行结构（run-chain.cmd 曾因此 exit=255）；
//   B 调用了 audit-all.mjs（否则"周期审计"根本没在审计）；
//   C **退出码必须透传**（`exit /b %ERRORLEVEL%`）——若吞成 `exit /b 0`，计划任务 Last Result 永远 0，
//     审计失败将完全不可见：这正是"静默失败"型假守卫；
//   D 不得写死某次判定结果（例如硬编码 OK/exit 0）。
//
// 用法: node verify-run-audit-cmd.mjs [--path <file>] [--selftest]
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT = 'D:\\cc-tasks\\run-audit.cmd';

// 纯函数：返回失败项列表（空数组 = 通过）
export function auditCmd(text) {
  const bad = [];
  if (typeof text !== 'string' || !text.trim()) return ['文件为空或不可读'];
  const nonAscii = [...text].filter((c) => c.codePointAt(0) > 127);
  if (nonAscii.length) bad.push(`含非 ASCII 字符 ${nonAscii.length} 个（cmd.exe 按 ANSI 解析会破坏行结构）`);
  if (text.charCodeAt(0) === 0xfeff) bad.push('含 UTF-8 BOM');
  if (!/audit-all\.mjs/.test(text)) bad.push('没有调用 audit-all.mjs（那它就不是周期审计入口）');
  if (!/exit\s+\/b\s+%ERRORLEVEL%/i.test(text)) bad.push('没有透传退出码（缺 `exit /b %ERRORLEVEL%`）→ 失败会被吞成 Last Result 0');
  if (/exit\s+\/b\s+0\b/i.test(text)) bad.push('把退出码写死成 0 → 审计失败不可见');
  return bad;
}

// 纯函数：入口是否**可传递地**真的跑到了 audit-all.mjs。
// 为什么不能只看字面：入口现在经由信号化包装器（run-audit-signal.mjs）再调 audit-all ——
// 只匹配字面会把一份正确的接线判成"没在审计"（假失败）。readFile 注入以便自检。
export function reachesAuditAll(text, readFile) {
  if (/audit-all\.mjs/.test(text)) return true;
  const mjs = [...String(text).matchAll(/([\w.-]+\.mjs)/g)].map((m) => m[1]);
  for (const f of mjs) {
    let body = null;
    try { body = readFile(f); } catch { continue; }
    if (body && /audit-all\.mjs/.test(body)) return true;
  }
  return false;
}

// 纯函数：隐藏启动器（.vbs）的静态契约。
// 为什么必须校验：加了隐藏窗口之后，"窗口不再弹出"很容易顺手把**失败也一起隐藏**——
// 只要有人把 WScript.Quit 去掉（像 watchdog 那份启动器那样不关心退出码），或者把窗口样式从 0 改成 1，
// 计划任务 Last Result 就再也不反映审计结论了。这两条正是本文件要钉死的性质。
export function auditLauncher(text) {
  const bad = [];
  if (typeof text !== 'string' || !text.trim()) return ['启动器为空或不可读'];
  const nonAscii = [...text].filter((c) => c.codePointAt(0) > 127);
  if (nonAscii.length) bad.push(`含非 ASCII 字符 ${nonAscii.length} 个`);
  if (text.charCodeAt(0) === 0xfeff) bad.push('含 UTF-8 BOM');
  if (!/WScript\.Shell/i.test(text) || !/\.Run\s*\(/i.test(text)) bad.push('不是 WScript.Shell.Run 启动器');
  // 窗口样式必须为 0（隐藏）；1=正常窗口，2=最小化，3=最大化
  if (!/\.Run\s*\([^)]*,\s*0\s*,\s*True\s*\)/i.test(text)) bad.push('Run(...) 必须是 窗口样式 0（隐藏）+ bWaitOnReturn True（等待完成）');
  // 退出码必须透传：缺 WScript.Quit 就等于把失败吞掉（watchdog 那份启动器就是这样，但它不需要退出码）
  if (!/WScript\.Quit\s+sh\.Run/i.test(text)) bad.push('没有 `WScript.Quit sh.Run(...)` → 子进程退出码被丢弃，审计失败将不可见');
  return bad;
}

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const LAUNCHER = 'D:\\cc-tasks\\_hidden-run-audit.vbs';

function selftest() {
  const real = (() => { try { return fs.readFileSync(DEFAULT, 'utf8'); } catch { return null; } })();
  const cases = [];
  const t = (label, text, expectFail) => {
    const bad = auditCmd(text);
    const gotFail = bad.length > 0;
    const pass = gotFail === expectFail;
    cases.push(pass);
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label} → ${gotFail ? '抓（' + bad[0] + '）' : '放行'}`);
  };
  t('[POS] 真实 run-audit.cmd → 放行', real, false);
  t('[NEG] 注入中文注释（非 ASCII）→ 抓', (real || '') + '\nREM 这是中文注释\n', true);
  if (real) {
    t('[NEG] 退出码吞成 0 → 抓', real.replace(/exit\s+\/b\s+%ERRORLEVEL%/i, 'exit /b 0'), true);
    t('[NEG] 去掉退出码透传 → 抓', real.replace(/exit\s+\/b\s+%ERRORLEVEL%/i, ''), true);
    t('[NEG] 不再调用 audit-all.mjs → 抓', real.replace(/audit-all\.mjs/g, 'something-else.mjs'), true);
  }
  t('[NEG] 空文件 → 抓', '', true);
  t('[POS] 最小合规实现 → 放行', '@echo off\r\nnode "x\\audit-all.mjs" --quiet\r\nexit /b %ERRORLEVEL%\r\n', false);

  // ---- 隐藏启动器契约（2026-09-18 新增：窗口不再弹出后，最容易顺手把"失败可见"也一起隐藏）----
  const L = (() => { try { return fs.readFileSync(LAUNCHER, 'utf8'); } catch { return null; } })();
  const tl = (label, text, expectFail) => {
    const bad = auditLauncher(text);
    const gotFail = bad.length > 0;
    const pass = gotFail === expectFail;
    cases.push(pass);
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label} → ${gotFail ? '抓（' + bad[0] + '）' : '放行'}`);
  };
  tl('[POS] 真实隐藏启动器 → 放行', L, false);
  if (L) {
    tl('[NEG] 丢掉 WScript.Quit（= 退出码被吞、失败不可见）→ 抓', L.replace(/WScript\.Quit\s+/i, ''), true);
    tl('[NEG] 窗口样式改成 1（可见窗口又回来了）→ 抓', L.replace(/, 0, True\)/, ', 1, True)'), true);
    tl('[NEG] 不再等待完成（bWaitOnReturn False）→ 抓', L.replace(/, 0, True\)/, ', 0, False)'), true);
    tl('[NEG] 换成非 Run 启动方式 → 抓', L.replace(/\.Run\s*\(/i, '.Exec('), true);
  }
  tl('[NEG] 空启动器 → 抓', '', true);
  tl('[POS] 最小合规启动器 → 放行', 'Set sh = CreateObject("WScript.Shell")\r\nWScript.Quit sh.Run("cmd /c ""x.cmd""", 0, True)\r\n', false);

  // ---- 可传递校验（入口经包装器再调 audit-all）----
  const fakeRead = (m) => ({
    'run-audit-signal.mjs': "spawnSync(..., ['audit-all.mjs'])",
    'other.mjs': 'console.log("nothing here")',
  }[m] ?? (() => { throw new Error('ENOENT'); })());
  const tr = (label, text, expect) => {
    const got = reachesAuditAll(text, fakeRead);
    const pass = got === expect;
    cases.push(pass);
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label} → ${got}`);
  };
  tr('[POS] 字面直接调用 audit-all.mjs → 认', 'node "x\\audit-all.mjs" --quiet', true);
  tr('[POS] 经包装器间接调用（包装器内容含 audit-all）→ 认', 'node "D:\\dsh relay test\\run-audit-signal.mjs" --quiet', true);
  tr('[NEG] 包装器不含 audit-all → 不认（不能凭"调了某个 mjs"就算在审计）', 'node "x\\other.mjs"', false);
  tr('[NEG] 提及的 mjs 不存在 → 不认（不得靠一个不存在的文件蒙混）', 'node "x\\missing.mjs"', false);
  tr('[NEG] 没有提及任何 mjs → 不认', 'echo hello', false);

  const ok = cases.filter(Boolean).length;
  console.log(`\nRESULT: ${ok}/${cases.length} ${ok === cases.length ? 'PASS' : 'FAIL'}`);
  return ok === cases.length;
}

if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

const target = argOf('--path', DEFAULT);
let text = null;
try { text = fs.readFileSync(target, 'utf8'); } catch (e) { console.log(`  [FAIL] 读不到 ${target}：${e.message}`); process.exit(1); }
console.log(`=== run-audit.cmd 契约门禁：${target} ===`);
// 可传递校验：入口可以经由信号化包装器再调 audit-all（这样审计失败才能叫醒主 agent）
const readWork = (f) => {
  const cands = [path.join('D:\\dsh relay test', f), path.join(path.dirname(target), f), f];
  for (const c of cands) { try { return fs.readFileSync(c, 'utf8'); } catch { /* 下一个 */ } }
  throw new Error('ENOENT');
};
const bad = auditCmd(text).filter((b) => !(/audit-all\.mjs/.test(b) && reachesAuditAll(text, readWork)));
for (const b of bad) console.log(`  ✗ ${b}`);
if (!bad.length) console.log(`  [PASS] 纯 ASCII ｜ 无 BOM ｜ **可传递地**调用 audit-all.mjs ｜ 退出码透传且未写死`);

// 所有隐藏启动器都要满足同一契约：链条 20 分钟一次、审计 30 分钟一次、重启后探针 2 分钟一次。
// 用目录扫描而不是逐个硬编码——新增启动器时不会漏检（"漏检"才是这条门禁真正的失效模式）。
const LAUNCHER_DIR = 'D:\\cc-tasks';
let launchers = [];
try { launchers = fs.readdirSync(LAUNCHER_DIR).filter((f) => /^_hidden-run-.*\.vbs$/i.test(f)).sort(); } catch { /* 目录不可读 */ }
const allBad = [];
for (const f of launchers) {
  const p = path.join(LAUNCHER_DIR, f);
  let t = null;
  try { t = fs.readFileSync(p, 'utf8'); } catch { /* 读不到 */ }
  console.log(`=== 隐藏启动器契约：${p} ===`);
  const b = t === null ? ['启动器不可读'] : auditLauncher(t);
  for (const x of b) console.log(`  ✗ ${x}`);
  if (!b.length) console.log('  [PASS] WScript.Shell.Run ｜ 窗口样式 0（隐藏）｜ 等待完成 ｜ 退出码透传');
  allBad.push(...b);
}
if (launchers.length < 3) allBad.push(`隐藏启动器数量异常（只找到 ${launchers.length} 个，期望 ≥3：链条/审计/重启后探针）—— 有任务可能又改回直接跑 .cmd（会弹窗）`);

const total = bad.length + allBad.length;
console.log(`\nRESULT: ${total ? `FAIL（${total} 项）` : `PASS（run-audit.cmd + ${launchers.length} 个隐藏启动器）`}`);
process.exit(total ? 1 : 0);
