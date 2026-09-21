// 链条定义解析器：把「收口器该用哪份链条定义」从硬编码中解耦出来。
//
// 背景（真实缺陷）：protocol-close-step.mjs 原先写死 `cc-chains/v1-v3.mjs`。
//   于是任何**新链条**收口时会静默退回旧定义 → defItem 为 null →
//   ① 拿不到该链条项的 taskId（只能依赖调用方显式传参）；
//   ② 绕过 L122「链条项在 chain-state 中无记录则拒绝收口」这条前置保护。
//   症状是「看起来收口成功，其实守卫没生效」，属静默降级 —— 与自动版本演化直接相关。
//
// 解析优先级（先到先得，且必须**实际存在**才算命中）：
//   ① env `DSH_CC_CHAIN_DEF`（显式指定；无人值守与测试用）
//   ② run-chain.cmd 实际引用的 `cc-chains/<name>.mjs`（真相取自调度器本身，避免两处定义漂移）
//   ③ 回退 `cc-chains/v1-v3.mjs`（保持既有行为不变）
//
// 纪律：纯函数只做字符串/存在性判断，便于夹具测试；IO 收在 loadChainDefPath 一处。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WORK_DEFAULT = 'D:\\dsh relay test';
export const RUN_CHAIN_CMD_DEFAULT = 'D:\\cc-tasks\\run-chain.cmd';
export const CHAIN_DEF_FALLBACK = 'v1-v3.mjs';

/** 从 run-chain.cmd 文本里取出被引用的链条定义文件名（取不到返回 null）。 */
export function parseChainDefFromCmd(cmdText) {
  if (typeof cmdText !== 'string' || cmdText === '') return null;
  // 允许 cc-chains/v4-a4.mjs 与 cc-chains\v4-a4.mjs；不匹配同目录下的 cc-chain.mjs（无 s，非 chains/）
  const m = cmdText.match(/cc-chains[\\/]([A-Za-z0-9._-]+\.mjs)/);
  return m ? m[1] : null;
}

/** 按优先级解析出真实存在的链条定义绝对路径；全都不存在时回退到 v1-v3。 */
export function resolveChainDefPath({
  env = {},
  cmdText = '',
  existsSync = fs.existsSync,
  work = WORK_DEFAULT,
} = {}) {
  const candidates = [];
  const fromEnv = env && env.DSH_CC_CHAIN_DEF ? String(env.DSH_CC_CHAIN_DEF) : '';
  if (fromEnv) candidates.push(fromEnv);
  const fromCmd = parseChainDefFromCmd(cmdText);
  if (fromCmd) candidates.push(path.join(work, 'cc-chains', fromCmd));
  candidates.push(path.join(work, 'cc-chains', CHAIN_DEF_FALLBACK));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return path.join(work, 'cc-chains', CHAIN_DEF_FALLBACK);
}

/** 一处 IO：读调度器 cmd → 交给纯函数解析。 */
export function loadChainDefPath({
  work = WORK_DEFAULT,
  cmdPath = RUN_CHAIN_CMD_DEFAULT,
  env = process.env,
  existsSync = fs.existsSync,
} = {}) {
  let cmdText = '';
  try { cmdText = fs.readFileSync(cmdPath, 'utf8'); } catch { /* 无调度器文件 → 走回退 */ }
  return resolveChainDefPath({ env, cmdText, existsSync, work });
}

