// 编码通道稳定性分析（**走生产代码路径**）
//
// ⚠ 本脚本的前一版自己复刻了调用方的分类逻辑（classifyCcFailure(errorCode || reason)），
// 因此在该逻辑被修复后仍然按旧口径分桶 —— 2026-09-16 实测：它报 failed=10/markerMissing=1，
// 而真实字段是 failed=6/markerMissing=5，**我据此对 cc 提了一次假失败**。
// 教训：验证工具不得复刻被验证的逻辑，否则工具一过期就开始说谎（L-069 同类）。
// 现改为直接调用 lib/cc-stats.mjs 的 loadChainTaskResults + summarizeChainTasks。
import fs from 'node:fs';
import path from 'node:path';
import { loadChainTaskResults, summarizeChainTasks } from 'file:///D:/dsh-web-relay/lib/cc-stats.mjs';

const ROOT = 'D:\\cc-tasks';
const WINDOW_MS = 7 * 24 * 3600 * 1000;
const now = Date.now();

// ---- 原始枚举：仅用于耗时统计与明细展示（不参与分桶判断）----
const raw = [];
const tasksDir = path.join(ROOT, 'tasks');
for (const dir of fs.readdirSync(tasksDir)) {
  if (dir.startsWith('_')) continue;
  const rp = path.join(tasksDir, dir, 'result.json');
  if (!fs.existsSync(rp)) continue;
  let r; try { r = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch { continue; }
  const startMs = Date.parse(r.start);
  const endMs = Date.parse(r.end);
  raw.push({ taskId: dir, status: r.status, errorCode: r.errorCode || null, reason: String(r.reason || '').slice(0, 60), startMs, durMs: Number.isFinite(endMs) && Number.isFinite(startMs) ? endMs - startMs : null });
}

const fm = (ms) => (ms === undefined || ms === null || !Number.isFinite(ms) ? '-' : (ms / 60000).toFixed(1) + 'min');
const dur = (list) => {
  const a = list.map((x) => x.durMs).filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return { n: 0 };
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return { n: a.length, min: a[0], median: q(0.5), p90: q(0.9), max: a[a.length - 1] };
};

// ---- 分桶：一律走生产函数 ----
const load = await loadChainTaskResults({ root: ROOT });
const s = summarizeChainTasks(load.results);
const windowRaw = raw.filter((x) => Number.isFinite(x.startMs) && x.startMs >= now - WINDOW_MS);

console.log('=== 分桶（生产代码路径）===');
console.log(`  total=${s.total} ok=${s.ok} failed=${s.failed} markerMissing=${s.markerMissing} successRate=${s.successRate === null ? 'null' : s.successRate.toFixed(4)}`);
console.log(`  byFailure=${JSON.stringify(s.byFailure)}`);

console.log('\n=== 失败构成拆解（把外部约束与误报单列）===');
const quota = s.byFailure['cc-quota-exhausted'] || 0;
const markerLike = s.markerMissing;
const own = s.failed - quota;
console.log(`  failed ${s.failed} = 外部配额 ${quota} + 通道自身 ${own}`);
console.log(`  markerMissing ${markerLike}（缺完成标记：claude 自身 exit=0，产物可能完好，不计入 failed）`);
console.log(`  通道自身失败率 = ${own}/${s.total} = ${((own / s.total) * 100).toFixed(1)}%`);
console.log(`  「额度内、且不含缺标记」成功率 = ${s.ok}/${s.total - quota - markerLike} = ${((s.ok / (s.total - quota - markerLike)) * 100).toFixed(1)}%`);

console.log('\n=== 耗时分布（看是否逼近 900s/15min 硬上限）===');
const dAll = dur(windowRaw);
console.log(`  全部: n=${dAll.n} median=${fm(dAll.median)} p90=${fm(dAll.p90)} max=${fm(dAll.max)}`);
const dOk = dur(windowRaw.filter((x) => x.status === 'done'));
console.log(`  成功: n=${dOk.n} median=${fm(dOk.median)} p90=${fm(dOk.p90)} max=${fm(dOk.max)}`);
const near = windowRaw.filter((x) => Number.isFinite(x.durMs) && x.durMs >= 13 * 60000).sort((a, b) => b.durMs - a.durMs);
console.log(`  ≥13min（逼近上限）: ${near.length ? near.map((x) => `${fm(x.durMs)}/${x.taskId}`).join(', ') : '无'}`);

console.log('\n=== 非 done 逐条明细（分桶结果取自生产函数）===');
for (const r of s.recent) {
  if (r.status === 'done') continue;
  console.log(`  [${r.category || '(none)'}] ${r.taskId}  errorCode=${r.errorCode || '(空)'} 耗时=${fm(r.elapsedMs)}`);
}

console.log('\n=== 运行时字段对拍 ===');
try {
  const h = await (await fetch('http://127.0.0.1:3080/dsh-web-relay/health-check')).json();
  const live = h.ccChainStats;
  console.log(`  运行时: total=${live.total} failed=${live.failed} markerMissing=${live.markerMissing} byFailure=${JSON.stringify(live.byFailure)}`);
  const same = JSON.stringify(Object.entries(live.byFailure).sort()) === JSON.stringify(Object.entries(s.byFailure).sort());
  console.log(`  → 与本地仓库一致 = ${same ? 'YES' : 'NO'}（NO 的常见原因：仓库已修但**未交付+重启**，运行时仍是旧代码）`);
} catch (e) { console.log('  查询失败: ' + e.message); }
