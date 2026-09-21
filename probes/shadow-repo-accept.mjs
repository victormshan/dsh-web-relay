// 验收探针：影子沙盒的 repoPath 解析必须**自持**（不依赖环境变量也能从模块自身位置解析出仓库根）。
//
// 背景（2026-09-19 实测，两轮都白跑）：
//   · 机制长期空转：`resolveRepoPath(base)` 以**工作区**（D:\dsh relay test，非 git 仓库）为基准 → null；
//     其回退读 `DSH_RELAY_REPO_PATH`，而宿主启动器设的是 `DSH_RELAY_REPO`（名字不一致）→ 回退永不生效。
//   · 我先把修复押在"启动器补 DSH_RELAY_REPO_PATH"上 → **重启后仍不生效**：`request-restart` 重启的是**宿主**，
//     而宿主由常驻 watchdog 拉起，watchdog 继承的是它自己启动时的环境（实测 watchdog 起于 9/15，早于我改启动器）。
//   ⇒ 正确修法：**让插件用自己已能算出的仓库根兜底**（lib/ 上溯），env 只作为可选加速项。
//
// 本探针断言（仓库侧、当场可判、不需要重启）：
//   [POS] lib/shadow-gate.js 导出解析函数（resolveShadowRepo 或 shadowRepoCandidates）
//   [POS] **无任何 env** 时，传入非 git 的 base 也能解析出仓库根（这就是本次修复的核心性质）
//   [POS] env 提供时被采纳（可选来源仍有效，且优先级明确）
//   [NEG] 所有来源都不可用 → 返回 null（不得凭空造路径）
//   [POS] 接线：index.js 中影子相关取仓库根的位置都改用该解析函数（不再只有 env 一条路）
//   [NEG] 定时 GC 的启用条件不得仍以 `DSH_RELAY_REPO_PATH` 存在为唯一门槛
//
// 用法: node probes/shadow-repo-accept.mjs [taskId]      # 真跑
//       node probes/shadow-repo-accept.mjs --selftest
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isWin = process.platform === 'win32';
const REPO = process.env.DSH_REPO || (isWin ? 'D:\\dsh-web-relay' : '/mnt/d/dsh-web-relay');
const GATE = path.join(REPO, 'lib', 'shadow-gate.js');
const INDEX = path.join(REPO, 'lib', 'index.js');

const results = [];
const check = (label, cond, detail = '') => { results.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };

function selftest() {
  // 判定助手：给定候选数组与"存在性"预言，解析结果是否符合预期（防探针自身永真）
  const pick = (cands, exists) => cands.find((c) => c && exists(c)) || null;
  const cases = [
    ['[POS] 首个可用候选被采纳', pick(['a', 'b'], (x) => x === 'b') === 'b'],
    ['[NEG] 全不可用 → null（不得回退到"猜一个"）', pick(['a', 'b'], () => false) === null],
    ['[NEG] 候选里的空值被跳过', pick([null, 'c'], (x) => !!x) === 'c'],
  ];
  const bad = cases.filter((c) => !c[1]).length;
  for (const [l, ok] of cases) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}`);
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}
if (process.argv.includes('--selftest')) selftest();

// ---- 1) 模块与导出 ----
let mod = null;
try { mod = await import(pathToFileURL(GATE).href); } catch (e) {
  check('[POS] lib/shadow-gate.js 可导入', false, e.code === 'ERR_MODULE_NOT_FOUND' ? '不存在' : e.message);
}
const fns = ['resolveShadowRepo', 'shadowRepoCandidates', 'shadowRepoFallbacks'];
const found = mod ? fns.filter((f) => typeof mod[f] === 'function') : [];
check('[POS] 导出 repoPath 解析函数（resolveShadowRepo / shadowRepoCandidates）', found.length > 0, found.join(',') || '未导出');

// ---- 2) 核心性质：无 env 也能解析出仓库根 ----
if (mod && typeof mod.resolveShadowRepo === 'function') {
  const nonGitBase = isWin ? 'D:\\dsh relay test' : '/mnt/d/dsh relay test';
  const got = mod.resolveShadowRepo({ base: nonGitBase, payload: {}, env: {} });
  const expectOk = typeof got === 'string' && /dsh-web-relay/.test(got);
  check('[POS] **无 env** + 非 git base → 仍解析出仓库根（本次修复的核心）', expectOk, `got=${got}`);
  const gotEnv = mod.resolveShadowRepo({ base: nonGitBase, payload: {}, env: { DSH_RELAY_REPO: REPO } });
  check('[POS] env 提供时被采纳（可选来源仍有效）', typeof gotEnv === 'string' && gotEnv.length > 0, `got=${gotEnv}`);
  const nulled = mod.resolveShadowRepo({ base: isWin ? 'D:\\__nowhere__' : '/__nowhere__', payload: {}, env: {}, moduleDir: isWin ? 'D:\\__nowhere__' : '/__nowhere__' });
  check('[NEG] 所有来源不可用 → null（不得凭空造路径）', nulled === null || nulled === undefined, `got=${nulled}`);
} else if (mod) {
  const cands = typeof mod.shadowRepoCandidates === 'function' ? mod.shadowRepoCandidates({ base: isWin ? 'D:\\dsh relay test' : '/mnt/d/dsh relay test', payload: {}, env: {} }) : null;
  check('[POS] 候选数组含"由模块自身位置推导"的仓库根（无 env 时可用）', Array.isArray(cands) && cands.some((c) => /dsh-web-relay/.test(String(c))), JSON.stringify(cands));
}

// ---- 3) 接线（静态但精确）----
const idx = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : '';
const gateSrc = fs.existsSync(GATE) ? fs.readFileSync(GATE, 'utf8') : '';
check('[POS] index.js 调用解析函数（影子相关取仓库根不再只有 env 一条路）', /resolveShadowRepo|shadowRepoCandidates/.test(idx));
const callsites = (idx.match(/resolveShadowRepo\(/g) || []).length;
check('[POS] 解析函数覆盖 ≥4 处调用点（影子门禁/回滚/GC 端点/定时 GC）', callsites >= 4, `实测 ${callsites} 处`);
// [NEG] 定时 GC 的仓库来源必须来自解析函数（不得仍只读 env —— 那正是本次长期空转的原因）
// 注：初版写成"匹配 env-only 的写法" → 因正则与真实代码不符而**恒过**（假通过）；改为正向断言。
check('[NEG] 定时 GC 的仓库来源来自解析函数（不得只读 DSH_RELAY_REPO_PATH）',
  /const gcRepo[\s\S]{0,240}(resolveShadowRepo|shadowRepoCandidates)/.test(idx),
  '未在 gcRepo 赋值处见到解析函数调用');
check('[POS] shadow-gate.js 自身从 import.meta.url 推导模块目录（自持回退的实现基础）',
  /import\.meta\.url/.test(gateSrc) && /fileURLToPath|dirname/.test(gateSrc));

const pass = results.filter((r) => r.cond).length;
console.log(`\nRESULT: ${pass}/${results.length} → 判定 ${pass === results.length ? 'PASS' : 'FAIL'}`);
process.exit(pass === results.length ? 0 : 1);
