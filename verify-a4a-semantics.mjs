// A4a 语义验收：主 agent 独立夹具，**不复用** cc 自己写的测试（cc 自述不可信，须独立取证）
// 对照 spec 验收条款逐条核：分类复用/cc-marker-missing 单列/窗口与缺 start 跳过/畸形不抛/空输入无 NaN/
// recent ≤10 倒序/读取器默认 100 且只用最近 N 个/单目录异常不整体失败。
import assert from 'node:assert/strict';
import { summarizeChainTasks, loadChainTaskResults, classifyCcFailure } from 'file:///D:/dsh-web-relay/lib/cc-stats.mjs';

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); fail++; }
};

const NOW = Date.parse('2026-09-16T00:00:00Z');
const at = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();
const base = { taskId: 't', status: 'done', start: at(10), end: at(9) };

console.log('=== ① 分类：cc-marker-missing 必须单列，不计入 failed ===');
await check('marker-missing 单独计数且不进 failed', () => {
  const r = summarizeChainTasks([{ ...base, errorCode: 'cc-marker-missing', status: 'failed' }], { now: NOW });
  assert.equal(r.markerMissing, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.total, 1);
  assert.equal(r.byFailure['cc-marker-missing'], undefined, 'marker-missing 不应出现在 byFailure');
});
await check('真实失败才进 failed，且分类来自既有 classifyCcFailure', () => {
  const r = summarizeChainTasks([{ ...base, status: 'failed', errorCode: 'cc-quota-exhausted' }], { now: NOW });
  assert.equal(r.failed, 1);
  assert.equal(r.markerMissing, 0);
  const keys = Object.keys(r.byFailure);
  assert.equal(keys.length, 1);
  const expected = classifyCcFailure('cc-quota-exhausted').category;
  assert.equal(keys[0], expected, `应复用既有分类（期望 ${expected}，实际 ${keys[0]}）`);
});

console.log('=== ② 窗口 / 缺 start / 畸形条目 一律跳过，不抛 ===');
await check('窗口外与缺 start 的条目被跳过', () => {
  const r = summarizeChainTasks([
    { ...base, taskId: 'in' },
    { ...base, taskId: 'old', start: new Date(NOW - 30 * 24 * 3600 * 1000).toISOString() },
    { taskId: 'nostart', status: 'done' },
    { taskId: 'badstart', status: 'done', start: 'not-a-date' },
  ], { now: NOW });
  assert.equal(r.total, 1);
  assert.equal(r.recent.length, 1);
  assert.equal(r.recent[0].taskId, 'in');
});
await check('畸形输入不抛错', () => {
  for (const bad of [null, undefined, 'x', 42, [null, 1, 'a', {}, []], [{ status: 'done' }]]) {
    const r = summarizeChainTasks(bad, { now: NOW });
    assert.equal(typeof r.total, 'number');
  }
});
await check('空输入 total=0 且无 NaN、成功率为 null', () => {
  const r = summarizeChainTasks([], { now: NOW });
  assert.equal(r.total, 0);
  assert.equal(r.ok, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.markerMissing, 0);
  assert.equal(r.successRate, null);
  assert.equal(r.avgElapsedMs, null);
  assert.deepEqual(r.recent, []);
  for (const v of [r.total, r.ok, r.failed, r.markerMissing]) assert.ok(!Number.isNaN(v), '出现 NaN');
});

console.log('=== ③ recent ≤10 且按时间倒序 ===');
await check('15 条输入 → recent 只保留最新 10 条且倒序', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ ...base, taskId: `t${i}`, start: at(i + 1), end: at(i) }));
  const r = summarizeChainTasks(items, { now: NOW });
  assert.equal(r.total, 15);
  assert.equal(r.recent.length, 10);
  const times = r.recent.map((x) => Date.parse(x.at));
  for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] >= times[i], '未按时间倒序');
  assert.equal(r.recent[0].taskId, 't0', '最新一条应排首位');
});
await check('成功率为 ok/total，均值来自有效 start-end', () => {
  const r = summarizeChainTasks([
    { ...base, taskId: 'a' },
    { ...base, taskId: 'b' },
    { ...base, taskId: 'c', status: 'failed', errorCode: 'cc-timeout' },
    { ...base, taskId: 'd', status: 'failed', errorCode: 'cc-marker-missing' },
  ], { now: NOW });
  assert.equal(r.total, 4);
  assert.equal(r.successRate, 0.5);
  assert.equal(r.avgElapsedMs, 60000);
});

