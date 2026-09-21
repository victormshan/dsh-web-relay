// 验证 chain-def-resolve.mjs：① 自检真能抓到回归（变异测试）② 真实 IO 解析正确 ③ env 覆盖生效
// 纪律来源（本会话教训）：只跑「全绿」不算验证过 —— 必须证明守卫在**故意改坏**时会红。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WORK = 'D:\\dsh relay test';
const SRC = path.join(WORK, 'chain-def-resolve.mjs');
const original = fs.readFileSync(SRC, 'utf8');
const tmpFiles = [];
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  ok ? pass++ : fail++;
};

function runSelftestOn(file) {
  const r = spawnSync(process.execPath, [file, '--selftest'], { cwd: WORK, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/RESULT: (\d+)\/(\d+)/);
  return { code: r.status, out, passed: m ? Number(m[1]) : -1, total: m ? Number(m[2]) : -1 };
}

function runMutation(name, from, to) {
  if (!original.includes(from)) {
    check(`变异可注入: ${name}`, false, `源文件中找不到待替换片段: ${from.slice(0, 60)}`);
    return;
  }
  const file = path.join(WORK, `_mut-${name}.mjs`);
  fs.writeFileSync(file, original.replace(from, to), 'utf8');
  tmpFiles.push(file);
  const r = runSelftestOn(file);
  check(`变异被抓到: ${name}（应红）`, r.code !== 0, `exit=${r.code} RESULT=${r.passed}/${r.total}`);
}

console.log('=== ① 基线自检必须全绿 ===');
{
  const r = runSelftestOn(SRC);
  check('基线 --selftest 全绿且 exit 0', r.code === 0 && r.passed === r.total && r.total > 0, `exit=${r.code} RESULT=${r.passed}/${r.total}`);
}

console.log('=== ② 变异测试：改坏守卫必须变红（否则守卫是假的）===');
runMutation('fallback-bogus', "const CHAIN_DEF_FALLBACK = 'v1-v3.mjs';", "const CHAIN_DEF_FALLBACK = 'v9-bogus.mjs';");
runMutation('regex-broken', 'const m = cmdText.match(/cc-chains[\\\\/]([A-Za-z0-9._-]+\\.mjs)/);', 'const m = null;');
runMutation('no-exists-check', 'if (existsSync(c)) return c;', 'return c;');

console.log('=== ③ 真实 IO：读真实 run-chain.cmd ===');
{
  const r = spawnSync(process.execPath, ['-e', "import('./chain-def-resolve.mjs').then(m=>{const p=m.loadChainDefPath();console.log(p)})"], { cwd: WORK, encoding: 'utf8' });
  const got = (r.stdout || '').trim();
  check('真实解析 = cc-chains\\v1-v3.mjs', got === path.join(WORK, 'cc-chains', 'v1-v3.mjs'), `实际=${got} stderr=${(r.stderr || '').slice(0, 200)}`);
}

console.log('=== ④ env 覆盖：模拟未来 v4 链条 ===');
{
  const okPath = path.join(WORK, 'cc-chains', 'v1-v3.mjs');
  const r = spawnSync(process.execPath, ['-e', "import('./chain-def-resolve.mjs').then(m=>{console.log(m.loadChainDefPath())})"], {
    cwd: WORK, encoding: 'utf8', env: { ...process.env, DSH_CC_CHAIN_DEF: okPath },
  });
  check('env 指定存在文件 → 优先采用', (r.stdout || '').trim() === okPath, `实际=${(r.stdout || '').trim()}`);
  const r2 = spawnSync(process.execPath, ['-e', "import('./chain-def-resolve.mjs').then(m=>{console.log(m.loadChainDefPath())})"], {
    cwd: WORK, encoding: 'utf8', env: { ...process.env, DSH_CC_CHAIN_DEF: path.join(WORK, 'cc-chains', 'nope.mjs') },
  });
  check('env 指定不存在文件 → 降级到调度器定义', (r2.stdout || '').trim() === path.join(WORK, 'cc-chains', 'v1-v3.mjs'), `实际=${(r2.stdout || '').trim()}`);
}

console.log('=== ⑤ 直接执行分支有输出（Windows 路径比较回归）===');
{
  const r = spawnSync(process.execPath, [SRC], { cwd: WORK, encoding: 'utf8' });
  check('无 --selftest 时打印解析结果', /链条定义解析结果: .*v1-v3\.mjs/.test(r.stdout || ''), `stdout=${(r.stdout || '').slice(0, 200)}`);
}

for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* 已删 */ } }
console.log(`\nRESULT: ${pass}/${pass + fail} 通过${fail ? `（${fail} 失败）` : ''}`);
process.exit(fail ? 1 : 0);
