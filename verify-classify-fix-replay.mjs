// 权威回放：直接调用仓库里的 loadChainTaskResults + summarizeChainTasks（生产代码路径），
// 不再自己复刻调用方逻辑——analyze-cc-channel.mjs 就是因为复刻了旧逻辑而误报。
import { loadChainTaskResults, summarizeChainTasks } from 'file:///D:/dsh-web-relay/lib/cc-stats.mjs';

const ROOT = 'D:\\cc-tasks';
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  ok ? pass++ : fail++;
};

const load = await loadChainTaskResults({ root: ROOT });
const s = summarizeChainTasks(load.results);

console.log('=== 权威回放（生产代码路径：loadChainTaskResults + summarizeChainTasks）===');
console.log(`  scanned=${load.scanned} skipped=${load.skipped} reason=${load.reason || 'null'}`);
console.log(`  total=${s.total} ok=${s.ok} failed=${s.failed} markerMissing=${s.markerMissing} successRate=${s.successRate}`);
console.log(`  byFailure=${JSON.stringify(s.byFailure)}`);

console.log('\n=== 逐条核对非 done 记录的落桶（用真实分类结果）===');
for (const r of s.recent) {
  if (r.status === 'done') continue;
  console.log(`  [${r.category || r.status}] ${r.taskId}  errorCode=${r.errorCode || '(空)'}`);
}

console.log('\n=== 对照主 agent 推演的预期（见 spec 验收 ③）===');
const exp = { failed: 6, markerMissing: 5 };
check(`failed = ${exp.failed}（旧版为 10）`, s.failed === exp.failed, `实际 ${s.failed}`);
check(`markerMissing = ${exp.markerMissing}（旧版为 1）`, s.markerMissing === exp.markerMissing, `实际 ${s.markerMissing}`);
check('unknown 桶归零（旧版 3）', !s.byFailure.unknown, `实际 ${s.byFailure.unknown}`);
check('泛化 timeout 桶归零（旧版 1）', !s.byFailure.timeout, `实际 ${s.byFailure.timeout}`);
check('cc-timeout = 2（同一失败模式已合桶）', s.byFailure['cc-timeout'] === 2, `实际 ${s.byFailure['cc-timeout']}`);
check('runner-failed = 2（旧版 3）', s.byFailure['runner-failed'] === 2, `实际 ${s.byFailure['runner-failed']}`);
check('cc-quota-exhausted = 2（保持不变）', s.byFailure['cc-quota-exhausted'] === 2, `实际 ${s.byFailure['cc-quota-exhausted']}`);
check('byFailure 中不再出现 cc-marker-missing（计数与分桶一致）', !s.byFailure['cc-marker-missing'], `实际 ${s.byFailure['cc-marker-missing']}`);
check('total = ok + failed + markerMissing（计数器自洽）', s.total === s.ok + s.failed + s.markerMissing, `${s.total} vs ${s.ok}+${s.failed}+${s.markerMissing}`);
// 注意：s.total 是**窗口过滤后**的计数，load.results 是读到的全部（含窗口外），两者不应相等。
// 上一版我写成 s.total === load.results.length → 假失败（37 vs 47，差的 10 条正是窗口外）。
const inWindow = load.results.filter((r) => {
  const t = Date.parse(r.start);
  return Number.isFinite(t) && t >= Date.now() - 7 * 24 * 3600 * 1000;
}).length;
check('窗口内条数 == 独立按窗口过滤的条数', s.total === inWindow, `summarize=${s.total} 独立过滤=${inWindow}（读盘总数 ${load.results.length}）`);

console.log('\n=== 运行时字段对照（--expect-live 时要求运行时已反映新规则）===');
const expectLive = process.argv.includes('--expect-live');
try {
  const h = await (await fetch('http://127.0.0.1:3080/dsh-web-relay/health-check')).json();
  const live = h.ccChainStats;
  console.log(`  运行时 byFailure = ${JSON.stringify(live.byFailure)}`);
  const same = JSON.stringify(Object.entries(live.byFailure).sort()) === JSON.stringify(Object.entries(s.byFailure).sort());
  const stale = !!live.byFailure.unknown || !!live.byFailure.timeout;
  if (expectLive) {
    check('运行时已反映新规则（交付+重启已生效）', same && !stale, `运行时=${JSON.stringify(live.byFailure)} 仓库=${JSON.stringify(s.byFailure)}`);
    check('运行时 failed/markerMissing 与仓库一致', live.failed === s.failed && live.markerMissing === s.markerMissing, `运行时 ${live.failed}/${live.markerMissing} vs 仓库 ${s.failed}/${s.markerMissing}`);
  } else {
    check('运行时仍是旧规则（证明修复尚未交付，属预期）', stale, `运行时=${JSON.stringify(live.byFailure)}`);
  }
} catch (e) { console.log('  查询失败: ' + e.message); }

console.log(`\nRESULT: ${pass}/${pass + fail} 通过${fail ? `（${fail} 失败）` : ''}`);
process.exit(fail ? 1 : 0);
