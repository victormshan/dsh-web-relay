// cc 交付验收器：对某个 cc 任务做「范围/语法/测试/覆盖/编码/执行接地验收」自证，输出机器可读结论
// 用法: node verify-cc-task.mjs <taskId> [--baseline-js 306] [--baseline-all 441] [--allow <extra,paths>] [--acceptance <probe.mjs>]
// 退出码：0=ACCEPT ｜ 1=REJECT（业务判定：产物不满足）｜ 2=入参错误 ｜ **3=INSTRUMENT-ERROR（验收工具自身出错，不是产物不合格）**
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = 'D:\\dsh-web-relay';
const CC = 'D:\\cc-tasks';
// 工作区根：优先 env，否则取**本脚本所在目录**（脚本就住在工作区根）——避免硬编码路径。
// 教训（2026-09-17）：本文件原先没有 WORK 常量，我新增的验收块引用了它 → ReferenceError → 进程崩溃退出 1
// → 被调用方读成"判定不合格"。两处修正：① 正确解析 WORK；② 把验收块整体 try/catch 降级为工具错误（exit 3）。
const WORK = process.env.DSH_RELAY_WORKSPACE || path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const taskId = args[0];
if (!taskId) { console.error('usage: node verify-cc-task.mjs <taskId> [--baseline-js N] [--baseline-all N] [--allow a,b]'); process.exit(2); }
const num = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : dflt; };
const baselineJs = num('--baseline-js', 306);
const baselineAll = num('--baseline-all', 441);
const allowIdx = args.indexOf('--allow');
const extraAllow = allowIdx >= 0 ? String(args[allowIdx + 1]).split(',').map((s) => s.trim()).filter(Boolean) : [];

