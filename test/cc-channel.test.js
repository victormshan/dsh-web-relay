/**
 * cc-channel.test.js
 * node:test + assert/strict，仅使用内存 fake fsImpl，不触碰真实磁盘/网络/进程。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  CC_TASKS_ROOT_DEFAULT,
  resolveTasksRoot,
  sanitizeTaskId,
  buildReviewTask,
  parseCcVerdict,
  pollTaskResult,
  readReviewOut,
  ccChannelAvailable,
  ccWatchdogAlive,
  nodeFsImpl,
  DEFAULT_TIMEOUT_BY_KIND,
  resolveTimeoutMs,
  WATCHDOG_STALE_MS_DEFAULT,
} from '../lib/cc-channel.js';

/**
 * 创建一个内存 fake fsImpl，仅用于测试，绝不触碰真实磁盘。
 * @param {object} initialFiles - 初始文件内容（path -> content）。
 * @param {object} [opts]
 * @param {object} [opts.dirs] - 目录列表（path -> string[]），供 readdir 使用。
 * @param {object} [opts.stats] - 文件 mtimeMs（path -> number），供 stat 使用。
 */
function createFakeFs(initialFiles = {}, opts = {}) {
  const files = new Map(Object.entries(initialFiles));
  const dirs = new Map(Object.entries(opts.dirs || {}));
  const statTimes = new Map(Object.entries(opts.stats || {}));
  return {
    files,
    dirs,
    statTimes,
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
    async access(p) {
      const exists = [...files.keys()].some(
        (f) => f === p || f.startsWith(p + '/') || f.startsWith(p + '\\')
      );
      if (!exists) {
        const err = new Error(`ENOENT: no such file or directory, access '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
    },
    async mkdir() {},
    async readdir(p) {
      if (dirs.has(p)) return dirs.get(p);
      const err = new Error(`ENOENT: no such file or directory, scandir '${p}'`);
      err.code = 'ENOENT';
      throw err;
    },
    async stat(p) {
      if (statTimes.has(p)) return { mtimeMs: statTimes.get(p) };
      const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
      err.code = 'ENOENT';
      throw err;
    },
  };
}

// --- sanitizeTaskId ---

test('sanitizeTaskId：合法 id 通过', () => {
  assert.equal(sanitizeTaskId('rev-1a2b3c'), true);
  assert.equal(sanitizeTaskId('v9-cc-channel'), true);
  assert.equal(sanitizeTaskId('a'), true);
  assert.equal(sanitizeTaskId('a.b_c-9'), true);
});

test('sanitizeTaskId：非法 id 一律 false', () => {
  assert.equal(sanitizeTaskId(''), false);
  assert.equal(sanitizeTaskId('../x'), false);
  assert.equal(sanitizeTaskId('a/b'), false);
  assert.equal(sanitizeTaskId('a\\b'), false);
  assert.equal(sanitizeTaskId('a b'), false);
  assert.equal(sanitizeTaskId('"quoted"'), false);
  assert.equal(sanitizeTaskId('a'.repeat(65)), false);
  assert.equal(sanitizeTaskId(null), false);
  assert.equal(sanitizeTaskId(undefined), false);
});

// --- resolveTasksRoot ---

test('resolveTasksRoot：env 提供时使用之', () => {
  const root = resolveTasksRoot({ DSH_CC_TASKS_ROOT: 'E:\\custom-root' });
  assert.equal(root, 'E:\\custom-root');
});

test('resolveTasksRoot：缺省回退默认值', () => {
  assert.equal(resolveTasksRoot({}), CC_TASKS_ROOT_DEFAULT);
  assert.equal(resolveTasksRoot(undefined), CC_TASKS_ROOT_DEFAULT);
  assert.equal(CC_TASKS_ROOT_DEFAULT, 'D:\\cc-tasks');
});

// --- buildReviewTask ---

test('buildReviewTask：返回结构含 kind/taskId/prompt/outputDir', () => {
  const task = buildReviewTask({
    taskId: 'rev-test01',
    exprId: 'expr-1',
    stepId: 'step-2',
    stepTitle: '标题',
    stepDetail: '详情',
    acceptance: '验收标准正文',
    artifactsSummary: '产物摘要',
    recordText: '记录摘要',
    traceText: '轨迹文本',
    notesText: '备注',
  });

  assert.equal(task.kind, 'review');
  assert.equal(task.taskId, 'rev-test01');
  assert.match(task.prompt, /VERDICT/);
  assert.ok(task.prompt.includes('rev-test01'));
  // s2v5_3: outputDir 是任务根内相对子路径（v2 schema 硬校验——绝对路径被 cc-watchdog REJECT）
  assert.equal(task.outputDir, 'out');
  assert.ok(task.prompt.includes('/mnt/d/cc-tasks/tasks/rev-test01/out')); // 绝对落盘路径只在 prompt 提示 Claude
  assert.deepEqual(task.refs, []);
  assert.match(task.title, /step-2/);
});

test('buildReviewTask：省略 taskId 时自动生成前缀 rev-', () => {
  const task = buildReviewTask({ exprId: 'e', stepId: 's' });
  assert.match(task.taskId, /^rev-[0-9a-f]+$/);
});

test('buildReviewTask：超长字段被截断并追加省略标记', () => {
  const longText = 'x'.repeat(5000);
  const task = buildReviewTask({
    taskId: 'rev-trunc01',
    recordText: longText,
    traceText: longText,
    artifactsSummary: longText,
  });
  assert.ok(task.prompt.includes('…(截断)'));
});

// --- parseCcVerdict ---

test('parseCcVerdict：VERDICT 行大写变体', () => {
  const r = parseCcVerdict('VERDICT: APPROVED\n\n理由：一切正常');
  assert.equal(r.verdict, 'approved');
  assert.match(r.reason, /理由/);
});

test('parseCcVerdict：VERDICT 行小写/混合变体', () => {
  const r = parseCcVerdict('verdict:rejected\n\n未通过测试');
  assert.equal(r.verdict, 'rejected');
});

test('parseCcVerdict：JSON 兜底', () => {
  const r = parseCcVerdict('一些前言文字\n{"result":"rejected"}\n后续文字');
  assert.equal(r.verdict, 'rejected');
});

test('parseCcVerdict：中文关键词兜底', () => {
  const r = parseCcVerdict('审核意见：本次评审结果为不通过，需要修改。');
  assert.equal(r.verdict, 'rejected');
});

test('parseCcVerdict：无法识别 → unknown', () => {
  const r = parseCcVerdict('这是一段无关文本，没有任何结论标记。');
  assert.equal(r.verdict, 'unknown');
});

// --- DEFAULT_TIMEOUT_BY_KIND / resolveTimeoutMs（缺陷 1：轮询上限按 kind 对齐） ---

test('DEFAULT_TIMEOUT_BY_KIND：review=150000，implement/understand ≥900000（对齐 runner.sh timeout 900）', () => {
  assert.equal(DEFAULT_TIMEOUT_BY_KIND.review, 150000);
  assert.ok(DEFAULT_TIMEOUT_BY_KIND.implement >= 900000);
  assert.ok(DEFAULT_TIMEOUT_BY_KIND.understand >= 900000);
});

test('resolveTimeoutMs：未传 timeoutMs/env 时按 kind 分档取默认值，未知 kind 回退 review 档位', () => {
  assert.equal(resolveTimeoutMs({ kind: 'review' }), 150000);
  assert.equal(resolveTimeoutMs({ kind: 'implement' }), DEFAULT_TIMEOUT_BY_KIND.implement);
  assert.equal(resolveTimeoutMs({ kind: 'understand' }), DEFAULT_TIMEOUT_BY_KIND.understand);
  assert.equal(resolveTimeoutMs({ kind: 'unknown-kind' }), DEFAULT_TIMEOUT_BY_KIND.review);
  assert.equal(resolveTimeoutMs({}), DEFAULT_TIMEOUT_BY_KIND.review);
});

test('resolveTimeoutMs：优先级 显式 timeoutMs > env.DSH_CC_REVIEW_TIMEOUT_MS > kind 默认值', () => {
  // env 覆盖 kind 默认（implement 默认 960000，env 显式设更短的 300000）
  assert.equal(
    resolveTimeoutMs({ kind: 'implement', env: { DSH_CC_REVIEW_TIMEOUT_MS: '300000' } }),
    300000
  );
  // 显式 timeoutMs 优先级最高，盖过 env
  assert.equal(
    resolveTimeoutMs({
      kind: 'implement',
      env: { DSH_CC_REVIEW_TIMEOUT_MS: '300000' },
      timeoutMs: 5000,
    }),
    5000
  );
  // env 值非法（非数字）时兜底回 kind 默认值，不让脏 env 值污染超时
  assert.equal(
    resolveTimeoutMs({ kind: 'review', env: { DSH_CC_REVIEW_TIMEOUT_MS: 'not-a-number' } }),
    150000
  );
  // timeoutMs 显式传 0 也应生效（合法边界值，不能被当成"未传"）
  assert.equal(resolveTimeoutMs({ kind: 'review', timeoutMs: 0 }), 0);
});

// --- pollTaskResult ---

test('pollTaskResult：初始无文件，注入 done 文件后轮询得 done', async () => {
  const fake = createFakeFs();
  const p = path.join('D:\\cc-tasks', 'tasks', 'rev-poll01', 'result.json');

  setTimeout(() => {
    fake.files.set(p, JSON.stringify({ status: 'done', ok: true }));
  }, 50);

  const res = await pollTaskResult({
    fsImpl: fake,
    root: 'D:\\cc-tasks',
    taskId: 'rev-poll01',
    timeoutMs: 2000,
    intervalMs: 20,
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'done');
  assert.equal(res.reason, 'done');
  assert.equal(res.result.status, 'done');
});

test('pollTaskResult：failed 场景，reason=failed 且暴露 errorCode/errorText（与超时可区分）', async () => {
  const p = path.join('D:\\cc-tasks', 'tasks', 'rev-poll02', 'result.json');
  const fake = createFakeFs({
    [p]: JSON.stringify({ status: 'failed', reason: '执行出错', errorCode: 'runner-failed' }),
  });

  const res = await pollTaskResult({
    fsImpl: fake,
    root: 'D:\\cc-tasks',
    taskId: 'rev-poll02',
    timeoutMs: 2000,
    intervalMs: 20,
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'failed');
  assert.equal(res.reason, 'failed');
  assert.notEqual(res.reason, 'timeout-still-running');
  assert.equal(res.error, '执行出错');
  assert.equal(res.errorCode, 'runner-failed');
  assert.equal(res.errorText, '执行出错');
});

test('pollTaskResult：超时场景，reason=timeout-still-running 且携带 elapsedMs/taskDir（与真失败可区分）', async () => {
  const fake = createFakeFs();

  const res = await pollTaskResult({
    fsImpl: fake,
    root: 'D:\\cc-tasks',
    taskId: 'rev-poll03',
    timeoutMs: 60,
    intervalMs: 20,
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'timeout');
  assert.equal(res.reason, 'timeout-still-running');
  assert.notEqual(res.reason, 'failed');
  assert.equal(res.error, 'cc 审核超时');
  assert.ok(typeof res.elapsedMs === 'number' && res.elapsedMs >= 60);
  assert.ok(typeof res.taskDir === 'string' && res.taskDir.includes('rev-poll03'));
});

test('pollTaskResult：kind=implement 且未传 timeoutMs 时走 960000ms 默认档位（不会在极短时间内误超时）', async () => {
  const fake = createFakeFs();
  const p = path.join('D:\\cc-tasks', 'tasks', 'imp-poll01', 'result.json');
  setTimeout(() => {
    fake.files.set(p, JSON.stringify({ status: 'done' }));
  }, 30);

  const res = await pollTaskResult({
    fsImpl: fake,
    root: 'D:\\cc-tasks',
    taskId: 'imp-poll01',
    kind: 'implement',
    intervalMs: 10,
  });

  // 若默认超时仍是旧的 150000ms 档位，本用例在 30ms 内注入 done 也会通过；
  // 关键断言是不传 timeoutMs 时不会走"review 150000"以外的隐藏硬编码——
  // 用下面的显式超短 env 覆盖用例进一步验证按 kind 的默认值确实生效。
  assert.equal(res.ok, true);
  assert.equal(res.status, 'done');
});

test('pollTaskResult：env.DSH_CC_REVIEW_TIMEOUT_MS 覆盖优先于 kind 默认值（用极短 env 值提前触发超时）', async () => {
  const fake = createFakeFs();

  const res = await pollTaskResult({
    fsImpl: fake,
    root: 'D:\\cc-tasks',
    taskId: 'imp-poll02',
    kind: 'implement', // 默认档位 960000ms，若未被 env 覆盖不可能在 60ms 内超时
    env: { DSH_CC_REVIEW_TIMEOUT_MS: '60' },
    intervalMs: 20,
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'timeout-still-running');
});

test('pollTaskResult：兼容顶层布局 <root>/<taskId>/result.json', async () => {
  const p = path.join('D:\\cc-tasks', 'rev-poll04', 'result.json');
  const fake = createFakeFs({
    [p]: JSON.stringify({ status: 'done' }),
  });

  const res = await pollTaskResult({
    fsImpl: fake,
    root: 'D:\\cc-tasks',
    taskId: 'rev-poll04',
    timeoutMs: 2000,
    intervalMs: 20,
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'done');
});

// --- readReviewOut ---

test('readReviewOut：成功读取文本（tasks 布局）', async () => {
  const p = path.join('D:\\cc-tasks', 'tasks', 'rev-read01', 'out', 'review.md');
  const fake = createFakeFs({ [p]: 'VERDICT: APPROVED\n\n无意见' });

  const res = await readReviewOut({ fsImpl: fake, root: 'D:\\cc-tasks', taskId: 'rev-read01' });
  assert.equal(res.ok, true);
  assert.match(res.text, /VERDICT: APPROVED/);
});

test('readReviewOut：文件缺失 → ok:false', async () => {
  const fake = createFakeFs();
  const res = await readReviewOut({ fsImpl: fake, root: 'D:\\cc-tasks', taskId: 'rev-read02' });
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

// --- ccChannelAvailable ---

test('ccChannelAvailable：目录存在 → true', async () => {
  const fake = createFakeFs({ 'D:\\cc-tasks\\marker': 'x' });
  const ok = await ccChannelAvailable({ fsImpl: fake, root: 'D:\\cc-tasks' });
  assert.equal(ok, true);
});

test('ccChannelAvailable：ENOENT → false', async () => {
  const fake = createFakeFs();
  const ok = await ccChannelAvailable({ fsImpl: fake, root: 'D:\\not-exist' });
  assert.equal(ok, false);
});

// --- ccWatchdogAlive（缺陷 3：派发前 watchdog liveness 探针） ---

test('ccWatchdogAlive：root/queue/tasks 齐全且心跳新鲜 → ok:true，details 齐全', async () => {
  const now = 1_000_000_000;
  const root = 'D:\\cc-tasks';
  const fake = createFakeFs(
    { [`${root}\\marker`]: 'x' },
    {
      dirs: {
        [path.join(root, 'queue')]: ['a.task.json'],
        [path.join(root, 'tasks')]: ['rev-1', 'rev-2'],
      },
      stats: {
        [path.join(root, 'watchdog.log')]: now - 5000,
      },
    }
  );

  const res = await ccWatchdogAlive({ fsImpl: fake, root, now });
  assert.equal(res.ok, true);
  assert.equal(res.details.logAgeMs, 5000);
  assert.equal(res.details.queueDepth, 1);
  assert.equal(res.details.tasksCount, 2);
});

test('ccWatchdogAlive：心跳陈旧（超过默认阈值 120000ms）→ ok:false reason=cc-watchdog-stale:<ageMs>', async () => {
  const now = 1_000_000_000;
  const root = 'D:\\cc-tasks';
  const fake = createFakeFs(
    { [`${root}\\marker`]: 'x' },
    {
      dirs: {
        [path.join(root, 'queue')]: [],
        [path.join(root, 'tasks')]: [],
      },
      stats: {
        [path.join(root, 'watchdog.log')]: now - 200000,
      },
    }
  );

  const res = await ccWatchdogAlive({ fsImpl: fake, root, now });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'cc-watchdog-stale:200000');
  assert.equal(res.details.logAgeMs, 200000);
  assert.equal(WATCHDOG_STALE_MS_DEFAULT, 120000);
});

test('ccWatchdogAlive：env DSH_CC_WATCHDOG_STALE_MS 覆盖阈值——新鲜度足够但仍超过更严格的自定义阈值', async () => {
  const now = 1_000_000_000;
  const root = 'D:\\cc-tasks';
  const fake = createFakeFs(
    { [`${root}\\marker`]: 'x' },
    {
      dirs: {
        [path.join(root, 'queue')]: [],
        [path.join(root, 'tasks')]: [],
      },
      stats: {
        [path.join(root, 'watchdog.log')]: now - 5000, // 远小于默认阈值 120000
      },
    }
  );

  const res = await ccWatchdogAlive({
    fsImpl: fake,
    root,
    env: { DSH_CC_WATCHDOG_STALE_MS: '1000' }, // 自定义更严格阈值
    now,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'cc-watchdog-stale:5000');
});

test('ccWatchdogAlive：queue 目录缺失 → ok:false reason=queue-dir-missing（不读心跳、不白等）', async () => {
  const root = 'D:\\cc-tasks';
  const fake = createFakeFs({ [`${root}\\marker`]: 'x' });
  const res = await ccWatchdogAlive({ fsImpl: fake, root });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'queue-dir-missing');
});

test('ccWatchdogAlive：root 不可访问 → ok:false reason=root-unavailable', async () => {
  const fake = createFakeFs();
  const res = await ccWatchdogAlive({ fsImpl: fake, root: 'D:\\not-exist' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'root-unavailable');
});

// --- nodeFsImpl 存在性检查（不实际调用真实 IO） ---

test('nodeFsImpl：导出真实文件系统实现，具备六个方法（含 stat/readdir，供 ccWatchdogAlive 使用）', () => {
  assert.equal(typeof nodeFsImpl.readFile, 'function');
  assert.equal(typeof nodeFsImpl.writeFile, 'function');
  assert.equal(typeof nodeFsImpl.access, 'function');
  assert.equal(typeof nodeFsImpl.mkdir, 'function');
  assert.equal(typeof nodeFsImpl.stat, 'function');
  assert.equal(typeof nodeFsImpl.readdir, 'function');
});
