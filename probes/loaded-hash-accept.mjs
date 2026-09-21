// ⑤b 的**执行接地验收探针**：把该任务的验收条款变成可执行检查（由 verify-cc-task 第 7 项调用）。
//
// 契约：node loaded-hash-accept.mjs <taskId>   → exit 0 通过 / exit 1 判定不合格 / 其它 = 工具错误
//       node loaded-hash-accept.mjs --selftest → 两侧自检（好夹具必通过、坏夹具必失败），通过则 exit 0
//
// 注意：本探针在**任务验收时**运行——此时仓库已被修改，但宿主**尚未重启**，
// 所以它不能去查 /health-check 的运行时值（那是交付+重启之后由 verify-delivery-live.mjs 负责的）。
// 它检查的是"改动是否按规格落地"，并顺带把 ⑥ 登记的过时注释债变成**硬门禁**。
import fs from 'node:fs';
import path from 'node:path';

// 仓库根按平台取（2026-09-18 实测教训）：runner 在生产路径（WSL/POSIX）执行本探针，
// 主 agent 的验收器在 Windows 上执行它 —— 硬编码 D:\ 会让 WSL 侧直接判失败。
const REPO = process.env.DSH_REPO || (process.platform === 'win32' ? 'D:\\dsh-web-relay' : '/mnt/d/dsh-web-relay');

/** 纯检查：在一个给定的仓库根上核验规格条款。root 参数化是为了让 --selftest 能在夹具上跑。 */
export function checkRepo(root) {
  const results = [];
  const read = (p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return null; } };
  const idx = read('lib/index.js');
  const sc = read('lib/selfcheck.mjs');
  const test = read('test/selfcheck.test.js');

  results.push({ name: 'lib/index.js 可读', ok: !!idx });
  results.push({ name: 'lib/index.js 暴露 loadedLibHash', ok: !!idx && /loadedLibHash/.test(idx) });
  results.push({ name: 'lib/index.js 暴露 loadedFrom（便于排查哪份副本在跑）', ok: !!idx && /loadedFrom/.test(idx) });
  results.push({ name: '使用 sha256 计算指纹', ok: !!idx && /createHash\(\s*['"]sha256['"]\s*\)/.test(idx) });
  results.push({ name: '未硬编码 D:\\ 路径（应用 import.meta.url 定位）', ok: !!idx && !/['"][A-Za-z]:\\\\/.test(idx) });
  results.push({ name: '自检契约含 loadedLibHash', ok: !!sc && /loadedLibHash/.test(sc) });
  // 这条把 ⑥ 的 knownDebt 变成硬门禁：过时注释必须被改正
  results.push({ name: '[NEG-项] 过时注释「探针超时 2000ms」已改正', ok: !!idx && !/探针超时 2000ms/.test(idx) });
  results.push({ name: '注释已指出权威来源 bin/watchdog.mjs', ok: !!idx && /watchdog\.mjs/.test(idx) });
  results.push({ name: 'test/selfcheck.test.js 新增了 loadedLibHash 相关用例', ok: !!test && /loadedLibHash/.test(test) });
  return results;
}

const args = process.argv.slice(2);

if (args.includes('--selftest')) {
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lhprobe-'));
  const mk = (name, { comment = 'ok', field = true, contract = true, test = true, hardcoded = false }) => {
    const root = path.join(tmp, name);
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    const head = hardcoded ? "const D='D:\\\\x';\n" : "import { fileURLToPath } from 'node:url';\n";
    fs.writeFileSync(path.join(root, 'lib/index.js'),
      head
      + `${field ? 'const loadedLibHash=X; const loadedFrom=Y;\n' : ''}`
      + `// watchdog 探针超时 ${comment === 'stale' ? '2000ms' : '4000ms'}（权威来源 bin/watchdog.mjs）\n`
      + `const h = createHash('sha256');\n`, 'utf8');
    fs.writeFileSync(path.join(root, 'lib/selfcheck.mjs'), contract ? "export const SELFCHECK_REQUIRED_HEALTH_FIELDS = ['loadedLibHash'];\n" : "export const SELFCHECK_REQUIRED_HEALTH_FIELDS = [];\n", 'utf8');
    fs.writeFileSync(path.join(root, 'test/selfcheck.test.js'), test ? "test('loadedLibHash', () => {});\n" : "test('x', () => {});\n", 'utf8');
    return root;
  };

  const good = checkRepo(mk('good', {}));
  const stale = checkRepo(mk('stale', { comment: 'stale' }));
  const noField = checkRepo(mk('nofield', { field: false }));
  const noContract = checkRepo(mk('nocontract', { contract: false }));
  const hardcoded = checkRepo(mk('hardcoded', { hardcoded: true }));
  const cases = [
    ['[POS] 合规夹具 → 全部通过', good.every((r) => r.ok)],
    ['[NEG] 过时注释仍在 → 必须抓到', stale.some((r) => !r.ok)],
    ['[NEG] 未暴露字段 → 必须抓到', noField.some((r) => !r.ok)],
    ['[NEG] 未纳入自检契约 → 必须抓到', noContract.some((r) => !r.ok)],
    ['[NEG] 硬编码 D:\\ 路径 → 必须抓到', hardcoded.some((r) => !r.ok)],
  ];
  let bad = 0;
  for (const [n, ok] of cases) { if (!ok) bad++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}`); }
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
}

const taskId = args[0];
if (!taskId) { console.error('usage: node loaded-hash-accept.mjs <taskId> | --selftest'); process.exit(2); }
const results = checkRepo(REPO);
for (const r of results) console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name}`);
const failed = results.filter((r) => !r.ok);
console.log(`  RESULT: ${results.length - failed.length}/${results.length}${failed.length ? ' → 判定 FAIL' : ' → 判定 PASS'}`);
process.exit(failed.length ? 1 : 0);