// ---------------- 自检 ----------------
function selftest() {
  const cases = [];
  const t = (name, actual, expected) => cases.push({ name, actual, expected, ok: Object.is(actual, expected) });

  // parseChainDefFromCmd
  t('cmd: 正斜杠引用', parseChainDefFromCmd('node "D:\\x\\cc-chain.mjs" "cc-chains/v1-v3.mjs" --close-after-accept'), 'v1-v3.mjs');
  t('cmd: 反斜杠引用', parseChainDefFromCmd('node x.mjs cc-chains\\v4-a4.mjs --min-reviewer external'), 'v4-a4.mjs');
  t('cmd: 不得误匹配 cc-chain.mjs', parseChainDefFromCmd('"C:\\nvm4w\\node.exe" "D:\\dsh relay test\\cc-chain.mjs"'), null);
  t('cmd: 无引用', parseChainDefFromCmd('echo hi'), null);
  t('cmd: 非字符串', parseChainDefFromCmd(null), null);
  t('cmd: 空串', parseChainDefFromCmd(''), null);
  t('cmd: 多点文件名', parseChainDefFromCmd('cc-chains/v5.1-alpha.mjs'), 'v5.1-alpha.mjs');

  // resolveChainDefPath
  const W = 'D:\\work';
  const existsOnly = (...ok) => (p) => ok.includes(p);
  t('resolve: env 命中优先于 cmd',
    resolveChainDefPath({ env: { DSH_CC_CHAIN_DEF: 'D:\\env\\c.mjs' }, cmdText: 'cc-chains/v4-a4.mjs', existsSync: existsOnly('D:\\env\\c.mjs', 'D:\\work\\cc-chains\\v4-a4.mjs'), work: W }),
    'D:\\env\\c.mjs');
  t('resolve: env 不存在则降级到 cmd',
    resolveChainDefPath({ env: { DSH_CC_CHAIN_DEF: 'D:\\env\\missing.mjs' }, cmdText: 'cc-chains/v4-a4.mjs', existsSync: existsOnly('D:\\work\\cc-chains\\v4-a4.mjs'), work: W }),
    'D:\\work\\cc-chains\\v4-a4.mjs');
  t('resolve: cmd 指向的文件不存在 → 回退 v1-v3',
    resolveChainDefPath({ env: {}, cmdText: 'cc-chains/v9-nope.mjs', existsSync: existsOnly('D:\\work\\cc-chains\\v1-v3.mjs'), work: W }),
    'D:\\work\\cc-chains\\v1-v3.mjs');
  t('resolve: 全无命中 → 仍返回回退路径（不抛错）',
    resolveChainDefPath({ env: {}, cmdText: '', existsSync: () => false, work: W }),
    'D:\\work\\cc-chains\\v1-v3.mjs');
  t('resolve: 空 env/cmd 且 v1-v3 存在',
    resolveChainDefPath({ env: {}, cmdText: '', existsSync: existsOnly('D:\\work\\cc-chains\\v1-v3.mjs'), work: W }),
    'D:\\work\\cc-chains\\v1-v3.mjs');

  // 回归护栏：既有 run-chain.cmd 文本必须解析回 v1-v3（改坏调度器即失败）
  const realCmd = 'cd /d D:\\cc-tasks\r\n"C:\\nvm4w\\nodejs\\node.exe" "D:\\dsh relay test\\cc-chain.mjs" "cc-chains/v1-v3.mjs" --close-after-accept --min-reviewer web-gemini >> log 2>&1';
  t('回归: 真实 run-chain.cmd → v1-v3.mjs',
    resolveChainDefPath({ env: {}, cmdText: realCmd, existsSync: existsOnly('D:\\work\\cc-chains\\v1-v3.mjs'), work: W }),
    'D:\\work\\cc-chains\\v1-v3.mjs');

  const failed = cases.filter((c) => !c.ok);
  for (const c of cases) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        actual   = ${String(c.actual)}\n        expected = ${String(c.expected)}`}`);
  }
  console.log(`\nRESULT: ${cases.length - failed.length}/${cases.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();

// 直接执行（无 --selftest）时打印真实解析结果，便于人工/脚本核查
// 注意：Windows 下不能用 `file:///${argv[1]}` 字符串拼接比较（盘符大小写与转义不一致会静默不进入）
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && !process.argv.includes('--selftest')) {
  const p = loadChainDefPath();
  console.log(`链条定义解析结果: ${p}`);
  console.log(`  env DSH_CC_CHAIN_DEF = ${process.env.DSH_CC_CHAIN_DEF || '(未设置)'}`);
  console.log(`  调度器 = ${RUN_CHAIN_CMD_DEFAULT}`);
}
