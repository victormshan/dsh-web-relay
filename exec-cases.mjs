// 设计2 三案例的**带 bug 模块源码**（展示给 cc）+ 症状描述；隐藏探针在 probes/ 下，不下发给 cc。
// 三个模块都自包含、无仓库依赖，且每个都对应本会话一次真实事故（可执行复现）。

export const MODULES = {
  1: {
    title: '改动清单收集器',
    exports: 'collectChanged(cwd)',
    buggySource: `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * 收集 cwd 工作区里"本次改动的文件"，返回 [{ file, size }]。
 * 调用方用它核对改动是否都在声明的写入范围内。
 */
export function collectChanged(cwd) {
  const out = String(spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }).stdout || '');
  return out
    .split('\\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^(\\?\\?|M|A|D|\\s)+/, '').trim())
    .map((f) => {
      const p = path.join(cwd, f);
      const buf = fs.readFileSync(p);
      return { file: f, size: buf.length };
    });
}
`,
    symptom: '在某些工作区上，这个函数会让整个验收流程**崩溃**；而调用方只看到非零退出，于是把"工具崩溃"读成了"判定不合格"。请找出根因并修复。',
  },
  2: {
    title: '链条状态装载器',
    exports: 'loadChainState({ stateFile, chainId, fsImpl }) 与 isComplete(state, itemCount)',
    buggySource: `import fs from 'node:fs';

/**
 * 从 stateFile 装载链条进度状态。状态文件是**单文件共享**的：不同链条复用同一个文件。
 * 返回值至少含 { chainId, index, items, completedAt }。
 */
export function loadChainState({ stateFile, chainId, fsImpl = fs }) {
  let state = fsImpl.existsSync(stateFile)
    ? JSON.parse(fsImpl.readFileSync(stateFile, 'utf8'))
    : null;
  if (!state) state = { chainId, index: 0, items: {} };
  state.chainId = chainId;
  return state;
}

/** 链条是否已全部跑完（跑完后调用方会直接跳过，避免重复派发）。 */
export function isComplete(state, itemCount) {
  return !!state.completedAt && state.index >= itemCount;
}
`,
    symptom: '把调度器指向**另一条**链条后，新链条从来没有被派发过——日志只说"已完成，本次跳过"。请找出根因并修复。',
  },
  3: {
    title: '重派决策器',
    exports: 'decideRedispatch({ prev, maxAttempts })',
    buggySource: `/**
 * 判断某项在本次触发时是否应当重新派发。
 * prev 为该项目的上次状态记录，形如 { status, at }；首次为 null。
 * 返回值：'redispatch' | 'skip' | 'stop'（stop = 停止链条并等人工介入）
 *
 * 调用场景：计划任务每 20 分钟触发一次；每次执行都会占用一份稀缺的共享额度。
 */
export function decideRedispatch({ prev, maxAttempts = 3 }) {
  if (!prev) return 'redispatch';
  const RETRYABLE = ['quota-paused', 'waiting', 'verify-rejected', 'dispatch-failed'];
  return RETRYABLE.includes(prev.status) ? 'redispatch' : 'skip';
}
`,
    symptom: '当某一项**持续**失败（例如验收工具本身有缺陷、或环境被污染）时，链条会每 20 分钟重派一次，无限循环地消耗额度——实测连续重派 25 次、约 87 分钟执行时间，且没有任何终止条件。请找出根因并修复。',
  },
};
