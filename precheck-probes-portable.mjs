// 探针可移植性对照：**同一份探针必须在两个平台给出相同判定**。
//
// 为什么需要（2026-09-18 实测，已连踩三次）：runner 在**生产路径**（WSL/POSIX）执行声明的 acceptanceScript，
// 而主 agent 的验收器在 Windows 上执行同一份文件。我的探针初版硬编码 Windows 路径 + file:///D:/，
// 于是 WSL 侧 import 直接失败 → 一份**合格实现**被 runner 自报成 v2-validate-failed（v10 / v11 / v12 三次）。
// 单侧验证永远发现不了这件事：必须两个平台都真跑一遍，并要求判定一致。
//
// 用法: node precheck-probes-portable.mjs            （exit 0 = 所有探针两侧一致且通过）
//       node precheck-probes-portable.mjs --list     （只列探针与期望，不实跑）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WORK = 'D:\\dsh relay test';
const REPO = 'D:\\dsh-web-relay';
// 每个探针的调用方式（真跑时会分别用 Windows node 与 WSL node 执行）
const PROBES = [
  { file: 'pending-human-repo-accept.mjs', args: [] },
  { file: 'loaded-hash-accept.mjs', args: ['ccfeat-20260917-loadedhash'] },
  { file: 'acceptance-invocation-accept.mjs', args: ['ccfeat-20260918-acceptcall'] },
];

const listOnly = process.argv.includes('--list');
const results = [];
const check = (label, cond, detail = '') => { results.push(cond); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };

/** 纯函数：两侧判定是否等价（供 --selftest 判"这个对照本身有没有区分力"）。
 *  口径：退出码相同 **且** 是否判定通过相同。分母可以合法地不同——win32 专属检查在 WSL 上会显式 SKIP
 *  （8/8 与 10/10 都是 PASS）。真正要钉死的是"不能一边过一边挂"。 */
export function judgeParity(w, l) {
  const same = w.code === l.code && w.pass === l.pass;
  const bothOk = same && w.code === 0 && w.pass && l.pass;
  return { same, bothOk, ok: bothOk };
}

if (process.argv.includes('--selftest')) {
  const cases = [
    ['[POS] 两侧都 exit 0 且都 PASS → 放行', judgeParity({ code: 0, pass: true }, { code: 0, pass: true }).ok === true],
    ['[POS] 分母不同但两侧都 PASS（平台专属检查被 SKIP）→ 放行', judgeParity({ code: 0, pass: true, ratio: '10/10' }, { code: 0, pass: true, ratio: '8/8' }).ok === true],
    ['[NEG] 一侧 exit 1（生产路径跑不动）→ 必须抓', judgeParity({ code: 0, pass: true }, { code: 1, pass: false }).ok === false],
    ['[NEG] 退出码相同但一侧判定 FAIL → 必须抓', judgeParity({ code: 0, pass: true }, { code: 0, pass: false }).ok === false],
    ['[NEG] 两侧都 FAIL → 必须抓（"一致地坏"也是坏）', judgeParity({ code: 1, pass: false }, { code: 1, pass: false }).ok === false],
  ];
  const bad = cases.filter((c) => !c[1]).length;
  for (const [l, ok] of cases) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}`);
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

const runWin = (file, args) => spawnSync(process.execPath, [path.join(REPO, 'probes', file), ...args], { cwd: WORK, encoding: 'utf8', timeout: 300000 });
const runWsl = (file, args) => spawnSync('wsl.exe', ['-e', 'node', `/mnt/d/${'dsh-web-relay'}/probes/${file}`, ...args], { cwd: WORK, encoding: 'utf8', timeout: 300000 });
const verdictOf = (r) => {
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/RESULT:\s*(\d+)\/(\d+)/);
  return { code: r.status, ratio: m ? `${m[1]}/${m[2]}` : '(无 RESULT 行)', pass: /判定 PASS|RESULT: PASS/.test(out), out };
};

if (listOnly) {
  for (const p of PROBES) console.log(`${p.file} ${p.args.join(' ')}`.trim());
  process.exit(0);
}

for (const p of PROBES) {
  if (!fs.existsSync(path.join(REPO, 'probes', p.file))) { check(`${p.file} 已同步到仓库`, false); continue; }
  const w = verdictOf(runWin(p.file, p.args));
  const l = verdictOf(runWsl(p.file, p.args));
  // 判定口径：比**退出码 + 是否判定 PASS**，而不是比分母。
  // 分母可以合法地不同——例如 win32 专属检查在 WSL 上会显式 SKIP（8/8 vs 10/10 都是 PASS）。
  // 真正要钉死的是：两个平台都不能一边过一边挂（初版硬编码 Windows 路径时，WSL 侧是 exit 1 判定 FAIL）。
  // 判定口径见 judgeParity：比退出码 + 是否 PASS，不比分母（平台专属检查会被合法 SKIP）
  const verdict = judgeParity(w, l);
  check(`${p.file}：两侧退出码与判定一致（Windows exit=${w.code} ${w.ratio} PASS=${w.pass} ｜ WSL exit=${l.code} ${l.ratio} PASS=${l.pass}）`, verdict.same);
  check(`${p.file}：两侧都判定通过`, verdict.bothOk, `win=${w.code}/${w.pass} wsl=${l.code}/${l.pass}`);
  if (!verdict.ok) {
    console.log(`      WSL 末几行：${l.out.trim().split('\n').slice(-3).join(' ｜ ').slice(0, 300)}`);
  }
}

const ok = results.filter(Boolean).length;
console.log(`\nRESULT: ${ok}/${results.length} ${ok === results.length ? 'PASS' : 'FAIL'}`);
process.exit(ok === results.length ? 0 : 1);
