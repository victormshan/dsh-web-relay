// 目标验收证据聚合器：把「目标两项能力」的每条主张映射到**可复跑的实测证据**，输出单一档案。
// 动机：本会话的验证散落在多个脚本/命令里；收口时需要一份「逐条主张 → 证据 → 结论」的档案，
// 供人复核，而不是让复核者去翻 40 多轮对话。
// 用法：node verify-objective-acceptance.mjs            # 跑全部并写档案
//       node verify-objective-acceptance.mjs --quick    # 跳过全量测试（耗时最长的一项）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = 'D:\\dsh-web-relay';
const WORK = 'D:\\dsh relay test';
const BUNDLE = path.join(WORK, '_objective-acceptance-bundle.txt');
const quick = process.argv.includes('--quick');

const results = [];
const run = (name, cmd, args, opts = {}) => {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: opts.cwd || REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs || 900000 });
  const out = (String(r.stdout || '') + String(r.stderr || '')).trim();
  const rec = { name, code: r.status, ms: Date.now() - t0, out, expect: opts.expect ?? 0, tail: opts.tail || 12 };
  results.push(rec);
  const ok = rec.code === rec.expect;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name.padEnd(46)} exit=${rec.code}（期望 ${rec.expect}） ${(rec.ms / 1000).toFixed(1)}s`);
  return rec;
};
const grep = (rec, re) => String(rec.out).split(/\r?\n/).filter((l) => re.test(l));

console.log('  === 目标验收证据聚合（逐条主张 → 实测）===\n');

// ── 主张 1：cc 编码通道「失败分类与降级可审计」──────────────
console.log('  【主张 1】cc 编码通道：失败分类与降级可审计');
run('runner 失败分类自测（runner-failed/quota/marker-missing 等）', process.execPath,
  [path.join(WORK, 'cc-doctor.mjs')], { tail: 6 });
run('cc-channel 单测（classifyCcFailure / parseResetsAt / ccWatchdogAlive）', process.execPath,
  ['--test', '--test-reporter=tap', 'test/cc-channel.test.js'], { tail: 3 });
run('cc-stats 单测（FAILURE_RULES 分类桶）', process.execPath,
  ['--test', '--test-reporter=tap', 'test/cc-stats.test.mjs'], { tail: 3 });
run('配额状态共享端到端（A5\': runner 写的状态驱动 relay 短路）', process.execPath,
  ['verify-quota-state-e2e.mjs'], { cwd: WORK, tail: 6 });
run('配额解析精确时刻（8h 时区偏差修复）', process.execPath,
  ['verify-quota-tz-offset.mjs'], { cwd: WORK, tail: 6 });

// ── 主张 2：cc 编码通道「守护常驻可自愈 + 派发前探活」──────────
console.log('\n  【主张 2】守护常驻可自愈 + 派发前探活');
run('watchdog 探针实测（A6/A7 后的真实判定）', process.execPath,
  ['measure-a6-watchdog-probe.mjs'], { cwd: WORK, tail: 8 });
run('链条额度解析自测（含真实「仅小时」文案）', process.execPath,
  ['cc-chain.mjs', '--selftest-quota'], { cwd: WORK, tail: 8 });

// ── 主张 3：端到端可验证 ────────────────────────────────
console.log('\n  【主张 3】端到端可验证');
run('工具链回归套件（14 项，含验收器两态/收口器两态/自测）', process.execPath,
  ['regression-post-restart.mjs'], { cwd: WORK, tail: 4 });
if (!quick) {
  const files = fs.readdirSync(path.join(REPO, 'test')).filter((f) => f.endsWith('.test.js') || f.endsWith('.test.mjs')).map((f) => path.join(REPO, 'test', f));
  run('全量测试（Windows 权威口径）', process.execPath, ['--test', '--test-reporter=tap', ...files], { tail: 3 });
}

// ── 主张 4：突破架构能力与自动演化（目标第 2 项）──────────────
console.log('\n  【主张 4】突破架构能力 + 人工缺席下的自动演化');
run('V1 验收与版间门（突破度门禁 + 声明完整性）', process.execPath, ['verify-v1-acceptance.mjs'], { cwd: WORK, tail: 6 });
run('引擎↔文档一致性（零漂移）', process.execPath, ['scripts/sync-engine-docs.mjs', '--check'], { tail: 4 });
run('能力索引 registry 校验', process.execPath, ['scripts/verify-capabilities.mjs'], { tail: 3 });
run('教训库校验', process.execPath, ['scripts/verify-lessons.mjs'], { tail: 3 });
run('覆盖检查（import 可达且被 package files 覆盖）', process.execPath, ['scripts/verify-files-coverage.mjs'], { tail: 2 });
run('无人认领检测整链（A1→A3→A5\' 真实组件）', process.execPath, ['verify-a1a3a5-chain.mjs'], { cwd: WORK, tail: 6 });

// ── 汇总与档案 ────────────────────────────────────────
const pass = results.filter((r) => r.code === r.expect).length;
const lines = [];
lines.push('目标验收证据档案（verify-objective-acceptance.mjs 生成）');
lines.push(`时间: ${new Date().toISOString()}    模式: ${quick ? 'quick（跳过全量测试）' : 'full'}`);
lines.push(`仓库: ${spawnSync('git', ['-C', REPO, 'log', '--oneline', '-1'], { encoding: 'utf8' }).stdout.trim()}`);
lines.push(`结果: ${pass}/${results.length} 项通过`);
lines.push('');
for (const r of results) {
  lines.push(`── ${r.code === r.expect ? 'PASS' : 'FAIL'} ── ${r.name}（exit=${r.code}，期望 ${r.expect}，${(r.ms / 1000).toFixed(1)}s）`);
  const tail = String(r.out).split(/\r?\n/).filter((l) => l.trim()).slice(-r.tail);
  for (const l of tail) lines.push('    ' + l.trim().slice(0, 160));
  lines.push('');
}
lines.push('未覆盖（如实声明）：');
lines.push('  · A4（编码通道统计聚合到 /health-check）—— 规格已就绪待派（配额 07:00 恢复后），');
lines.push('    故「编码通道的可靠性数据可在 /health-check 观测」这一条**尚未达成**；');
lines.push('    已达成的是：分类本身可审计（runner errorCode）、分类消费正确、配额状态共享（A5\'）。');
const bundle = lines.join('\n') + '\n';
fs.writeFileSync(BUNDLE, bundle, 'utf8');
console.log(`\n  RESULT: ${pass}/${results.length} 项通过`);
console.log(`  档案已写入: ${BUNDLE}（${Buffer.byteLength(bundle, 'utf8')} 字节）`);
const failed = results.filter((r) => r.code !== r.expect);
for (const f of failed) console.log(`    FAIL: ${f.name}（exit=${f.code}）`);
process.exit(failed.length ? 1 : 0);
