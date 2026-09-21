// 验收探针：acceptanceScript 的**执行语义**必须真的可用（走生产路径：WSL 里的 runner 调 task-schema-cli）。
//
// 为什么需要它（2026-09-18 实测，本会话最贵的一次通道缺陷）：
//   lib/task-schema-v2.mjs 的 defaultExec 把 acceptanceScript 当 **shell 命令**跑（/bin/sh -c '<值>'）。
//   我在规格里按"这是脚本路径"写 'probes/loaded-hash-accept.mjs'，于是 runner 直接去 exec 这个文件
//   → `/bin/sh: probes/...: not found` → 任务被结算成 **v2-validate-failed**。
//   该字段（s2v2_3 实现）此前**从未被任何真实任务用过**，单元测试全部注入假 exec，
//   所以"单测全绿、真实路径从未被触碰"——第一次真用就坏。
//
// 本探针断言的性质（都是**产物级**、可复跑）：
//   [POS] 裸脚本 token（probes/x.mjs）→ 必须以 node 执行并成功；相对路径要能按仓库根解析
//   [POS] 显式命令形态（sh -c 'node x.mjs id'）→ 必须成功（保持既有语义不回归）
//   [NEG] 探针 exit 1 → 必须报成**业务判定不合格**（带明确标记），不得报成 ok
//   [NEG] token 指向不存在的文件 → 必须报成**工具错误**（带 INSTRUMENT 标记），不得与"判定不合格"混同
//   [NEG] 命令不存在（退出 127）→ 同上，必须是工具错误
//   [NEG] 恒通过伪造：若实现把"根本没执行"也报 ok:true，本探针必须能抓到（区分力自检）
//
// 用法: node probes/acceptance-invocation-accept.mjs [taskId]   # 真跑（WSL）
//       node probes/acceptance-invocation-accept.mjs --selftest
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// 平台化（2026-09-18 实测教训）：runner 在**生产路径**（WSL/POSIX）执行本探针，主 agent 的验收器在 Windows 上执行它。
// 硬编码 Windows 路径 + 只在 Windows 侧转发 wsl.exe，会让 WSL 侧（真正的生产执行者）直接判失败。
const isWin = process.platform === 'win32';
const REPO = process.env.DSH_REPO || (isWin ? 'D:\\dsh-web-relay' : '/mnt/d/dsh-web-relay');
const REPO_WSL = isWin ? '/mnt/d/dsh-web-relay' : REPO;
const WORK = isWin ? 'D:\\dsh relay test' : '/mnt/d/dsh relay test';
const CLI = 'scripts/task-schema-cli.mjs';
const onWsl = isWin ? spawnSync('wsl.exe', ['-e', 'node', '-v'], { encoding: 'utf8' }) : { status: 0 };

// 生产路径执行：Windows 侧经 wsl.exe 转发；POSIX（runner 内）直接跑。
function runWsl(argv, opts = {}) {
  if (isWin) return spawnSync('wsl.exe', ['-e', ...argv], { encoding: 'utf8', timeout: 120000, ...opts });
  return spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 120000, ...opts });
}

/** 造一个任务夹具（两侧看同一份文件：Windows 走 D:\，WSL 走 /mnt/d） */
function mkFixture(name, { acceptanceScript, probeBody, probeName = 'probe.mjs' }) {
  const dir = path.join(WORK, '_fixtures', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'done.flag'), 'done\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ status: 'done', exit: 0, errorCode: null }), 'utf8');
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({
    taskId: name, kind: 'understand', acceptanceScript, expectArtifacts: [], outputDir: 'out',
  }, null, 2), 'utf8');
  if (probeBody) fs.writeFileSync(path.join(dir, probeName), probeBody, 'utf8');
  return dir;
}

/** 夹具目录的 WSL 形式（CLI 在 WSL 里跑，必须给它 /mnt/d 路径） */
const toWslPath = (p) => (isWin ? p.replace(/^D:\\/, '/mnt/d/').replace(/\\/g, '/') : p);

