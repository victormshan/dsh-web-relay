import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  classifyCcFailure,
  recordCcOutcome,
  summarizeCcStats,
  loadStats,
  saveStats,
} from '../lib/cc-stats.mjs';

/** 内存 fake fsImpl：不碰真实磁盘，模拟 node:fs/promises 的 readFile/writeFile/mkdir 语义。 */
function makeFakeFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  return {
    async readFile(p) {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: no such file, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
    async writeFile(p, data) {
      files.set(p, data);
    },
    async mkdir() {
      // 内存 fake，无需真正建目录。
    },
    _files: files,
  };
}

// --- classifyCcFailure ---

test('classifyCcFailure: contract-reject 归类', () => {
  const r = classifyCcFailure('v2 契约校验失败，REJECT 已隔离到 .invalid/');
  assert.equal(r.category, 'contract-reject');
});

test('classifyCcFailure: timeout 归类', () => {
  const r = classifyCcFailure('执行超时，900s 上限已到');
  assert.equal(r.category, 'timeout');
});

test('classifyCcFailure: runner-failed 归类（exit≠0）', () => {
  const r = classifyCcFailure('claude exit≠0，done.flag missing');
  assert.equal(r.category, 'runner-failed');
});

test('classifyCcFailure: runner-failed 归类（v2-validate-failed）', () => {
  const r = classifyCcFailure('runner.sh: v2-validate-failed on task.json');
  assert.equal(r.category, 'runner-failed');
});

test('classifyCcFailure: artifact-missing 归类', () => {
  const r = classifyCcFailure('产物缺失：out/review.md 不存在');
  assert.equal(r.category, 'artifact-missing');
});

test('classifyCcFailure: channel-unavailable 归类', () => {
  const r = classifyCcFailure('cc-tasks 根目录不可用，目录缺失');
  assert.equal(r.category, 'channel-unavailable');
});

test('classifyCcFailure: 无法归类返回 unknown 且保留原文前 200 字', () => {
  const longText = 'x'.repeat(300);
  const r = classifyCcFailure(longText);
  assert.equal(r.category, 'unknown');
  assert.equal(r.detail, 'x'.repeat(200));
  assert.equal(r.detail.length, 200);
});

// 缺陷 2/3 修复回归：新增失败分类必须排在通用 timeout 规则之前——两者都含
// "timeout" 子串（\btimeout\b 会命中 "timeout-still-running"），若顺序错误会被
// 笼统吞并进 timeout，导致"仍在执行（超时上限）"与"watchdog 陈旧降级"无法从统计上区分。

test('classifyCcFailure: timeout-still-running 归类（cc-channel.js pollTaskResult 超时 reason），与真实 timeout 不同类', () => {
  const r = classifyCcFailure('timeout-still-running');
  assert.equal(r.category, 'timeout-still-running');
  assert.notEqual(r.category, 'timeout');
});

test('classifyCcFailure: cc-watchdog-stale 归类（含动态 ageMs 后缀），与真实 timeout 不同类', () => {
  const r = classifyCcFailure('cc-watchdog-stale:123456');
  assert.equal(r.category, 'cc-watchdog-stale');
  assert.notEqual(r.category, 'timeout');
});

test('classifyCcFailure: 真实 timeout（runner.sh exit=124/900s 硬超时）仍归类为 timeout，不受新规则影响', () => {
  const r1 = classifyCcFailure('执行超时，900s 上限已到');
  const r2 = classifyCcFailure('claude exit=124 超时');
  assert.equal(r1.category, 'timeout');
  assert.equal(r2.category, 'timeout');
});

// ccfix-20260914-stats: 补齐 cc-quota-exhausted / cc-permission-denied / cc-timeout 三类
// 归类——此前这三类 reason（含 lib/index.js runCcReviewTask 已经在写的字面量
// 'cc-quota-exhausted' / 'cc-permission-denied'）一律落入 unknown 桶（见
// docs/CC-HYBRID.md ccfix-20260914-hb3 遗留说明），/health-check 无法单列「配额耗尽 N 次」。

