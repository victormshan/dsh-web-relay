// 功能性复跑检查：隐藏启动器的"退出码透传"到底靠不靠得住（真跑 wscript，不只看文本）。
//
// 为什么不能只做静态检查：静态门禁能抓"忘了写 WScript.Quit"，但抓不到 Windows 行为层面的问题
// （例如 Run 的返回语义变化、wscript 被替换成 cscript 等）。故这里用**最小夹具**真跑一遍：
//   夹具 A：cmd 以 exit /b 0 结束 → 启动器必须返回 0
//   夹具 B：cmd 以 exit /b 7 结束 → 启动器必须返回 7（**失败必须能穿透隐藏包装**）
//
// ⚠ 刻意**不**调用 run-audit.cmd / audit-all.mjs：claims 是在 audit-all 的第 ⑥ 层里跑的，
//   若这里再去启动周期审计，就会 audit-all → ⑥ → 启动器 → audit-all 无限递归。用最小夹具即可覆盖同一机制。
//
// 用法: node precheck-hidden-launcher.mjs    （exit 0 = 两侧都符合，1 = 有问题）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hidlaunch-'));
const mk = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body.replace(/\n/g, '\r\n'), 'ascii'); return p; };
const mkLauncher = (name, target) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `Set sh = CreateObject("WScript.Shell")\r\nWScript.Quit sh.Run("cmd /c ""${target}""", 0, True)\r\n`, 'ascii');
  return p;
};
const runWscript = (vbs) => {
  const r = spawnSync('wscript.exe', [vbs], { encoding: 'utf8', timeout: 60000 });
  return { code: r.status, err: r.error ? r.error.message : null };
};

const results = [];
const check = (label, cond, detail = '') => { results.push(cond); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };

try {
  const okCmd = mk('ok.cmd', '@echo off\nexit /b 0\n');
  const failCmd = mk('fail.cmd', '@echo off\nexit /b 7\n');
  const okVbs = mkLauncher('ok.vbs', okCmd);
  const failVbs = mkLauncher('fail.vbs', failCmd);

  const a = runWscript(okVbs);
  check('[POS] 成功夹具 → 启动器返回 0', a.code === 0, `实际=${a.code}${a.err ? ' err=' + a.err : ''}`);
  const b = runWscript(failVbs);
  check('[NEG] 失败夹具（exit 7）→ 启动器必须返回 7（失败不得被隐藏吞掉）', b.code === 7, `实际=${b.code}`);

  // 与真实启动器同一模板的形状校验（防止"夹具对了、真文件是另一套写法"）
  const real = fs.existsSync('D:\\cc-tasks\\_hidden-run-audit.vbs') ? fs.readFileSync('D:\\cc-tasks\\_hidden-run-audit.vbs', 'ascii') : '';
  check('[POS] 真实启动器与夹具同一模板（WScript.Quit sh.Run(..., 0, True)）', /WScript\.Quit\s+sh\.Run\([^)]*,\s*0\s*,\s*True\s*\)/.test(real));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}

const ok = results.filter(Boolean).length;
console.log(`\nRESULT: ${ok}/${results.length} ${ok === results.length ? 'PASS' : 'FAIL'}`);
process.exit(ok === results.length ? 0 : 1);
