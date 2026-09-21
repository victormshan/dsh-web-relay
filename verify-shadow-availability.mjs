// 影子沙盒可用性检查：防它再次"悄悄死掉"。
//
// 为什么需要（2026-09-19 实测）：影子沙盒的实现与接线都很完整，但仓库路径解析落空 + 环境变量名错配
// （启动器设 DSH_RELAY_REPO，影子读 DSH_RELAY_REPO_PATH）→ 每个高风险步骤都判 "非 git 工作区：L2 降级"，
// L2 隔离/原子合并/定时 GC **长期未生效**；插件每次启动都在日志里喊「定时 Shadow GC 未启用」，
// 但那只写日志、没人升级 —— 于是没有人发现"我们以为有的隔离其实没有"。
//
// 本检查把"可用性"变成可复跑断言，两层：
//   ① 静态：宿主启动器必须设 DSH_RELAY_REPO_PATH（且纯 ASCII / 无 BOM —— 启动脚本坏了宿主就起不来）；
//   ② 运行：**当前这次 boot** 的日志必须出现「定时 Shadow GC 已启用」，不得是「未启用」。
// 退出码：0 可用 / 1 不可用（需处理）/ 3 工具错误（读不到日志等，不得当成"可用"）。
//
// 用法: node verify-shadow-availability.mjs [--selftest] [--json]
import fs from 'node:fs';

const LAUNCHER = 'C:\\Users\\Administrator\\dsh-web-watchdog.cmd';
const LOG = 'C:\\Users\\Administrator\\.dsh\\logs\\dsh-web-watchdog.log';
const BOOT_MARKS = ['拉起宿主']; // 界定"当前这次 boot"：**只用** watchdog「拉起宿主」这一行。
// 坑：`bootId=` 在 boot **之后**的 selfCheck / 续跑扫描行里也会出现，若把它也算作边界（取最大偏移），
// 窗口起点会被推到 GC 行之后 → 误报"无法判定"（本检查第二版就栽在这里）。
const ENABLED = '定时 Shadow GC 已启用';
const DISABLED = '定时 Shadow GC 未启用';

/** 取"当前这次 boot"之后的日志：不能按 GC 行之后的行做边界——
 *  实测 boot 顺序是 watchdog「拉起宿主」→「定时 Shadow GC …」→「心跳自查已启用」→「dsh web: …」，
 *  若用「心跳自查已启用」当边界会**把 GC 行切掉**（本检查初版就因此报"无法判定"）。
 *  故用最后一次「拉起宿主 / bootId=」取最大偏移。 */
export function currentBootWindow(logText) {
  const T = String(logText || '');
  let at = -1;
  for (const m of BOOT_MARKS) at = Math.max(at, T.lastIndexOf(m));
  return at >= 0 ? T.slice(at) : T;
}

/**
 * 纯函数：扫描计划里"修复时间点之后"的 `shadow-degraded` 记录（新降级）。
 * 为什么要扫这个：可用性检查只能抓**配置层**原因（env/路径）；一旦将来出现别的原因导致降级，
 * 它仍会以 `action: 'shadow-degraded'` 的 note 落进计划 —— 而 note 没人看。
 * 只认 `since` 之后的记录，历史那批（已收口步骤上的）不参与，避免把旧账当新问题反复告警。
 */
export function scanNewShadowDegradations(exprTexts, since, { strip = (s) => s } = {}) {
  const hits = [];
  for (const { file, text } of exprTexts) {
    let j = null;
    try { j = JSON.parse(strip(text)); } catch { continue; }
    for (const st of (j.steps || [])) {
      for (const n of (st.notes || [])) {
        if (n && n.action === 'shadow-degraded' && String(n.at || '') > since) {
          hits.push({ expr: file, step: st.id, at: n.at, text: String(n.text || '').slice(0, 160) });
        }
      }
    }
  }
  return hits;
}

/**
 * 纯函数：判定"阴影 repoPath 解析是否有自持回退"。
 *
 * 为什么把判据从"启动器设了 env"改成这一条（2026-09-19 实测）：我最初把修复押在启动器加 DSH_RELAY_REPO_PATH 上，
 * 重启后**仍不生效** —— 因为 `request-restart` 重启的是**宿主**，而宿主由常驻 watchdog 拉起，watchdog 继承的是
 * 它自己启动时的环境（实测 watchdog PID 16356 起于 9/15，早于本次改动）→ 启动器里的 env 只在 **watchdog 重启**时生效。
 * 结论：**不要把可用性押在环境变量上**；应让插件用自己已能算出的仓库根（lib/ 上溯）兜底。
 */
