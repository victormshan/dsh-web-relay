// ⑥ 实测数字/关键事实的复跑门禁：把报告与注释里的数字变成**可复跑**的断言。
//
// 防的是本会话反复出现的一类错误——把过时来源当成事实：
//   · cc 报告引用 lib/index.js 注释里的「探针超时 2000ms」，而权威实现是 4000ms（我回源才推翻它）；
//   · 我自己的分析脚本复刻了旧调用逻辑，于是给出"cc 修复失败"的**假失败**；
//   · 复核脚本 off-by-N 切片，得出"案例3 仍 0/16"的**假结论**。
// 机制：claims.json 登记每条事实的**复跑方式**；本脚本重跑并比对。
// 类型：file-regex（捕获组须等于 expect；expect 为 null 只要求命中）、file-not-regex（不得命中）、cmd（退出码 + 输出包含）。
// 用法: node verify-claims.mjs [--json]
//       node verify-claims.mjs --selftest     # 两侧自检（合法通过 / 各类漂移必须被报出）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { skipIfChainLive } from './chain-lock.mjs';

const WORK = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '));
const REPO = 'D:\\dsh-web-relay';
const CLAIMS = JSON.parse(fs.readFileSync(path.join(WORK, 'claims.json'), 'utf8')).claims;

/** 纯函数：按类型判定一条 claim（输入为已采集的原始事实，便于两侧自检）。 */
export function evalClaim({ claim, fileText = '', exitCode = null, output = '' }) {
  const fail = (reason) => ({ ok: false, reason });
  if (claim.type === 'file-regex') {
    const m = fileText.match(new RegExp(claim.regex));
    if (!m) return fail(`正则未命中（file=${claim.file}）`);
    if (claim.expect === null || claim.expect === undefined) return { ok: true, reason: '命中' };
    if (m[1] !== String(claim.expect)) return fail(`捕获组=${JSON.stringify(m[1])}，期望 ${JSON.stringify(String(claim.expect))}`);
    return { ok: true, reason: `= ${m[1]}` };
  }
  if (claim.type === 'file-not-regex') {
    const m = fileText.match(new RegExp(claim.regex));
    return m ? fail(`不应出现却命中：${JSON.stringify(m[0])}（file=${claim.file}）`) : { ok: true, reason: '未出现（符合预期）' };
  }
  if (claim.type === 'cmd') {
    if (exitCode !== claim.expectExit) return fail(`退出码=${exitCode}，期望 ${claim.expectExit}`);
    if (claim.expectContains && !String(output).includes(claim.expectContains)) return fail(`输出不含 ${JSON.stringify(claim.expectContains)}`);
    return { ok: true, reason: `exit=${exitCode}${claim.expectContains ? ' 且含 ' + JSON.stringify(claim.expectContains) : ''}` };
  }
  return fail(`未知 claim 类型：${claim.type}`);
}

// 实跑（非自检）要对**仓库文件内容**做正则断言：cc 正在改这些文件时，断言会瞬时翻转
// （例如"过时注释已改正"这条正好会在 ⑤b 执行过程中由红变绿），此刻的结论无意义 → exit 4。
if (!process.argv.includes('--selftest') && skipIfChainLive('事实复跑要对仓库文件内容断言，这些文件正在被 cc 改写')) process.exit(4);

if (process.argv.includes('--selftest')) {
  const cases = [
    ['[POS] file-regex 捕获组等于期望 → 放行', { claim: { type: 'file-regex', regex: 'x=(\\d+)', expect: '7' }, fileText: 'x=7' }, true],
    ['[NEG] file-regex 捕获组不等于期望 → 抓（数字漂移）', { claim: { type: 'file-regex', regex: 'x=(\\d+)', expect: '7' }, fileText: 'x=9' }, false],
    ['[NEG] file-regex 正则未命中 → 抓', { claim: { type: 'file-regex', regex: 'never', expect: '1' }, fileText: 'x=1' }, false],
    ['[POS] file-not-regex 未命中 → 放行', { claim: { type: 'file-not-regex', regex: 'bad' }, fileText: 'good' }, true],
    ['[NEG] file-not-regex 命中 → 抓（过时内容仍在）', { claim: { type: 'file-not-regex', regex: 'bad' }, fileText: 'this is bad' }, false],
    ['[POS] cmd 退出码与输出都符合 → 放行', { claim: { type: 'cmd', expectExit: 0, expectContains: 'OK' }, exitCode: 0, output: 'all OK' }, true],
    ['[NEG] cmd 退出码不符 → 抓', { claim: { type: 'cmd', expectExit: 0, expectContains: 'OK' }, exitCode: 1, output: 'all OK' }, false],
    ['[NEG] cmd 输出不含关键字 → 抓', { claim: { type: 'cmd', expectExit: 0, expectContains: 'RESULT: 7/7' }, exitCode: 0, output: 'RESULT: 6/7' }, false],
  ];
  let bad = 0;
  for (const [name, input, expect] of cases) {
    const r = evalClaim(input);
    const ok = r.ok === expect;
    if (!ok) bad++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : `（期望 ${expect}，实际 ${r.ok}：${r.reason}）`}`);
  }
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

console.log('=== ⑥ 事实复跑门禁（claims.json）===');
let hard = 0; const debts = [];
for (const c of CLAIMS) {
  let r;
  if (c.type === 'cmd') {
    const cmd = spawnSync(process.execPath, [c.script, ...(c.args || [])], { cwd: WORK, encoding: 'utf8', timeout: 600000 });
    r = evalClaim({ claim: c, exitCode: cmd.status, output: `${cmd.stdout || ''}${cmd.stderr || ''}` });
  } else {
    let text = '';
    try { text = fs.readFileSync(path.join(REPO, c.file), 'utf8'); } catch (e) { r = { ok: false, reason: `文件不可读：${c.file}` }; }
    if (!r) r = evalClaim({ claim: c, fileText: text });
  }
  if (r.ok) { console.log(`  [PASS] ${c.id} — ${c.desc}（${r.reason}）`); continue; }
  if (c.knownDebt) { debts.push(`${c.id}：${r.reason}`); console.log(`  [DEBT] ${c.id} — ${c.desc}\n         漂移=${r.reason}\n         说明=${c.knownDebtNote || ''}`); continue; }
  hard++; console.log(`  [FAIL] ${c.id} — ${c.desc}\n         漂移=${r.reason}`);
}
if (debts.length) console.log(`\n  已知债 ${debts.length} 条（不计入失败，但**可见**）：${debts.map((d) => d.split('：')[0]).join(', ')}`);
console.log(`\n  RESULT: ${hard ? `FAIL（${hard} 条事实漂移）` : `PASS（${CLAIMS.length} 条事实全部复跑一致${debts.length ? '，另 ' + debts.length + ' 条已知债' : ''}）`}`);
if (process.argv.includes('--json')) fs.writeFileSync('D:\\cc-tasks\\claims-audit.json', JSON.stringify({ at: new Date().toISOString(), hard, debts }, null, 2), 'utf8');
process.exit(hard ? 1 : 0);