test('classifyCcFailure: cc-quota-exhausted 归类（字面量 reason，index.js 已直传），不被 unknown/timeout 吞并', () => {
  const r = classifyCcFailure('cc-quota-exhausted');
  assert.equal(r.category, 'cc-quota-exhausted');
});

test('classifyCcFailure: cc-quota-exhausted 归类（claude.log 关键词兜底：session limit / rate limit / quota）', () => {
  const r1 = classifyCcFailure('Claude AI usage limit reached, session limit exceeded');
  const r2 = classifyCcFailure('429 rate limit hit, please retry later');
  const r3 = classifyCcFailure('账号 quota 已耗尽');
  assert.equal(r1.category, 'cc-quota-exhausted');
  assert.equal(r2.category, 'cc-quota-exhausted');
  assert.equal(r3.category, 'cc-quota-exhausted');
});

test('classifyCcFailure: cc-permission-denied 归类（字面量 reason 与关键词兜底），不被 unknown 吞并', () => {
  const r1 = classifyCcFailure('cc-permission-denied');
  const r2 = classifyCcFailure("Claude requested permissions to write to foo.txt, but you haven't granted it yet");
  const r3 = classifyCcFailure('operation not permitted');
  assert.equal(r1.category, 'cc-permission-denied');
  assert.equal(r2.category, 'cc-permission-denied');
  assert.equal(r3.category, 'cc-permission-denied');
});

test('classifyCcFailure: cc-timeout（errorCode 直传路径文本）归类，且与通用 timeout / timeout-still-running 不同类', () => {
  const r = classifyCcFailure('cc-timeout');
  assert.equal(r.category, 'cc-timeout');
  assert.notEqual(r.category, 'timeout');
  assert.notEqual(r.category, 'timeout-still-running');
});

test('recordCcOutcome: 混合 reason 输入 → cc-quota-exhausted / cc-permission-denied / cc-timeout / timeout 各桶计数互斥且总数相等', () => {
  let stats = undefined;
  stats = recordCcOutcome(stats, { taskId: 't1', kind: 'review', ok: false, elapsedMs: 100, reason: 'cc-quota-exhausted' });
  stats = recordCcOutcome(stats, { taskId: 't2', kind: 'review', ok: false, elapsedMs: 100, reason: 'session limit reached' });
  stats = recordCcOutcome(stats, { taskId: 't3', kind: 'review', ok: false, elapsedMs: 100, reason: 'cc-permission-denied' });
  stats = recordCcOutcome(stats, { taskId: 't4', kind: 'review', ok: false, elapsedMs: 100, reason: "haven't granted permissions to write" });
  stats = recordCcOutcome(stats, { taskId: 't5', kind: 'implement', ok: false, elapsedMs: 100, reason: 'cc-timeout' });
  stats = recordCcOutcome(stats, { taskId: 't6', kind: 'implement', ok: false, elapsedMs: 900000, reason: 'claude exit=124 超时' });
  stats = recordCcOutcome(stats, { taskId: 't7', kind: 'review', ok: true, elapsedMs: 50 });

  assert.equal(stats.byFailure['cc-quota-exhausted'], 2);
  assert.equal(stats.byFailure['cc-permission-denied'], 2);
  assert.equal(stats.byFailure['cc-timeout'], 1);
  assert.equal(stats.byFailure.timeout, 1);
  assert.equal(stats.failed, 6);

  const failureBucketSum = Object.values(stats.byFailure).reduce((a, b) => a + b, 0);
  assert.equal(failureBucketSum, stats.failed, 'byFailure 各桶互斥可数：求和应等于 failed 总数');
});

// --- recordCcOutcome ---

test('recordCcOutcome: 不可变更新，不修改入参 stats', () => {
  const before = { total: 1, ok: 1, failed: 0, byKind: {}, byFailure: {}, elapsedMs: { sum: 100, min: 100, max: 100, count: 1 }, recent: [] };
  const snapshot = JSON.parse(JSON.stringify(before));
  const next = recordCcOutcome(before, { taskId: 't2', kind: 'implement', ok: true, elapsedMs: 200 });
  assert.deepEqual(before, snapshot, 'input stats 不应被修改');
  assert.notEqual(next, before);
  assert.equal(next.total, 2);
});