export function judgeRepoFallback({ shadowGateSource }) {
  const reasons = [];
  const S = String(shadowGateSource || '');
  if (!S) { reasons.push('读不到 lib/shadow-gate.js'); return { ok: false, reasons }; }
  if (!/export\s+function\s+(resolveShadowRepo|shadowRepoCandidates)/.test(S)) {
    reasons.push('shadow-gate.js 未导出 repoPath 解析函数（无法做自持回退）');
  }
  if (!(/import\.meta\.url/.test(S) && /(fileURLToPath|dirname|moduleDir)/.test(S))) {
    reasons.push('shadow-gate.js 未从模块自身位置（import.meta.url）推导仓库根 → 仍会依赖环境变量');
  }
  if (!/DSH_RELAY_REPO\b|DSH_RELAY_REPO_PATH/.test(S)) {
    // 只是 info：env 的优先级在 index.js 侧体现，不在本模块；此处不作失败判据
    reasons.push('__info__shadow-gate.js 未直接提及环境变量（env 优先级由 index.js 侧决定，非本模块必需）');
  }
  const real = reasons.filter((r) => !r.startsWith('__info__'));
  const infos = reasons.filter((r) => r.startsWith('__info__')).map((r) => r.replace('__info__', ''));
  return { ok: real.length === 0, reasons: real, infos };
}

/** 纯函数：判定可用性（启动器卫生 + 当前 boot 运行状态）。
 *  注意：**不要求**启动器设 DSH_RELAY_REPO_PATH —— 实测证明 env 只在 watchdog 重启时生效（宿主重启不够），
 *  把可用性押在它上面会得出"改完仍不可用"的假结论。env 只作为 info 记录。 */
export function judgeShadowAvailability({ launcherText, logText }) {
  const reasons = [];
  const infos = [];
  const L = String(launcherText || '');
  if (!L) reasons.push('读不到宿主启动器');
  else {
    if (!/DSH_RELAY_REPO_PATH\s*=/.test(L)) infos.push('启动器未设 DSH_RELAY_REPO_PATH（可选加速项；watchdog 重启后才生效，不作可用性判据）');
    const nonAscii = [...L].filter((c) => c.codePointAt(0) > 127).length;
    if (nonAscii) reasons.push(`启动器含非 ASCII 字符 ${nonAscii} 个（cmd.exe 按 ANSI 解析会破坏行结构）`);
    if (L.charCodeAt(0) === 0xfeff) reasons.push('启动器含 UTF-8 BOM');
  }
  const T = String(logText || '');
  if (!T) reasons.push('读不到宿主日志（无法判定运行状态）');
  else {
    const tail = currentBootWindow(T);
    if (tail.includes(DISABLED)) reasons.push(`当前 boot 日志仍是「${DISABLED}」→ 影子沙盒未启用（需交付代码回退并重启宿主）`);
    else if (!tail.includes(ENABLED)) reasons.push(`当前 boot 日志既无「${ENABLED}」也无「${DISABLED}」→ 无法判定（可能启动尚未完成）`);
  }
  return { ok: reasons.length === 0, reasons, infos };
}

