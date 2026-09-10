// gate-regression.test.mjs
//
// 防回退回归测试：cc 派发契约（buildReviewTask）+ 四重门控（validateTask /
// validateResult / validateResultText）。覆盖事故复盘：buildReviewTask() 曾把
// outputDir 硬编码为绝对路径 → 违反 v2 schema → 每个 cc 审核任务被 REJECT
// （.invalid/ 13 例，claude-code 审核成功率 0%）。旧测试只单独断言
// `task.outputDir === 'out'`，未断言 buildReviewTask 产物整体能通过
// validateTask —— 这正是本次事故实际触发的防线，本文件补齐。
//
// 全部使用相对路径 import 仓库源码（合入仓库后与其它测试一致，跨平台可跑），
// 且只用内存 fake fsImpl，不触碰真实磁盘。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildReviewTask } from '../lib/cc-channel.js';
import {
  validateTask,
  validateResult,
  validateResultText,
} from '../lib/task-schema-v2.mjs';

/** 内存 fake fsImpl：{ path: content } 映射，exists()/readFile() 均不落地磁盘。 */
function makeFakeFs(files = {}) {
  return {
    async exists(p) {
      return Object.prototype.hasOwnProperty.call(files, p);
    },
    async readFile(p) {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files[p];
    },
  };
}

function baseParams(overrides = {}) {
  return {
    taskId: 'rev-gate-regress-1',
    exprId: 'expr-1',
    stepId: 'step-1',
    stepTitle: '标题',
    stepDetail: '详情',
    acceptance: '验收标准',
    artifactsSummary: '摘要',
    recordText: '记录',
    traceText: '轨迹',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1) 核心防线（本次事故）：validateTask(buildReviewTask(...)) 组合断言
// ---------------------------------------------------------------------------

test('核心防线：validateTask(buildReviewTask(...)) 整体通过（组合断言，非单看 outputDir）', () => {
  const task = buildReviewTask(baseParams());
  const result = validateTask(task);
  assert.equal(result.ok, true, `validateTask 应通过，实际 errors=${JSON.stringify(result.errors)}`);
  assert.deepEqual(result.errors, []);
});

test('核心防线：buildReviewTask 产出的 outputDir 是相对路径（不含开头 / 、不含盘符、不含 ..）', () => {
  const task = buildReviewTask(baseParams());
  assert.equal(task.outputDir, 'out');
  assert.equal(task.outputDir.startsWith('/'), false);
  assert.equal(task.outputDir.startsWith('\\'), false);
  assert.equal(/^[A-Za-z]:[\\/]/.test(task.outputDir), false);
  assert.equal(task.outputDir.split(/[\\/]+/).includes('..'), false);
});

// ---------------------------------------------------------------------------
// 2) 畸形任务被拒：每类一个用例
// ---------------------------------------------------------------------------

test('畸形任务被拒：outputDir 为绝对路径 → validateTask 报 outputDir 越界或非法', () => {
  const task = buildReviewTask(baseParams());
  task.outputDir = '/mnt/d/cc-tasks/tasks/rev-gate-regress-1/out';
  const result = validateTask(task);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /outputDir 越界或非法/.test(e)), JSON.stringify(result.errors));
});

test('畸形任务被拒：outputDir 含 .. 越界 → validateTask 报 outputDir 越界或非法', () => {
  const task = buildReviewTask(baseParams());
  task.outputDir = '../../etc';
  const result = validateTask(task);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /outputDir 越界或非法/.test(e)), JSON.stringify(result.errors));
});

test('畸形任务被拒：taskId 含空格 → validateTask 报 taskId 非法', () => {
  const task = buildReviewTask(baseParams());
  task.taskId = 'rev id with space';
  const result = validateTask(task);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /taskId 非法/.test(e)), JSON.stringify(result.errors));
});

test('畸形任务被拒：taskId 含路径分隔符 → validateTask 报 taskId 非法', () => {
  const task = buildReviewTask(baseParams());
  task.taskId = '../rev-1';
  const result = validateTask(task);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /taskId 非法/.test(e)), JSON.stringify(result.errors));
});

test('畸形任务被拒：title 为空字符串 → validateTask 报 title 必须是非空字符串', () => {
  const task = buildReviewTask(baseParams());
  task.title = '   ';
  const result = validateTask(task);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('title 必须是非空字符串'), JSON.stringify(result.errors));
});

test('畸形任务被拒：prompt 为空字符串 → validateTask 报 prompt 必须是非空字符串', () => {
  const task = buildReviewTask(baseParams());
  task.prompt = '';
  const result = validateTask(task);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('prompt 必须是非空字符串'), JSON.stringify(result.errors));
});

test('畸形任务被拒：kind 为非法枚举值 → validateTask 报 kind 非法', () => {
  const task = buildReviewTask(baseParams());
  task.kind = 'bogus-kind';
  const result = validateTask(task);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /kind 非法/.test(e)), JSON.stringify(result.errors));
});