/** 把 CLI 的 validate-result 结果解析成 { ok, errors } */
function validate(dir) {
  const wslDir = toWslPath(dir);
  const r = runWsl(['node', CLI, 'validate-result', wslDir], { cwd: REPO });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // CLI 退出码契约（见 scripts/task-schema-cli.mjs 头部注释）：0 通过 / 1 校验失败 / 2 用法错误。
  // 不要靠解析 JSON 的行位置——JSON 是多行缩进输出的（初版取最后一行只拿到 '}'，ok 恒为 null，属自造陷阱）。
  const ok = r.status === 0 ? true : r.status === 1 ? false : null;
  const m = out.match(/\{[\s\S]*\}/);
  let detail = null;
  if (m) { try { detail = JSON.parse(m[0]); } catch { /* 保持 null */ } }
  return { code: r.status, out, ok, detail };
}

/** 纯判定：给定 CLI 输出，判断它把 acceptanceScript 归为哪一类 */
export function classify(out) {
  if (/acceptance-script.*INSTRUMENT/i.test(out)) return 'instrument';
  if (/acceptance-script/i.test(out)) return 'business-fail';
  return 'ok';
}

function selftest() {
  const cases = [];
  const t = (label, cond) => { cases.push(cond); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); };
  // [POS] 分类器认得三类输出
  t('[POS] 无 acceptance 错误 → 归为 ok（不得把干净输出误报成失败）', classify('{"ok":true,"errors":[]}') === 'ok');
  t('[POS] 带 INSTRUMENT 标记 → 归为工具错误', classify('[acceptance-script][INSTRUMENT] not found') === 'instrument');
  // [NEG] 区分力：业务失败与工具错误**必须**分开；把工具错误写成业务失败要能被抓
  t('[NEG] 只带 [acceptance-script][FAIL] → 归为业务失败（不得与工具错误混同）', classify('[acceptance-script][FAIL] probe exited 1') === 'business-fail');
  t('[NEG] 旧的裸 not found 输出（无标记）→ 必须被当作业务失败即"未分类"，说明实现未修', classify('[acceptance-script] Command failed: /bin/sh: 1: x.mjs: not found') !== 'instrument');
  const ok = cases.filter(Boolean).length;
  console.log(`\nRESULT: ${ok}/${cases.length} ${ok === cases.length ? 'PASS' : 'FAIL'}`);
  return ok === cases.length;
}

if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

if (isWin && onWsl.status !== 0) {
  console.log(`  [SKIP] WSL 不可用（wsl -e node -v → exit=${onWsl.status}）：本探针走生产路径，无法在此环境判定。`);
  console.log('  NOT-APPLICABLE');
  process.exit(4);
}

const results = [];
const check = (label, cond, detail = '') => {
  results.push({ label, cond });
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
};

// [POS] 1. 裸脚本 token → 必须以 node 执行并成功
{
  const dir = mkFixture('acc-token', {
    acceptanceScript: 'probes/_acc-probe-ok.mjs',
    probeBody: `console.log('OK taskId=' + (process.argv[2] || '(none)') + ' env=' + (process.env.DSH_TASK_ID || '(none)'));\nprocess.exit(0);\n`,
  });
  // 探针放仓库里（token 相对仓库根）
  const repoProbe = path.join(REPO, 'probes', '_acc-probe-ok.mjs');
  fs.mkdirSync(path.dirname(repoProbe), { recursive: true });
  fs.writeFileSync(repoProbe, `console.log('OK taskId=' + (process.argv[2] || '(none)') + ' env=' + (process.env.DSH_TASK_ID || '(none)'));\nprocess.exit(0);\n`, 'utf8');
  const r = validate(dir);
  check('[POS] 裸脚本 token（probes/x.mjs）→ 以 node 执行且最终 ok=true', r.ok === true, `ok=${r.ok} code=${r.code} ${r.out.split('\n').filter((l) => /acceptance/.test(l))[0] || ''}`);
  check('[POS] 该路径未再出现 "not found"', !/not found/.test(r.out), '');
  fs.rmSync(repoProbe, { force: true });
}

// [POS] 2. 显式命令形态不回归
{
  const dir = mkFixture('acc-cmd', {
    acceptanceScript: `node ${REPO_WSL}/probes/_acc-probe-ok2.mjs`,
  });
  const repoProbe = path.join(REPO, 'probes', '_acc-probe-ok2.mjs');
  fs.mkdirSync(path.dirname(repoProbe), { recursive: true });
  fs.writeFileSync(repoProbe, 'process.exit(0);\n', 'utf8');
  const r = validate(dir);
  check('[POS] 显式命令形态（node <abs>）→ 仍须 ok=true（既有语义不回归）', r.ok === true, `ok=${r.ok}`);
  fs.rmSync(repoProbe, { force: true });
}