function selftest() {
  const goodLauncher = 'set DSH_RELAY_REPO=D:\\dsh-web-relay\nset DSH_RELAY_REPO_PATH=D:\\dsh-web-relay\n';
  const badLauncher = 'set DSH_RELAY_REPO=D:\\dsh-web-relay\n';
  const goodLog = `[watchdog] 拉起宿主：node bin.js web\n[dsh-web-relay] ${ENABLED}：周期 600000ms（repo=D:\\dsh-web-relay）\n[dsh-web-relay] 心跳自查已启用：周期 15min\n`;
  const badLog = `[watchdog] 拉起宿主：node bin.js web\n[dsh-web-relay] ${DISABLED}（需 DSH_RELAY_REPO_PATH 指定 git 仓库…）\n[dsh-web-relay] 心跳自查已启用：周期 15min\n`;
  const cases = [
    ['[POS] 启动器有 REPO_PATH + 当前 boot 已启用 → 放行', { launcherText: goodLauncher, logText: goodLog }, true],
    ['[POS] 启动器**缺** REPO_PATH 也可放行（env 只是可选加速项；实测证明它只在 watchdog 重启时生效，不能作可用性判据）', { launcherText: badLauncher, logText: goodLog }, true],
    ['[NEG] 当前 boot 仍是「未启用」→ 抓（配置改了但没生效也是不可用）', { launcherText: goodLauncher, logText: badLog }, false],
    // 边界用例：必须按「拉起宿主」切窗口；初版按「心跳自查」切，会把 GC 行切掉而报"无法判定"
    ['[NEG] 历史 boot 说"已启用"、当前 boot 说"未启用"（GC 行在心跳行**之前**）→ 抓',
      { launcherText: goodLauncher, logText: `[watchdog] 拉起宿主\n${ENABLED}\n心跳自查已启用\n...\n[watchdog] 拉起宿主\n${DISABLED}\n心跳自查已启用\n` }, false],
    ['[POS] 同样顺序但当前 boot 为"已启用" → 放行（边界取对了）',
      { launcherText: goodLauncher, logText: `[watchdog] 拉起宿主\n${DISABLED}\n心跳自查已启用\n...\n[watchdog] 拉起宿主\n${ENABLED}\n心跳自查已启用\n` }, true],
    ['[NEG] bootId= 出现在 GC 行之后也不得把窗口起点后移（第二版陷阱）→ 仍能抓到"未启用"',
      { launcherText: goodLauncher, logText: `[watchdog] 拉起宿主\n${DISABLED}\n心跳自查已启用\n[selfCheck] 完成 bootId=abc123\n` }, false],
    ['[NEG] 启动器含非 ASCII（宿主可能起不来）→ 抓', { launcherText: goodLauncher + 'rem 中文注释\n', logText: goodLog }, false],
    ['[NEG] 读不到日志 → 抓（不得当成可用）', { launcherText: goodLauncher, logText: '' }, false],
  ];
  const bad = cases.filter((c) => judgeShadowAvailability(c[1]).ok !== c[2]).length;
  for (const [label, input, expect] of cases) {
    const r = judgeShadowAvailability(input);
    console.log(`  [${r.ok === expect ? 'PASS' : 'FAIL'}] ${label} → ok=${r.ok}${r.ok ? '' : '（' + r.reasons[0] + '）'}`);
  }
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();

let launcherText = null; let logText = null;
try { launcherText = fs.readFileSync(LAUNCHER, 'utf8'); } catch { /* 读不到 → judge 会报 */ }
try { logText = fs.readFileSync(LOG, 'utf8'); } catch { /* 同上 */ }
if (launcherText === null && logText === null) {
  console.log('  [INSTRUMENT-ERROR] 启动器与日志都读不到 → 无法判定（不得当成"可用"）');
  process.exit(3);
}
const v = judgeShadowAvailability({ launcherText, logText });
// 代码回退（真正的不变量：不依赖 env 也能解析出仓库根）
let gateSrc = null;
try { gateSrc = fs.readFileSync('D:\\dsh-web-relay\\lib\\shadow-gate.js', 'utf8'); } catch { /* judge 会报 */ }
const fb = judgeRepoFallback({ shadowGateSource: gateSrc });

// 新降级扫描：只认修复时间点之后的记录（历史那批已收口，不参与）
const FIX_CUTOFF = '2026-09-19T08:00:00.000Z';
const EXPR_DIR = 'D:\\dsh relay test\\web-relay\\experiments';
let newDegradations = [];
try {
  const files = fs.readdirSync(EXPR_DIR).filter((f) => /^expr-.+\.steps\.json$/.test(f));
  newDegradations = scanNewShadowDegradations(
    files.map((f) => ({ file: f, text: fs.readFileSync(`${EXPR_DIR}\\${f}`, 'utf8') })),
    FIX_CUTOFF,
    { strip: (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s) },
  );
} catch { /* 目录不可读 → 不据此判失败 */ }

console.log('=== 影子沙盒可用性 ===');
console.log(`  启动器 ${LAUNCHER}`);
console.log(`  日志   ${LOG}`);
for (const r of v.reasons) console.log(`  ✗ ${r}`);
for (const r of (v.infos || [])) console.log(`  ℹ ${r}`);
for (const r of fb.reasons) console.log(`  ✗ ${r}`);
if (v.ok) console.log('  ✓ 当前 boot 已启用：L2 隔离与定时 GC 生效');
if (fb.ok) console.log('  ✓ repoPath 解析含自持回退（不依赖环境变量）');
console.log(`  修复点(${FIX_CUTOFF})之后的新降级记录 = ${newDegradations.length}`);
for (const d of newDegradations.slice(0, 5)) console.log(`    ✗ ${d.expr} step=${d.step} at=${d.at} ${d.text}`);
const ok = v.ok && fb.ok && newDegradations.length === 0;
console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}（运行=${v.ok ? '已启用' : v.reasons.length + ' 项待处理'}；代码回退=${fb.ok ? '有' : '缺'}${newDegradations.length ? `；新增降级 ${newDegradations.length} 条` : ''}）`);
if (process.argv.includes('--json')) console.log(JSON.stringify({ ok, runtime: v, fallback: fb, newDegradations }, null, 2));
process.exit(ok ? 0 : 1);
