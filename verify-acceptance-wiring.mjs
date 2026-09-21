// 接线测试：证明「执行接地验收」的**四类契约**都真的成立（不是只看代码）。
//   A 探针通过            → verify-cc-task 应 ACCEPT（exit 0），并打印 [PASS] 验收脚本
//   B 探针文件缺失        → 应 INSTRUMENT-ERROR（exit 3），**不得**伪装成"产物不合格"
//   C 探针负控失败        → arm-chain 应**拒绝装填**，且不得改写指针
//   D 探针判定不合格      → 应 REJECT（exit 1），与 B 的 exit 3 区分
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { skipIfChainLive, chainLive, waitForChainIdle } from './chain-lock.mjs';

const WORK = 'D:\\dsh relay test';
const POINTER = 'D:\\cc-tasks\\current-chain.txt';
// 本测试的 C/E 两段会**改写 current-chain.txt**（E 段再还原）。链条在飞时必须让路：
// 否则既干扰在飞链条，又可能在"写坏指针后被杀"时留下指向已删文件的指针 → 自动化静默停摆。
const START_IDLE = waitForChainIdle({ maxWaitMs: 60000 });
if (!START_IDLE.idle) {
  console.log(`  [SKIP] 链条运行中（锁 ${START_IDLE.ageMin} 分钟）：本测试会临时改写 current-chain.txt 并重装链条`);
  console.log('  NOT-APPLICABLE（exit 4）——此刻的结论会被在飞的 cc 改写污染。');
  process.exit(4);
}
// 中途守卫（2026-09-19 实测抖动）：计划任务每 20 分钟取一次锁；若它在**测试跑到一半**时取锁，
// C/E 两段对指针的写入就可能与在飞链条/后续 tick 互踩，表现为随机 2 项失败。
// 故在改写指针的段落之前复查锁状态，出现即作废（exit 4）而不是给出一个可疑的判定。
const requireIdle = (where) => {
  const w = waitForChainIdle({ maxWaitMs: 30000 });
  if (w.idle) return;
  console.log(`  [SKIP] 链条锁在${where}出现（锁 ${w.ageMin} 分钟，等待 ${(w.waitedMs / 1000).toFixed(1)}s 未释放）`);
  console.log('  NOT-APPLICABLE（exit 4）——本轮结论不可信，请链条空闲时重跑。');
  process.exit(4);
};
const fails = [];
const ok = (name, cond, detail = '') => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ' — ' + detail}`); if (!cond) fails.push(name); };
const run = (args, opts = {}) => spawnSync(process.execPath, args, { cwd: WORK, encoding: 'utf8', timeout: 240000, ...opts });

// 取一个真实存在且报告完整的任务，用于 A / D
const TASKS = 'D:\\cc-tasks\\tasks';
const realTask = fs.readdirSync(TASKS).find((d) => fs.existsSync(path.join(TASKS, d, 'out', 'report.md')));
ok('找到可用于测试的真实任务', !!realTask, realTask || '(无)');

// ---- A 探针通过 ----
{
  const r = run(['verify-cc-task.mjs', realTask, '--acceptance', 'probes/accept-smoke.mjs']);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  ok('[POS] A 探针通过 → verify-cc-task exit 0', r.status === 0, `exit=${r.status}`);
  ok('[POS] A 输出含 [PASS] 验收脚本', /\[PASS\] 验收脚本/.test(out), out.split('\n').find((l) => /验收脚本/.test(l)) || '(无该行)');
}

// ---- B 探针文件缺失 → 必须 exit 3（工具错误，不是判定不合格）----
{
  const r = run(['verify-cc-task.mjs', realTask, '--acceptance', 'probes/__no_such_probe__.mjs']);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  ok('[NEG] B 探针缺失 → exit 3（INSTRUMENT-ERROR）', r.status === 3, `exit=${r.status}`);
  ok('[NEG] B 输出明确标注"工具错误"且含 INSTRUMENT-ERROR', /工具错误/.test(out) && /INSTRUMENT-ERROR/.test(out), out.split('\n').filter((l) => /INSTRUMENT|工具错误/.test(l))[0] || '(无)');
  ok('[NEG] B 不得被写成"ACCEPT/REJECT 业务判定"', !/RESULT: (ACCEPT|REJECT)/.test(out));
}

// ---- D 探针判定不合格 → exit 1（与 B 区分）----
{
  const failProbe = path.join(WORK, 'probes', '_failprobe.mjs');
  fs.writeFileSync(failProbe,
    `console.log('  FAIL 故意不合格');\nprocess.exit(1);\n`, 'utf8');
  const r = run(['verify-cc-task.mjs', realTask, '--acceptance', 'probes/_failprobe.mjs']);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  ok('[NEG] D 探针判不合格 → exit 1（REJECT，非 3）', r.status === 1, `exit=${r.status}`);
  ok('[NEG] D 输出区分"判定不合格"与"工具错误"', /判定不合格/.test(out) && !/INSTRUMENT-ERROR/.test(out));
  try { fs.unlinkSync(failProbe); } catch { /* 已删 */ }
}

// ---- C 探针负控失败 → arm-chain 拒绝装填且不改写指针 ----
{
  const badProbe = path.join(WORK, 'probes', '_badselftest.mjs');
  fs.writeFileSync(badProbe, `// 负控恒通过（即"坏输入也判通过"）——这正是必须被拒绝的永真门禁\nconsole.log('  [FAIL] 负控未能失败（门禁是永真的）');\nprocess.exit(1);\n`, 'utf8');
  const spec = path.join(WORK, 'cc-specs', '_accept-gate-probe.mjs');
  fs.writeFileSync(spec, `export const task = {\n  taskId: 'gate-probe-test',\n  kind: 'understand',\n  title: '门禁测试用（临时）',\n  refs: [],\n  anchors: [{ file: 'lib/index.js', pattern: 'const healthHeavyEmpty = () => ({', note: 'x' }],\n  acceptance: 'temp',\n  acceptanceScript: 'probes/_badselftest.mjs',\n  expectArtifacts: ['report.md'],\n  outputDir: 'out',\n  writeScope: [],\n  prompt: 'temp',\n};\n`, 'utf8');
  const chainFile = path.join(WORK, 'cc-chains', '_gate-test.mjs');
  fs.writeFileSync(chainFile, `export const chain = { id: 'gate-test', items: [\n  { label: '门禁测试项', spec: 'cc-specs/_accept-gate-probe.mjs', taskId: 'gate-probe-test' },\n] };\n`, 'utf8');
  requireIdle("改写指针前");
  const before = fs.readFileSync(POINTER, 'utf8');
  const r = run(['arm-chain.mjs', 'cc-chains/_gate-test.mjs']);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  ok('[NEG] C 负控失败的探针 → arm-chain 拒绝装填（exit 1）', r.status === 1, `exit=${r.status}`);
  ok('[NEG] C 输出指出负控未通过', /负控未通过/.test(out), out.split('\n').find((l) => /负控/.test(l)) || '(无)');
  ok('[NEG] C 指针未被改写', fs.readFileSync(POINTER, 'utf8') === before);
  // 清理
  for (const f of [badProbe, spec, chainFile]) { try { fs.unlinkSync(f); } catch { /* 已删 */ } }
}