test('recordCcOutcome: total/ok/failed 计数正确', () => {
  let stats = undefined;
  stats = recordCcOutcome(stats, { taskId: 't1', kind: 'implement', ok: true, elapsedMs: 100 });
  stats = recordCcOutcome(stats, { taskId: 't2', kind: 'implement', ok: false, elapsedMs: 200, reason: '超时 900s' });
  stats = recordCcOutcome(stats, { taskId: 't3', kind: 'review', ok: true, elapsedMs: 50 });
  assert.equal(stats.total, 3);
  assert.equal(stats.ok, 2);
  assert.equal(stats.failed, 1);
});

test('recordCcOutcome: byKind 分组正确', () => {
  let stats = undefined;
  stats = recordCcOutcome(stats, { taskId: 't1', kind: 'implement', ok: true, elapsedMs: 100 });
  stats = recordCcOutcome(stats, { taskId: 't2', kind: 'implement', ok: false, elapsedMs: 200, reason: '超时' });
  stats = recordCcOutcome(stats, { taskId: 't3', kind: 'review', ok: true, elapsedMs: 50 });
  assert.deepEqual(stats.byKind.implement, { total: 2, ok: 1, failed: 1 });
  assert.deepEqual(stats.byKind.review, { total: 1, ok: 1, failed: 0 });
});

test('recordCcOutcome: byFailure 按分类计数', () => {
  let stats = undefined;
  stats = recordCcOutcome(stats, { taskId: 't1', kind: 'implement', ok: false, elapsedMs: 900000, reason: '超时 900s' });
  stats = recordCcOutcome(stats, { taskId: 't2', kind: 'implement', ok: false, elapsedMs: 900000, reason: 'exit=124 超时' });
  stats = recordCcOutcome(stats, { taskId: 't3', kind: 'implement', ok: false, elapsedMs: 10, reason: '产物缺失' });
  assert.equal(stats.byFailure.timeout, 2);
  assert.equal(stats.byFailure['artifact-missing'], 1);
});

test('recordCcOutcome: byFailure 区分 timeout-still-running / cc-watchdog-stale / 真实 timeout 三类（供 /health-check ccStats.byFailure 审计）', () => {
  let stats = undefined;
  stats = recordCcOutcome(stats, { taskId: 't1', kind: 'review', ok: false, elapsedMs: 150000, reason: 'timeout-still-running' });
  stats = recordCcOutcome(stats, { taskId: 't2', kind: 'review', ok: false, elapsedMs: 0, reason: 'cc-watchdog-stale:200000' });
  stats = recordCcOutcome(stats, { taskId: 't3', kind: 'implement', ok: false, elapsedMs: 900000, reason: 'claude exit=124 超时' });
  assert.equal(stats.byFailure['timeout-still-running'], 1);
  assert.equal(stats.byFailure['cc-watchdog-stale'], 1);
  assert.equal(stats.byFailure.timeout, 1);
  const s = summarizeCcStats(stats);
  assert.equal(s.breakdown.byFailure['timeout-still-running'], 1);
  assert.equal(s.breakdown.byFailure['cc-watchdog-stale'], 1);
});

test('recordCcOutcome: elapsedMs sum/min/max/count 正确', () => {
  let stats = undefined;
  stats = recordCcOutcome(stats, { taskId: 't1', kind: 'implement', ok: true, elapsedMs: 100 });
  stats = recordCcOutcome(stats, { taskId: 't2', kind: 'implement', ok: true, elapsedMs: 300 });
  stats = recordCcOutcome(stats, { taskId: 't3', kind: 'implement', ok: true, elapsedMs: 50 });
  assert.equal(stats.elapsedMs.sum, 450);
  assert.equal(stats.elapsedMs.min, 50);
  assert.equal(stats.elapsedMs.max, 300);
  assert.equal(stats.elapsedMs.count, 3);
});