test('畸形任务被拒：expectArtifacts 元素越界（绝对路径）→ validateTask 报该元素越界或非法', () => {
  const task = buildReviewTask(baseParams());
  task.expectArtifacts = ['review.md', '/etc/passwd'];
  const result = validateTask(task);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /expectArtifacts\[1\] 越界或非法/.test(e)), JSON.stringify(result.errors));
});

// ---------------------------------------------------------------------------
// 3) 兼容性：kind 缺失按 v1 语义容错为 unknown（不报错）
// ---------------------------------------------------------------------------

test('兼容性：kind 字段缺失时 validateTask 不报错（v1 语义容错为 unknown）', () => {
  const task = buildReviewTask(baseParams());
  delete task.kind;
  const result = validateTask(task);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.errors.length, 0);
});

// ---------------------------------------------------------------------------
// 4) validateResult：done.flag 位置 + PENDING 语义
// ---------------------------------------------------------------------------

test('validateResult：done.flag 放在 out/ 而非任务根 → doneFlagErrorCode === "done-flag-misplaced"', async () => {
  const taskDir = path.join(path.sep, 'fake', 'tasks', 'rev-1');
  const task = { outputDir: 'out', doneFlag: 'done.flag', kind: 'review' };
  const fsImpl = makeFakeFs({
    [path.join(taskDir, 'result.json')]: JSON.stringify({ status: 'done' }),
    [path.join(taskDir, 'out', 'done.flag')]: '',
    [path.join(taskDir, 'out', 'review.md')]: 'VERDICT: APPROVED',
  });
  const result = await validateResult({ taskDir, task, fsImpl });
  assert.equal(result.ok, false);
  assert.equal(result.details.doneFlagErrorCode, 'done-flag-misplaced');
  assert.equal(result.details.doneFlagAtRoot, false);
  assert.ok(result.errors.some((e) => /done-flag-misplaced/.test(e)), JSON.stringify(result.errors));
});

test('validateResult：无 result.json 无 done.flag（执行中）→ PENDING 语义，不报 done-flag-missing', async () => {
  const taskDir = path.join(path.sep, 'fake', 'tasks', 'rev-2');
  const task = { outputDir: 'out', kind: 'review' };
  const fsImpl = makeFakeFs({}); // 空文件系统：result.json 和 done.flag 都不存在
  const result = await validateResult({ taskDir, task, fsImpl });
  assert.equal(result.ok, false); // 仍不合格（result.json missing），但不应报 done-flag-missing
  assert.equal(result.details.resultPending, true);
  assert.equal(result.details.resultErrorCode, 'result-missing');
  assert.equal(result.details.doneFlagErrorCode, null);
  assert.ok(!result.errors.some((e) => /done-flag-missing/.test(e)), JSON.stringify(result.errors));
});

test('validateResult：done.flag 在根 + result.json done + review.md 存在 → 整体通过', async () => {
  // 跨平台：key 必须用 path.join 构造（validateResult 内部同 path.join；
  // WSL 正斜杠常量在 Windows 会与反斜杠 key 不匹配——s2v1 同型坑）
  const taskDir = path.join(path.sep, 'fake', 'tasks', 'rev-3');
  const task = { outputDir: 'out', kind: 'review' };
  const fsImpl = makeFakeFs({
    [path.join(taskDir, 'done.flag')]: '',
    [path.join(taskDir, 'result.json')]: JSON.stringify({ status: 'done' }),
    [path.join(taskDir, 'out', 'review.md')]: 'VERDICT: APPROVED',
  });
  const result = await validateResult({ taskDir, task, fsImpl });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.details.doneFlagAtRoot, true);
  assert.equal(result.details.doneFlagErrorCode, null);
});

test('validateResult：result.json 已写出但 done.flag 双缺（非 out/ 非根）→ done-flag-missing（真异常，非 pending）', async () => {
  const taskDir = path.join(path.sep, 'fake', 'tasks', 'rev-4');
  const task = { outputDir: 'out', kind: 'review', expectArtifacts: [] };
  const fsImpl = makeFakeFs({
    [path.join(taskDir, 'result.json')]: JSON.stringify({ status: 'done' }),
  });
  const result = await validateResult({ taskDir, task, fsImpl });
  assert.equal(result.ok, false);
  assert.equal(result.details.resultPending, false);
  assert.equal(result.details.doneFlagErrorCode, 'done-flag-missing');
  assert.ok(result.errors.some((e) => /done-flag-missing/.test(e)), JSON.stringify(result.errors));
});

// ---------------------------------------------------------------------------
// 5) validateResultText：纯函数结构校验（补充覆盖，无 IO）
// ---------------------------------------------------------------------------

test('validateResultText：status 非法枚举值 → ok=false errorCode="result-invalid"', () => {
  const result = validateResultText(JSON.stringify({ status: 'weird' }));
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'result-invalid');
});

test('validateResultText：非法 JSON 文本 → ok=false errorCode="result-corrupt"', () => {
  const result = validateResultText('{not json');
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'result-corrupt');
});