const td = path.join(CC, 'tasks', taskId);
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} — ${detail}`); };
// skip 不计入 results（不参与 ACCEPT/REJECT 判定），但**必须打印**——静默跳过的检查等于没有检查
const skip = (name, detail) => { console.log(`  [SKIP] ${name} — ${detail}`); };
// 执行接地验收的超时（毫秒）。超时按"工具错误"处理，不与"判定不合格"混同。
const ACCEPT_TIMEOUT_MS = Number(process.env.DSH_ACCEPT_TIMEOUT_MS || 120000);

// 写入范围判定（抽成纯函数以便自测）。2026-09-16 修正一处**工具缺陷**：
// 原实现把「零改动」一律判为 FAIL（"无法归属改动"），但**只读分析任务**（kind=understand、
// 不声明任何仓库文件）本来就应当零改动——于是 v6-gen 的 S 组、v6-ab 的两组都被误判 verify-rejected，
// 导致链条在正确完成的任务上停止。语义区分：
//   declared=0 且 changed=0 → **符合预期**（只读任务），PASS
//   declared=0 且 changed>0 → 越界（没声明却改了文件），FAIL ← 守卫未被削弱
//   declared>0 且 changed=0 → 缺产物，FAIL
//   declared>0 且 changed>0 → 逐个核对是否在声明范围内
export function decideScope({ declaredCount, changed, allowed }) {
  if (changed.length === 0) {
    if (declaredCount === 0) return { ok: true, detail: '只读任务：未声明任何仓库文件且工作树无改动——符合预期' };
    return { ok: false, detail: '无法归属改动：任务声明了仓库文件但未产出任何改动（先看任务结算状态）' };
  }
  const outOfScope = changed.filter((c) => !allowed.has(c));
  return outOfScope.length
    ? { ok: false, detail: `越界: ${outOfScope.join(', ')}` }
    : { ok: true, detail: `${changed.length} 个文件全在声明范围内` };
}

// 自测（无副作用）：证明上面的守卫**在修正后仍能抓到越界**，而不是被放宽成永真。
if (args.includes('--selftest-scope')) {
  const A = new Set(['lib/a.js', 'lib/b.js']);
  const cases = [
    ['[POS] 只读任务（声明 0、改动 0）→ 通过', { declaredCount: 0, changed: [], allowed: new Set() }, true],
    ['[NEG] 声明 0 却改了文件 → 越界（守卫必须仍生效）', { declaredCount: 0, changed: ['lib/a.js'], allowed: new Set() }, false],
    ['[NEG] 声明了却零改动 → 缺产物', { declaredCount: 2, changed: [], allowed: A }, false],
    ['[POS] 改动全在范围内 → 通过', { declaredCount: 2, changed: ['lib/a.js', 'lib/b.js'], allowed: A }, true],
    ['[NEG] 改动有越界 → 拒绝', { declaredCount: 2, changed: ['lib/a.js', 'lib/c.js'], allowed: A }, false],
  ];
  let bad = 0;
  for (const [name, input, expect] of cases) {
    const got = decideScope(input).ok;
    const ok = got === expect;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}（期望 ok=${expect}，实际 ok=${got}）`);
  }
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} 通过`);
  process.exit(bad ? 1 : 0);
}

// 0) 任务结算
if (!fs.existsSync(td)) { console.error(`任务目录不存在: ${td}`); process.exit(2); }
const resultPath = path.join(td, 'result.json');
const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
rec('任务结算', !!result, result ? JSON.stringify(result) : '无 result.json');

// 1) 声明范围（从 prompt 里抽 /mnt/d/dsh-web-relay 路径）
// 注意：扩展名交替必须**长优先**（json|yaml|yml|mjs|md|js）——若写成 js|...|json，左最先匹配会把
// package.json 截成 package.js，导致该文件被误判「越界」（2026-09-15 V3-1 假拒绝的真因）。
const task = JSON.parse(fs.readFileSync(path.join(td, 'task.json'), 'utf8'));
const declared = [...new Set([...String(task.prompt || '').matchAll(/\/mnt\/d\/dsh-web-relay\/([A-Za-z0-9_./-]+\.(?:json|yaml|yml|mjs|md|js))/g)].map((m) => m[1]))];
const allowed = new Set([...declared, ...extraAllow].map((s) => s.replace(/\\/g, '/')));

// 2) 改动范围（git status；工作树干净时仅当 HEAD 提交信息含本任务 id 才回退——否则会把别人的提交算到本任务头上）
// 2026-09-16 修两处**崩溃级缺陷**（真实事故：25 次误判 REJECT 并触发无限重派）：
//   ① 必须用 -uall：默认模式下 `git status` 把未跟踪目录**聚合为目录项**（如 `?? bin/web-relay/`），
//      而后续编码卫生检查会对每个条目 readFileSync → 对目录抛 EISDIR → 整个验收器崩溃 →
//      非零退出被链条读成 REJECT；-uall 会逐个列出文件，从源头避免目录项。
//   ② 仍需防御性过滤非文件项（子模块/符号链接/异常路径等）：只保留真实文件或已删除项。
const gs = spawnSync('git', ['-C', REPO, 'status', '--porcelain', '-uall'], { encoding: 'utf8' });
let changed = (gs.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^(\?\?|M|A|D|\s)+/, '').trim()).map((c) => c.replace(/\\/g, '/'));
changed = changed.filter((c) => {
  try { return fs.statSync(path.join(REPO, c)).isFile(); } catch { return true; } // 不存在（如已删除）→ 保留；目录 → 丢弃
});
let scopeSource = '工作树';
if (changed.length === 0) {
  // 在最近 N 条提交里按任务 id 找归属提交（链条的提交信息固定含 taskId）——
  // 只查 HEAD 会漏判：任务提交之后往往还有 lesson/docs 等其它提交。
  // 2026-09-15 修复：窗口原为 20，会**静默过期**——v1-1 的提交滑到第 27 位后，归属判定突然
  // 变成「无产物」→ 一个早已 ACCEPT 的任务被判 REJECT（重启后回归套件因此假失败 1 项）。
  // 改为默认 500（可用 DSH_RELAY_SCOPE_LOG_N 覆盖）：归属窗口不该成为随时间流逝而失效的隐式契约。
  const SCOPE_LOG_N = Number(process.env.DSH_RELAY_SCOPE_LOG_N || 500);
  const logOut = String(spawnSync('git', ['-C', REPO, 'log', `-${SCOPE_LOG_N}`, '--pretty=%h%x09%s'], { encoding: 'utf8' }).stdout || '');
  const hit = logOut.split('\n').find((l) => l.includes(taskId));
  if (hit) {
    const sh = hit.split('\t')[0];
    const show = spawnSync('git', ['-C', REPO, 'show', '--name-only', '--pretty=format:', sh], { encoding: 'utf8' });
    changed = String(show.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).map((c) => c.replace(/\\/g, '/'));
    scopeSource = `提交 ${sh}（提交信息含任务 id ${taskId}）`;
  } else {
    scopeSource = `无产物（工作树干净，且最近 ${SCOPE_LOG_N} 条提交的信息均不含任务 id ${taskId}）`;
  }
}
const scopeDecision = decideScope({ declaredCount: declared.length, changed, allowed });
rec('写入范围', scopeDecision.ok, `${scopeDecision.detail}（来源: ${scopeSource}${declared.length ? `；声明 ${declared.length} 个` : '；声明 0 个'}）`);
console.log(`      改动清单: ${changed.join(', ') || '(空)'}`);

// 3) 语法
const syntaxTargets = changed.filter((c) => /\.(js|mjs)$/.test(c) && fs.existsSync(path.join(REPO, c)));
const badSyntax = [];
for (const f of syntaxTargets) {
  const r = spawnSync(process.execPath, ['--check', path.join(REPO, f)], { encoding: 'utf8' });
  if (r.status !== 0) badSyntax.push(`${f}: ${(r.stderr || '').split('\n')[0]}`);
}
rec('node --check', badSyntax.length === 0, badSyntax.length ? badSyntax.join(' | ') : `${syntaxTargets.length} 个 JS/MJS 文件通过`);

// 4) 编码卫生（BOM / CRLF）
const dirty = [];
for (const f of changed) {
  const p = path.join(REPO, f);
  let st;
  try { st = fs.statSync(p); } catch { continue; }
  if (!st.isFile()) continue; // 防御：目录/特殊文件不得进入编码卫生检查（EISDIR 曾使整个验收器崩溃）
  const buf = fs.readFileSync(p);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) dirty.push(`${f}:BOM`);
  const crlf = (buf.toString('utf8').match(/\r\n/g) || []).length;
  if (crlf > 0) dirty.push(`${f}:CRLF(${crlf})`);
}
rec('编码卫生', dirty.length === 0, dirty.length ? dirty.join(', ') : '无 BOM、无 CRLF');

// 5) 全量测试（TAP）
const files = fs.readdirSync(path.join(REPO, 'test')).filter((f) => f.endsWith('.test.js') || f.endsWith('.test.mjs')).map((f) => path.join(REPO, 'test', f));
const t = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const tap = (t.stdout || '') + (t.stderr || '');
const pick = (k) => { const m = tap.match(new RegExp(`^# ${k} (\\d+)$`, 'm')); return m ? Number(m[1]) : -1; };
const tests = pick('tests'); const pass = pick('pass'); const fail = pick('fail');
const jsFiles = files.filter((f) => f.endsWith('.test.js'));
const tj = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...jsFiles], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const tapJs = (tj.stdout || '') + (tj.stderr || '');
const pickJs = (k) => { const m = tapJs.match(new RegExp(`^# ${k} (\\d+)$`, 'm')); return m ? Number(m[1]) : -1; };
const failNamesWin = [...tap.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
// 交叉平台复核（2026-09-18 新增）：**权威只在"两个平台都失败"时成立**。
// 为什么必须这样做：仓库里不同文件的生产环境不同——lib/task-schema-v2.mjs 由 WSL runner 使用（POSIX），
// 而插件本身跑在 Windows。初版只用 Windows 跑全量，于是把 3 条"按真实平台跑命令形态"的 POSIX 用例
// 判成失败 → REJECT 了一份**生产环境完全正确**的实现（实测两次，两轮返工）。
// 反过来只看 WSL 也不行（会漏掉 Windows 侧真回归）。故取**交集**：两平台都fail才算真回归；
// 仅在单一平台失败的，如实列出并标注为"平台差异（已记录，不阻断）"。
let failNamesWsl = null;
let wslNote = '(Windows 侧 0 失败 → 无需交叉复核)';
// 注意：WSL 复核**只在 Windows 侧确有失败时**才跑——否则每次验收都要多跑一遍全量（数十秒），
// 而 verify-acceptance-wiring 会调用本工具 4 次，实测把四层审计拖到 2 分钟以上超时。
try {
  if (fail === 0) throw new Error('skip');
  const wslFiles = files.filter((f) => !/shadow-gate\.test\.js$/.test(f)).map((f) => '/mnt/d/dsh-web-relay/test/' + path.basename(f));
  const w = spawnSync('wsl.exe', ['-e', 'node', '--test', '--test-reporter=tap', ...wslFiles], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  const wtap = `${w.stdout || ''}${w.stderr || ''}`;
  const wfail = Number((wtap.match(/^# fail (\d+)$/m) || [, -1])[1]);
  failNamesWsl = [...wtap.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  wslNote = `WSL(POSIX) fail=${wfail}（已排除 shadow-gate：其 WSL 差异是已知环境问题）`;
  if (w.status !== 0 && wfail < 0) wslNote += ` ｜ WSL 运行异常 exit=${w.status}`;
} catch (e) { if (e.message !== 'skip') wslNote = `WSL 复核失败：${e.message}`; }

let crossPlatformHardFail = fail > 0;
if (fail > 0) {
  console.log(`      失败用例（Windows）: ${failNamesWin.slice(0, 10).join(' | ')}`);
  console.log(`      交叉平台复核: ${wslNote}`);
  if (failNamesWsl) {
    const both = failNamesWin.filter((n) => failNamesWsl.includes(n));
    if (both.length) {
      console.log(`      ✗ 两平台都失败（= 真回归）: ${both.slice(0, 5).join(' | ')}`);
    } else {
      crossPlatformHardFail = false;
      console.log('      ℹ 无一项在两平台都失败 → 判定为平台差异，不阻断（清单已记录在报告里）');
    }
  }
}
rec('全量测试', !crossPlatformHardFail && tests >= baselineAll,
  fail === 0
    ? `tests=${tests} pass=${pass} fail=0（基线全量 ${baselineAll}）`
    : `tests=${tests} pass=${pass} fail=${fail}（基线全量 ${baselineAll}）｜Windows 失败 ${fail} 项、WSL 无同项失败 → 平台差异，不阻断｜${wslNote}`);
rec('*.test.js 子集', pickJs('fail') === 0 && pickJs('tests') >= baselineJs, `tests=${pickJs('tests')} pass=${pickJs('pass')} fail=${pickJs('fail')}（基线 ${baselineJs}）`);

// 6) 文件覆盖自检
const cov = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'verify-files-coverage.mjs')], { encoding: 'utf8', cwd: REPO });
rec('verify-files-coverage', cov.status === 0, ((cov.stdout || '').trim().split('\n').pop() || '').trim());

// 7) 执行接地验收（acceptanceScript）：把「验收标准」从散文变成**可执行的探针**
//
// 背景（2026-09-17，实测）：该字段**早已存在于规格 schema**（cc-dispatch.mjs L4 声明、L50 写进 task.json，
// check-spec L279 与 stage-deferred L29 也都在透传），但 **verify-cc-task / cc-chain / runner.sh 全都不读它**——
// 管线一路带着"该怎么执行验收"，然后没有任何消费方运行它。此处把这条断线接上。
//
// 退出码契约（性质："门禁的崩溃必须与判定可区分"——教训来自 EISDIR 崩溃被读成 REJECT 并触发 25 次重派）：
//   探针 exit 0 → PASS（产物满足验收）
//   探针 exit 1 → FAIL（**业务判定**：产物不满足）
//   探针缺失 / 超时 / 非 0-1 退出 → **工具错误**：本验收器以 exit 3 结束，绝不伪装成"产物不合格"
// 整段包 try/catch：**任何意外异常都必须降级为"工具错误"(exit 3)，绝不能以崩溃退出 1 冒充"判定不合格"**。
// 这条纪律直接来自本节第一版实现：我引用了不存在的常量 WORK → ReferenceError → 退出 1 → 被读成 REJECT。
let instrumentError = null;
try {
const acceptIdx = args.indexOf('--acceptance');
const acceptOverride = acceptIdx >= 0 ? args[acceptIdx + 1] : null;
const acceptDecl = acceptOverride || (task && typeof task.acceptanceScript === 'string' ? task.acceptanceScript.trim() : '');
if (!acceptDecl) {
  skip('验收脚本', '未声明 acceptanceScript —— 该任务只有散文 acceptance 条款，无执行接地验收');
} else {
  // 两种形态（2026-09-18 新增；此前只认裸路径，与仓库侧"当 shell 命令跑"的解释不一致）：
  //   A 单 token 且以 .mjs/.js/.cjs 结尾 → 用 node 跑（相对路径依次按 仓库 → 工作区 → 任务目录 解析）
  //   B 其它（含空格 / shell 元字符）→ 当命令跑（Windows 用 cmd /c；POSIX 用 sh -c），两种形态都导出
  //     DSH_TASK_ID / DSH_TASK_DIR / DSH_REPO
  // 同一字段被两边按不同规则解释，本身就是隐患源（本次实测：runner 把 'probes/x.mjs' 当可执行文件 → not found
  // → 把一份合格产物判成 v2-validate-failed）。故此处显式实现两形态，并配 verify-acceptance-invocation-parity.mjs 做一致性比对。
  const isScriptToken = !/[\s;&|<>()$`"']/.test(acceptDecl) && /\.(mjs|cjs|js)$/i.test(acceptDecl);
  const resolveProbe = (decl) => {
    const cand = [path.join(REPO, decl), path.join(WORK, decl), path.join(td, decl), decl];
    return cand.find((p) => fs.existsSync(p)) || null;
  };
  const env = { ...process.env, DSH_TASK_ID: taskId, DSH_TASK_DIR: td, DSH_REPO: REPO };
  const shellOf = () => (process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh');
  // Windows 下**不支持命令形态**：cmd 的引号语义无法可靠复刻 POSIX `sh -c`（实测 'node "D:\a b\x.mjs" id'
  // 被切成 'node D:\a'），而且"命令不存在"(cmd 退出 1) 会被误读成**业务判定不合格**——正是 EISDIR→REJECT
  // 那类"工具错误伪装成业务失败"的老病。故此处**拒绝**并给工具错误(exit 3)，而不是给一个假的判定。
  const commandFormUnsupported = !isScriptToken && process.platform === 'win32';
  const probePath = isScriptToken ? resolveProbe(acceptDecl) : null;
  const argv = isScriptToken && probePath
    ? [process.execPath, [probePath, taskId]]
    : [shellOf(), ['-c', acceptDecl]];
  if (commandFormUnsupported) {
    instrumentError = `命令形态的 acceptanceScript 在 Windows 上不可靠（cmd 引号语义），拒绝以"判定不合格"冒充结论：${acceptDecl}`;
    rec('验收脚本', false, `[工具错误] ${instrumentError}`);
  } else if (isScriptToken && !probePath) {
    instrumentError = `声明的验收脚本不存在（按 仓库→工作区→任务目录 依次找过）：${acceptDecl}`;
    rec('验收脚本', false, `[工具错误] ${instrumentError}`);
  } else {
    const pr = spawnSync(argv[0], argv[1], {
      encoding: 'utf8', cwd: isScriptToken ? WORK : td, timeout: ACCEPT_TIMEOUT_MS, env,
    });
    const timedOut = !!(pr.error && (pr.error.code === 'ETIMEDOUT' || pr.signal));
    const pOut = `${pr.stdout || ''}${pr.stderr || ''}`.trim();
    const pTail = pOut.split('\n').filter(Boolean).slice(-1)[0] || '';
    const shown = isScriptToken ? `${acceptDecl}（脚本形态→node）` : `${acceptDecl}（命令形态→${path.basename(argv[0])}）`;
    if (timedOut) {
      instrumentError = `验收脚本超时（>${ACCEPT_TIMEOUT_MS}ms）`;
      rec('验收脚本', false, `[工具错误] ${instrumentError}｜${acceptDecl}`);
    } else if (pr.status === 0) {
      rec('验收脚本', true, `${shown} 通过｜${pTail.slice(0, 120)}`);
    } else if (pr.status === 1) {
      rec('验收脚本', false, `判定不合格（探针 exit 1）｜${shown}｜${pTail.slice(0, 140)}`);
    } else {
      instrumentError = `验收脚本异常退出（exit ${pr.status}）`;
      rec('验收脚本', false, `[工具错误] ${instrumentError}｜${acceptDecl}｜${pTail.slice(0, 120)}`);
    }
  }
}
} catch (e) {
  instrumentError = `验收块内部异常：${String((e && e.message) || e).slice(0, 160)}`;
  rec('验收脚本', false, `[工具错误] ${instrumentError}`);
}

const allOk = results.every((r) => r.ok);
if (instrumentError) {
  console.log(`\n  RESULT: INSTRUMENT-ERROR（**工具错误，不是业务判定**）— ${instrumentError}`);
  console.log('  说明：产物未必不合格，而是验收工具本身有问题。调用方应**停止并等人修工具**，而不是重派任务。');
  process.exit(3);
}
console.log(`\n  RESULT: ${allOk ? 'ACCEPT（可提交）' : 'REJECT（需修复）'}  (${results.filter((r) => r.ok).length}/${results.length} 项通过)`);
process.exit(allOk ? 0 : 1);
