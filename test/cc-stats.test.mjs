import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  classifyCcFailure,
  recordCcOutcome,
  summarizeCcStats,
  loadStats,
  saveStats,
  summarizeChainTasks,
  loadChainTaskResults,
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

test('classifyCcFailure: cc-marker-missing 归类（不是 runner-failed，即使 reason 含 done.flag missing 文本）', () => {
  const r = classifyCcFailure('cc-marker-missing: claude exit=0; done.flag=missing');
  assert.equal(r.category, 'cc-marker-missing');
});

test('classifyCcFailure（反向回归）: reason 无 cc-marker-missing 字面量，仅 "claude exit≠0，done.flag missing" → 仍为 runner-failed', () => {
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

test('classifyCcFailure: 真实 timeout（900s 硬超时提示语，无 exit=124 字样）仍归类为 timeout', () => {
  const r1 = classifyCcFailure('执行超时，900s 上限已到');
  assert.equal(r1.category, 'timeout');
});

// ccfix-20260916-fallback-classify: exit=124 从泛化 timeout 桶移入 cc-timeout 桶——此前
// 'claude exit=124 超时' 落 timeout、errorCode='cc-timeout' 的同类失败落 cc-timeout，
// 同一失败模式分裂两桶，使「超时几次」无法用单一数字回答；现统一归 cc-timeout。
test('classifyCcFailure: exit=124（runner.sh 900s 硬超时 kill 的退出码）归入 cc-timeout，不再是 timeout', () => {
  const r = classifyCcFailure('claude exit=124 超时');
  assert.equal(r.category, 'cc-timeout');
  assert.notEqual(r.category, 'timeout');
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

// ccfix-20260916-fallback-classify: runner.sh 真实写出的 reason 是**等号形态**
// （'claude exit=1; done.flag=missing'），此前 done.flag 子模式要求空白分隔、exit 子模式
// 只认 ≠/!=，对等号形态恒不命中，errorCode 为空的行一律落 unknown。以下 8 组用例覆盖
// 主 agent 对 D:\cc-tasks\tasks\*\result.json 取证到的真实文本形态。

test('classifyCcFailure: 等号形态 exit=0 + done.flag=missing → cc-marker-missing（claude 自身成功，不得算 runner-failed）', () => {
  const r = classifyCcFailure('claude exit=0; done.flag=missing');
  assert.equal(r.category, 'cc-marker-missing');
  assert.notEqual(r.category, 'runner-failed');
});

test('classifyCcFailure: 等号形态 exit=1 + done.flag=missing → runner-failed', () => {
  const r = classifyCcFailure('claude exit=1; done.flag=missing');
  assert.equal(r.category, 'runner-failed');
});

test('classifyCcFailure: 等号形态 exit=124 + done.flag=missing → cc-timeout（不得落回泛化 timeout 桶）', () => {
  const r = classifyCcFailure('claude exit=124; done.flag=missing');
  assert.equal(r.category, 'cc-timeout');
  assert.notEqual(r.category, 'timeout');
});

test('classifyCcFailure: errorCode 与 reason 合并文本 "cc-failed claude exit=0; done.flag=missing" → cc-marker-missing（不被 \\bcc-failed\\b 抢先命中 runner-failed）', () => {
  const r = classifyCcFailure('cc-failed claude exit=0; done.flag=missing');
  assert.equal(r.category, 'cc-marker-missing');
});

test('classifyCcFailure: errorCode 与 reason 合并文本 "cc-timeout claude exit=124; done.flag=missing" → cc-timeout（保持原结果）', () => {
  const r = classifyCcFailure('cc-timeout claude exit=124; done.flag=missing');
  assert.equal(r.category, 'cc-timeout');
});

test('classifyCcFailure: errorCode 与 reason 合并文本 "cc-quota-exhausted claude exit=1; done.flag=missing" → cc-quota-exhausted（quota 规则仍前置，保持原结果）', () => {
  const r = classifyCcFailure('cc-quota-exhausted claude exit=1; done.flag=missing');
  assert.equal(r.category, 'cc-quota-exhausted');
});

test('classifyCcFailure（回归保护）: 空格形态 "done.flag missing"（不含等号）仍能被识别，不落入 unknown', () => {
  const r = classifyCcFailure('done.flag missing');
  assert.notEqual(r.category, 'unknown');
});

test('classifyCcFailure（负例）: "claude exit=0; 正常完成" 不含 done.flag 字样 → 不得落入任何失败桶（unknown）', () => {
  const r = classifyCcFailure('claude exit=0; 正常完成');
  assert.equal(r.category, 'unknown');
});

test('classifyCcFailure（负例）: exit=0 但无 done.flag 字样 → 不得落入 cc-marker-missing', () => {
  const r = classifyCcFailure('claude exit=0; 输出未包含标记字样');
  assert.notEqual(r.category, 'cc-marker-missing');
  assert.equal(r.category, 'unknown');
});

test('recordCcOutcome: errorCode 与 reason 一并纳入判定 → errorCode="cc-failed" + reason="claude exit=0; done.flag=missing" 落 cc-marker-missing（此前 reason 被完全忽略、误判为 runner-failed）', () => {
  let stats = undefined;
  stats = recordCcOutcome(stats, { taskId: 't1', kind: 'implement', ok: false, elapsedMs: 100, errorCode: 'cc-failed', reason: 'claude exit=0; done.flag=missing' });
  assert.equal(stats.byFailure['cc-marker-missing'], 1);
  assert.equal(stats.byFailure['runner-failed'], undefined);
});

test('recordCcOutcome: 混合 reason 输入 → cc-quota-exhausted / cc-permission-denied / cc-timeout 各桶计数互斥且总数相等（exit=124 与字面量 cc-timeout 同桶）', () => {
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
  assert.equal(stats.byFailure['cc-timeout'], 2, 't5(字面量 cc-timeout) + t6(exit=124) 应同桶');
  assert.equal(stats.byFailure.timeout, undefined, 'exit=124 不应再落入泛化 timeout 桶');
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

test('recordCcOutcome: byFailure 按分类计数（exit=124 归 cc-timeout，与泛化 timeout 分桶）', () => {
  let stats = undefined;
  stats = recordCcOutcome(stats, { taskId: 't1', kind: 'implement', ok: false, elapsedMs: 900000, reason: '超时 900s' });
  stats = recordCcOutcome(stats, { taskId: 't2', kind: 'implement', ok: false, elapsedMs: 900000, reason: 'exit=124 超时' });
  stats = recordCcOutcome(stats, { taskId: 't3', kind: 'implement', ok: false, elapsedMs: 10, reason: '产物缺失' });
  assert.equal(stats.byFailure.timeout, 1);
  assert.equal(stats.byFailure['cc-timeout'], 1);
  assert.equal(stats.byFailure['artifact-missing'], 1);
});

test('recordCcOutcome: byFailure 区分 timeout-still-running / cc-watchdog-stale / 真实 timeout 三类（供 /health-check ccStats.byFailure 审计）', () => {
  let stats = undefined;
  stats = recordCcOutcome(stats, { taskId: 't1', kind: 'review', ok: false, elapsedMs: 150000, reason: 'timeout-still-running' });
  stats = recordCcOutcome(stats, { taskId: 't2', kind: 'review', ok: false, elapsedMs: 0, reason: 'cc-watchdog-stale:200000' });
  stats = recordCcOutcome(stats, { taskId: 't3', kind: 'implement', ok: false, elapsedMs: 900000, reason: '执行超时，900s 上限已到' });
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

// --- summarizeChainTasks (ccfeat-20260916-chainstats-a) ---

const NOW = Date.parse('2026-09-16T12:00:00Z');
const WEEK_MS = 7 * 24 * 3600 * 1000;

test('summarizeChainTasks: status=done 计入 ok，不计入 failed', () => {
  const s = summarizeChainTasks(
    [{ taskId: 't1', status: 'done', start: '2026-09-16T10:00:00Z', end: '2026-09-16T10:05:00Z' }],
    { now: NOW },
  );
  assert.equal(s.total, 1);
  assert.equal(s.ok, 1);
  assert.equal(s.failed, 0);
  assert.equal(s.markerMissing, 0);
});

test('summarizeChainTasks: failed 且无 errorCode/reason → 计入 failed 且落入 unknown 桶', () => {
  const s = summarizeChainTasks(
    [{ taskId: 't1', status: 'failed', start: '2026-09-16T10:00:00Z' }],
    { now: NOW },
  );
  assert.equal(s.failed, 1);
  assert.equal(s.byFailure.unknown, 1);
  assert.equal(s.markerMissing, 0);
});

test('summarizeChainTasks: errorCode=cc-failed 且 reason 无信息量 → 归入 runner-failed 桶（runner.sh 通用兜底 errorCode，语义等价 exit≠0）', () => {
  const s = summarizeChainTasks(
    [{ taskId: 't1', status: 'failed', start: '2026-09-16T10:00:00Z', errorCode: 'cc-failed', reason: 'unexpected script error' }],
    { now: NOW },
  );
  assert.equal(s.failed, 1);
  assert.equal(s.byFailure['runner-failed'], 1);
});

// ccfix-20260916-fallback-classify: errorCode='cc-failed' 且 reason='claude exit=0;
// done.flag=missing' 此前被单独看 errorCode（reason 完全被忽略）误判为 runner-failed
// （「代码写坏了」），而真实语义是「claude 自身 exit=0，只是没写完成标记」——这类记录
// 经取证均产出了落在 main 上的提交，即把成功算成了失败。现两个字段一并纳入判定后，
// 应正确落回 markerMissing（结构上与 failed 互斥），不再计入 failed/byFailure。
test('summarizeChainTasks: errorCode=cc-failed + reason=claude exit=0; done.flag=missing → 合并判定后落 markerMissing，不计入 failed（此前误判为 runner-failed）', () => {
  const s = summarizeChainTasks(
    [{ taskId: 't1', status: 'failed', start: '2026-09-16T10:00:00Z', errorCode: 'cc-failed', reason: 'claude exit=0; done.flag=missing' }],
    { now: NOW },
  );
  assert.equal(s.failed, 0);
  assert.equal(s.markerMissing, 1);
  assert.deepEqual(s.byFailure, {});
});

test('summarizeChainTasks: errorCode 为空、reason=claude exit=1; done.flag=missing（等号形态）→ 归入 runner-failed，不再落 unknown', () => {
  const s = summarizeChainTasks(
    [{ taskId: 't1', status: 'failed', start: '2026-09-16T10:00:00Z', reason: 'claude exit=1; done.flag=missing' }],
    { now: NOW },
  );
  assert.equal(s.failed, 1);
  assert.equal(s.byFailure['runner-failed'], 1);
});

test('summarizeChainTasks: errorCode 为空、reason=claude exit=124; done.flag=missing（等号形态）→ 归入 cc-timeout，不再落 unknown/timeout', () => {
  const s = summarizeChainTasks(
    [{ taskId: 't1', status: 'failed', start: '2026-09-16T10:00:00Z', reason: 'claude exit=124; done.flag=missing' }],
    { now: NOW },
  );
  assert.equal(s.failed, 1);
  assert.equal(s.byFailure['cc-timeout'], 1);
  assert.equal(s.byFailure.unknown, undefined);
  assert.equal(s.byFailure.timeout, undefined);
});

test('summarizeChainTasks: errorCode 为空、reason=claude exit=0; done.flag=missing（等号形态）→ 归入 markerMissing，不再落 unknown', () => {
  const s = summarizeChainTasks(
    [{ taskId: 't1', status: 'failed', start: '2026-09-16T10:00:00Z', reason: 'claude exit=0; done.flag=missing' }],
    { now: NOW },
  );
  assert.equal(s.failed, 0);
  assert.equal(s.markerMissing, 1);
  assert.deepEqual(s.byFailure, {});
});

test('summarizeChainTasks: errorCode=cc-marker-missing → 单列 markerMissing，不计入 failed、不进入 byFailure（核心用例）', () => {
  const s = summarizeChainTasks(
    [
      { taskId: 't1', status: 'failed', start: '2026-09-16T10:00:00Z', errorCode: 'cc-marker-missing', reason: 'claude exit=0; done.flag=missing' },
      { taskId: 't2', status: 'done', start: '2026-09-16T09:00:00Z' },
    ],
    { now: NOW },
  );
  assert.equal(s.total, 2);
  assert.equal(s.markerMissing, 1);
  assert.equal(s.failed, 0, 'cc-marker-missing 不得计入 failed');
  assert.deepEqual(s.byFailure, {}, 'cc-marker-missing 不得出现在 byFailure 中');
  assert.equal(s.successRate, 0.5, 'successRate = ok/total，markerMissing 计入 total 但不计入 ok');
});

test('summarizeChainTasks: cc-quota-exhausted 归桶（与审核通道 classifyCcFailure 同桶名）', () => {
  const s = summarizeChainTasks(
    [{ taskId: 't1', status: 'failed', start: '2026-09-16T10:00:00Z', errorCode: 'cc-quota-exhausted' }],
    { now: NOW },
  );
  assert.equal(s.byFailure['cc-quota-exhausted'], 1);
});

test('summarizeChainTasks: cc-timeout 归桶（与审核通道 classifyCcFailure 同桶名）', () => {
  const s = summarizeChainTasks(
    [{ taskId: 't1', status: 'failed', start: '2026-09-16T10:00:00Z', errorCode: 'cc-timeout' }],
    { now: NOW },
  );
  assert.equal(s.byFailure['cc-timeout'], 1);
});

test('summarizeChainTasks: windowMs 过滤——窗口外（早于 now-windowMs）的条目不计入', () => {
  const outsideStart = new Date(NOW - WEEK_MS - 3600 * 1000).toISOString(); // 早 1 小时于窗口左端
  const s = summarizeChainTasks(
    [{ taskId: 't1', status: 'done', start: outsideStart }],
    { now: NOW, windowMs: WEEK_MS },
  );
  assert.equal(s.total, 0);
});

test('summarizeChainTasks: 窗口边界锁定——start 恰等于 now-windowMs 时计入（左闭区间）', () => {
  const boundaryStart = new Date(NOW - WEEK_MS).toISOString();
  const s = summarizeChainTasks(
    [{ taskId: 't1', status: 'done', start: boundaryStart }],
    { now: NOW, windowMs: WEEK_MS },
  );
  assert.equal(s.total, 1, 'start === now-windowMs 应计入，而非排除');
});

test('summarizeChainTasks: start 缺失的条目被跳过，不参与任何计数', () => {
  const s = summarizeChainTasks(
    [{ taskId: 't1', status: 'done' }, { taskId: 't2', status: 'done', start: '2026-09-16T10:00:00Z' }],
    { now: NOW },
  );
  assert.equal(s.total, 1);
  assert.equal(s.ok, 1);
});

test('summarizeChainTasks: 畸形输入（null / 非数组 / errorCode 为数字 / status 缺失）不抛错', () => {
  assert.doesNotThrow(() => summarizeChainTasks(null, { now: NOW }));
  assert.doesNotThrow(() => summarizeChainTasks('not-an-array', { now: NOW }));
  assert.doesNotThrow(() => summarizeChainTasks(undefined, { now: NOW }));
  const s = summarizeChainTasks(
    [
      null,
      'garbage',
      42,
      { taskId: 't1', start: '2026-09-16T10:00:00Z', errorCode: 12345 }, // status 缺失 + errorCode 非字符串
    ],
    { now: NOW },
  );
  assert.equal(s.total, 1, '仅最后一条是合法对象且带 start，其余畸形元素被跳过');
  assert.equal(s.failed, 1, 'status 缺失视为无法判定为 done → 计入 failed');
  assert.equal(s.byFailure.unknown, 1, 'errorCode 非字符串被忽略，落入 unknown 桶');
});

test('summarizeChainTasks: 空数组 → total=0，successRate 为 null（非 NaN）', () => {
  const s = summarizeChainTasks([], { now: NOW });
  assert.equal(s.total, 0);
  assert.equal(s.successRate, null);
  assert.notEqual(Number.isNaN(s.successRate), true);
});

test('summarizeChainTasks: recent 最多 10 条且按时间倒序', () => {
  const results = [];
  for (let i = 0; i < 15; i += 1) {
    results.push({ taskId: `t${i}`, status: 'done', start: new Date(NOW - i * 60000).toISOString() });
  }
  const s = summarizeChainTasks(results, { now: NOW });
  assert.equal(s.recent.length, 10);
  assert.equal(s.recent[0].taskId, 't0');
  assert.equal(s.recent[9].taskId, 't9');
});

test('summarizeChainTasks: avgElapsedMs 无样本为 null；有 end 的条目参与均值计算', () => {
  const s0 = summarizeChainTasks([{ taskId: 't1', status: 'done', start: '2026-09-16T10:00:00Z' }], { now: NOW });
  assert.equal(s0.avgElapsedMs, null);

  const s1 = summarizeChainTasks(
    [
      { taskId: 't1', status: 'done', start: '2026-09-16T10:00:00Z', end: '2026-09-16T10:01:00Z' }, // 60000ms
      { taskId: 't2', status: 'done', start: '2026-09-16T10:00:00Z', end: '2026-09-16T10:02:00Z' }, // 120000ms
    ],
    { now: NOW },
  );
  assert.equal(s1.avgElapsedMs, 90000);
});

// --- loadChainTaskResults (ccfeat-20260916-chainstats-a) ---

/** 内存 fake：模拟 D:\cc-tasks\tasks\<name>\result.json 目录结构。 */
function makeFakeTasksFs(tasksDir, dirSpecs) {
  return {
    async readdir(dir) {
      if (dir !== tasksDir) {
        const err = new Error(`ENOENT: no such directory, scandir '${dir}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return Object.keys(dirSpecs).map((name) => ({ name, isDirectory: () => true }));
    },
    async stat(p) {
      const name = path.basename(p);
      const spec = dirSpecs[name];
      if (!spec) {
        const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return { mtimeMs: spec.mtimeMs };
    },
    async readFile(p) {
      const name = path.basename(path.dirname(p));
      const spec = dirSpecs[name];
      if (!spec || spec.missing) {
        const err = new Error(`ENOENT: no such file, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      if (spec.badJson) return '{ not valid json';
      return JSON.stringify(spec.result);
    },
  };
}

test('loadChainTaskResults: tasks 目录不存在 → 不抛错，返回空结果并说明 reason', async () => {
  const fake = {
    async readdir() {
      const err = new Error('ENOENT: no such directory');
      err.code = 'ENOENT';
      throw err;
    },
  };
  const r = await loadChainTaskResults({ root: 'D:\\nowhere', fsImpl: fake });
  assert.deepEqual(r.results, []);
  assert.equal(r.scanned, 0);
  assert.equal(r.skipped, 0);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});

test('loadChainTaskResults: 单条 result.json 损坏（JSON 解析失败）→ 计入 skipped，其余任务正常返回', async () => {
  const tasksDir = path.join('D:\\fake-root', 'tasks');
  const fake = makeFakeTasksFs(tasksDir, {
    good1: { mtimeMs: 3000, result: { status: 'done', start: '2026-09-16T10:00:00Z' } },
    bad1: { mtimeMs: 2000, badJson: true },
    missing1: { mtimeMs: 1000, missing: true },
  });
  const r = await loadChainTaskResults({ root: 'D:\\fake-root', fsImpl: fake });
  assert.equal(r.scanned, 3);
  assert.equal(r.skipped, 2, 'bad1 (JSON 损坏) + missing1 (result.json 不存在) 均计入 skipped');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].taskId, 'good1');
  assert.equal(r.reason, null);
});

test('loadChainTaskResults: 只取最近 limit 个目录（按 mtime 倒序），避免目录无界增长时全量扫描', async () => {
  const tasksDir = path.join('D:\\fake-root', 'tasks');
  const dirSpecs = {};
  for (let i = 0; i < 5; i += 1) {
    dirSpecs[`t${i}`] = { mtimeMs: i * 1000, result: { status: 'done', start: '2026-09-16T10:00:00Z' } };
  }
  const fake = makeFakeTasksFs(tasksDir, dirSpecs);
  const r = await loadChainTaskResults({ root: 'D:\\fake-root', fsImpl: fake, limit: 2 });
  assert.equal(r.scanned, 2, '只应扫描 mtime 最新的 2 个目录');
  const taskIds = r.results.map((x) => x.taskId).sort();
  assert.deepEqual(taskIds, ['t3', 't4'], '应取 mtime 最大的两个目录（t4, t3）');
});