console.log('=== ④ 读取器：有界、容错、taskId 取目录名 ===');
const dirOf = (p) => String(p).split(/[\\/]/).filter(Boolean).slice(-2)[0];
const leafOf = (p) => String(p).split(/[\\/]/).filter(Boolean).slice(-1)[0];
function fakeFs(dirs, { readdirThrows = false, statThrows = new Set() } = {}) {
  return {
    async readdir() {
      if (readdirThrows) throw new Error('EACCES');
      return Object.entries(dirs).map(([name, v]) => ({ name, isDirectory: () => v.isDir !== false }));
    },
    async stat(p) {
      const n = leafOf(p);
      if (statThrows.has(n)) throw new Error('stat fail');
      return { mtimeMs: dirs[n] ? dirs[n].mtime : 0 };
    },
    async readFile(p) {
      const n = dirOf(p);
      const v = dirs[n];
      if (v.throwRead) throw new Error('read fail');
      return v.json;
    },
  };
}
const mk = (mtime, obj) => ({ mtime, json: JSON.stringify(obj) });

await check('目录不可访问 → 空结果 + reason（不抛）', async () => {
  const r = await loadChainTaskResults({ root: 'X:\\root', fsImpl: fakeFs({}, { readdirThrows: true }) });
  assert.deepEqual(r.results, []);
  assert.equal(r.scanned, 0);
  assert.equal(r.skipped, 0);
  assert.match(r.reason, /不可访问/);
});
await check('limit=2 → 只扫描最新 2 个目录', async () => {
  const dirs = {
    a: mk(300, { taskId: 'WRONG', status: 'done', start: at(1) }),
    b: mk(200, { taskId: 'b', status: 'done', start: at(2) }),
    c: mk(100, { taskId: 'c', status: 'done', start: at(3) }),
  };
  const r = await loadChainTaskResults({ root: 'X:\\root', fsImpl: fakeFs(dirs), limit: 2 });
  assert.equal(r.scanned, 2);
  assert.deepEqual(r.results.map((x) => x.taskId).sort(), ['a', 'b']);
  const a = r.results.find((x) => x.taskId === 'a');
  assert.equal(a.taskId, 'a', 'taskId 必须取自目录名，覆盖 result.json 内的同名字段');
});
await check('单个目录 readFile 失败/JSON 坏 → 计入 skipped，其它照读', async () => {
  const dirs = {
    good: mk(300, { taskId: 'good', status: 'done', start: at(1) }),
    bad: { mtime: 200, throwRead: true },
    broken: mk(100, null),
  };
  const r = await loadChainTaskResults({ root: 'X:\\root', fsImpl: fakeFs(dirs) });
  assert.equal(r.scanned, 3);
  assert.equal(r.skipped, 2);
  assert.deepEqual(r.results.map((x) => x.taskId), ['good']);
});
await check('stat 失败的目录被视为最旧但仍可读（不整体失败）', async () => {
  const dirs = { a: mk(300, { taskId: 'a', status: 'done', start: at(1) }), b: mk(100, { taskId: 'b', status: 'done', start: at(2) }) };
  const r = await loadChainTaskResults({ root: 'X:\\root', fsImpl: fakeFs(dirs, { statThrows: new Set(['a']) }) });
  assert.equal(r.results.length, 2);
  assert.deepEqual(r.results.map((x) => x.taskId).sort(), ['a', 'b']);
});
await check('非目录条目被忽略', async () => {
  const dirs = { a: mk(300, { taskId: 'a', status: 'done', start: at(1) }), notadir: { isDir: false, mtime: 400 } };
  const r = await loadChainTaskResults({ root: 'X:\\root', fsImpl: fakeFs(dirs) });
  assert.deepEqual(r.results.map((x) => x.taskId), ['a']);
});
await check('默认 limit = 100（105 个目录 → 只取 100）', async () => {
  const dirs = {};
  for (let i = 0; i < 105; i++) dirs[`d${String(i).padStart(3, '0')}`] = mk(i, { taskId: 'x', status: 'done', start: at(1) });
  const r = await loadChainTaskResults({ root: 'X:\\root', fsImpl: fakeFs(dirs) });
  assert.equal(r.scanned, 100, `实际 scanned=${r.scanned}`);
});

console.log('=== ⑤ 读取器 → 汇总 端到端串联 ===');
await check('父目录 + 读取器输出可直接喂给 summarizeChainTasks', async () => {
  const dirs = {
    a: mk(300, { status: 'done', start: at(1), end: at(0) }),
    b: mk(200, { status: 'failed', errorCode: 'cc-marker-missing', start: at(2), end: at(1) }),
  };
  const load = await loadChainTaskResults({ root: 'X:\\root', fsImpl: fakeFs(dirs) });
  const sum = summarizeChainTasks(load.results, { now: NOW });
  assert.equal(sum.total, 2);
  assert.equal(sum.ok, 1);
  assert.equal(sum.markerMissing, 1);
  assert.equal(sum.failed, 0);
});

console.log(`\nRESULT: ${pass}/${pass + fail} 通过${fail ? `（${fail} 失败）` : ''}`);
process.exit(fail ? 1 : 0);