// ---- E 正向：合法探针的链条应能装填（且不改坏指针）----
{
  const spec = path.join(WORK, 'cc-specs', '_accept-gate-ok.mjs');
  fs.writeFileSync(spec, `export const task = {\n  taskId: 'gate-ok-test',\n  kind: 'understand',\n  title: '门禁正向测试（临时）',\n  refs: [],\n  anchors: [{ file: 'lib/index.js', pattern: 'const healthHeavyEmpty = () => ({', note: 'x' }],\n  acceptance: 'temp',\n  acceptanceScript: 'probes/accept-smoke.mjs',\n  expectArtifacts: ['report.md'],\n  outputDir: 'out',\n  writeScope: [],\n  prompt: 'temp',\n};\n`, 'utf8');
  const chainFile = path.join(WORK, 'cc-chains', '_gate-ok.mjs');
  fs.writeFileSync(chainFile, `export const chain = { id: 'gate-ok', items: [\n  { label: '门禁正向项', spec: 'cc-specs/_accept-gate-ok.mjs', taskId: 'gate-ok-test' },\n] };\n`, 'utf8');
  requireIdle("改写指针前");
  const before = fs.readFileSync(POINTER, 'utf8');
  const r = run(['arm-chain.mjs', 'cc-chains/_gate-ok.mjs']);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  ok('[POS] E 探针负控通过 → 允许装填', r.status === 0, `exit=${r.status}`);
  ok('[POS] E 输出报告执行接地验收项数', /执行接地验收：1 项/.test(out), out.split('\n').find((l) => /执行接地/.test(l)) || '(无)');
  fs.writeFileSync(POINTER, before, 'utf8');   // 还原指针（测试不改变真实装填）
  for (const f of [spec, chainFile]) { try { fs.unlinkSync(f); } catch { /* 已删 */ } }
  ok('[POS] E 指针已还原', fs.readFileSync(POINTER, 'utf8') === before);
}

// ---- F 卫生：测试自身不得在工作区留下临时产物 ----
{
  const strays = [
    ...fs.readdirSync(path.join(WORK, 'probes')).filter((f) => f.startsWith('_')),
    ...fs.readdirSync(path.join(WORK, 'cc-specs')).filter((f) => f.startsWith('_')),
    ...fs.readdirSync(path.join(WORK, 'cc-chains')).filter((f) => f.startsWith('_')),
  ];
  ok('[POS] F 测试结束无临时产物残留', strays.length === 0, strays.join(', '));
}

console.log(`\n  RESULT: ${fails.length ? 'FAIL（' + fails.length + ' 项）' : 'PASS（四类契约 + 正向装填 + 卫生全部成立）'}`);
process.exit(fails.length ? 1 : 0);