// [NEG] 3. 探针 exit 1 → 业务判定不合格（必须被报出，且不得报 ok）
{
  const dir = mkFixture('acc-fail', {
    acceptanceScript: 'probes/_acc-probe-fail.mjs',
  });
  const repoProbe = path.join(REPO, 'probes', '_acc-probe-fail.mjs');
  fs.mkdirSync(path.dirname(repoProbe), { recursive: true });
  fs.writeFileSync(repoProbe, 'console.log("业务判定不合格");\nprocess.exit(1);\n', 'utf8');
  const r = validate(dir);
  check('[NEG] 探针 exit 1 → ok 必须为 false', r.ok === false, `ok=${r.ok}`);
  check('[NEG] 且必须被报成 acceptance-script 相关的失败', /acceptance-script/i.test(r.out), '');
  fs.rmSync(repoProbe, { force: true });
}

// [NEG] 4. token 指向不存在的文件 → 必须是**工具错误**（与业务失败区分）
{
  const dir = mkFixture('acc-missing', { acceptanceScript: 'probes/__no_such_probe__.mjs' });
  const r = validate(dir);
  const cls = classify(r.out);
  check('[NEG] 不存在的 token → ok=false', r.ok === false, `ok=${r.ok}`);
  check('[NEG] 且必须带 INSTRUMENT 标记（工具错误，不是"产物不合格"）', cls === 'instrument', `分类=${cls}｜${r.out.split('\n').filter((l) => /acceptance/.test(l))[0] || '(无该行)'}`);
}

// [NEG] 5. 命令不存在（127）→ 也必须是工具错误
{
  const dir = mkFixture('acc-cmdmissing', { acceptanceScript: 'definitely-not-a-command-xyz --nope' });
  const r = validate(dir);
  const cls = classify(r.out);
  check('[NEG] 命令不存在 → 必须带 INSTRUMENT 标记', cls === 'instrument', `分类=${cls}`);
}

for (const d of ['acc-token', 'acc-cmd', 'acc-fail', 'acc-missing', 'acc-cmdmissing']) {
  fs.rmSync(path.join(WORK, '_fixtures', d), { recursive: true, force: true });
}

// [NEG] 6. Windows 侧契约（只在 win32 跑）：命令形态必须**明确拒绝**，而不是抛一个关于 /bin/sh 的裸 ENOENT。
// 背景：初版把命令形态硬编码成 /bin/sh，于是在 Windows 上任何命令形态都得到
// "命令不存在（ENOENT）: spawnSync /bin/sh ENOENT" —— 语义地雷：读起来像"命令有问题"，
// 实际是"这条路径在本平台根本不受支持"。要么按平台选 shell，要么明确拒绝；两者都必须可测。
if (isWin) {
  const mod = await import(pathToFileURL(path.join(REPO, 'lib', 'task-schema-v2.mjs')).href).catch(() => null);
  if (!mod || typeof mod.runAcceptanceScript !== 'function') {
    check('[NEG] win32 契约：能 import 仓库的 runAcceptanceScript', false, '导入失败');
  } else {
    const r = mod.runAcceptanceScript({ script: 'echo hi', cwd: WORK, taskId: 't' });
    const msg = String(r.error || '');
    check('[NEG] win32：命令形态不得报成 ok/fail（必须是 instrument）', r.ok === false && r.kind === 'instrument', `kind=${r.kind}`);
    check('[NEG] win32：错误须明确说明"本平台不支持/请用脚本 token"，而非裸 ENOENT /bin/sh',
      /不支持|平台|脚本 token|script token/i.test(msg), msg.slice(0, 140));
  }
} else {
  console.log('  [SKIP] win32 契约检查（当前不是 Windows，由 Windows 侧验收器负责）');
}

const pass = results.filter((r) => r.cond).length;
console.log(`\nRESULT: ${pass}/${results.length} → 判定 ${pass === results.length ? 'PASS' : 'FAIL'}`);
process.exit(pass === results.length ? 0 : 1);