test('recordCcOutcome: recent 环形截断到最近 10 条', () => {
  let stats = undefined;
  for (let i = 0; i < 15; i += 1) {
    stats = recordCcOutcome(stats, { taskId: `t${i}`, kind: 'implement', ok: true, elapsedMs: i });
  }
  assert.equal(stats.recent.length, 10);
  assert.equal(stats.recent[0].taskId, 't5');
  assert.equal(stats.recent[9].taskId, 't14');
});

// --- summarizeCcStats ---

test('summarizeCcStats: 空 stats 返回 warn（样本不足）', () => {
  const s = summarizeCcStats(undefined);
  assert.equal(s.level, 'warn');
  assert.equal(s.successRate, 0);
});

test('summarizeCcStats: 成功率 >=0.8 且样本 >=5 → ok', () => {
  let stats = undefined;
  for (let i = 0; i < 4; i += 1) {
    stats = recordCcOutcome(stats, { taskId: `t${i}`, kind: 'implement', ok: true, elapsedMs: 100 });
  }
  stats = recordCcOutcome(stats, { taskId: 't5', kind: 'implement', ok: false, elapsedMs: 100, reason: '超时' });
  const s = summarizeCcStats(stats);
  assert.equal(s.level, 'ok');
  assert.ok(s.successRate >= 0.8);
});

test('summarizeCcStats: 成功率 <0.5 且样本 >=5 → risk', () => {
  let stats = undefined;
  for (let i = 0; i < 4; i += 1) {
    stats = recordCcOutcome(stats, { taskId: `t${i}`, kind: 'implement', ok: false, elapsedMs: 100, reason: '超时' });
  }
  stats = recordCcOutcome(stats, { taskId: 't5', kind: 'implement', ok: true, elapsedMs: 100 });
  const s = summarizeCcStats(stats);
  assert.equal(s.level, 'risk');
  assert.ok(s.successRate < 0.5);
});

test('summarizeCcStats: 样本 <5 时即使成功率高也判 warn', () => {
  let stats = undefined;
  stats = recordCcOutcome(stats, { taskId: 't1', kind: 'implement', ok: true, elapsedMs: 100 });
  stats = recordCcOutcome(stats, { taskId: 't2', kind: 'implement', ok: true, elapsedMs: 100 });
  const s = summarizeCcStats(stats);
  assert.equal(s.level, 'warn');
});

// --- loadStats / saveStats ---

test('loadStats: 文件不存在时返回空白 stats（不抛异常）', async () => {
  const fake = makeFakeFs({});
  const s = await loadStats('/nowhere/stats.json', fake);
  assert.equal(s.total, 0);
  assert.match(s.message, /不存在/);
});

test('loadStats: 损坏 JSON 时返回空白 stats 并在 message 中体现', async () => {
  const fake = makeFakeFs({ '/bad/stats.json': '{ not valid json' });
  const s = await loadStats('/bad/stats.json', fake);
  assert.equal(s.total, 0);
  assert.match(s.message, /解析失败/);
});

test('saveStats → loadStats 往返一致', async () => {
  const fake = makeFakeFs({});
  let stats = undefined;
  stats = recordCcOutcome(stats, { taskId: 't1', kind: 'implement', ok: true, elapsedMs: 123 });
  stats = recordCcOutcome(stats, { taskId: 't2', kind: 'review', ok: false, elapsedMs: 456, reason: '超时 900s' });

  const filePath = path.join('/mem', 'cc-stats.json');
  await saveStats(filePath, stats, fake);
  const loaded = await loadStats(filePath, fake);

  assert.equal(loaded.total, stats.total);
  assert.equal(loaded.ok, stats.ok);
  assert.equal(loaded.failed, stats.failed);
  assert.deepEqual(loaded.byKind, stats.byKind);
  assert.deepEqual(loaded.byFailure, stats.byFailure);
  assert.deepEqual(loaded.elapsedMs, stats.elapsedMs);
});
