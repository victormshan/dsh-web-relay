// 设计2（E 组第 3 轮）：由 gen-exec-specs.mjs 生成，请勿手改。同臂各轮 prompt 逐字节相同。
export const task = {
  taskId: 'ccexec-20260917-e03',
  kind: 'implement',
  title: '设计2 E03：三模块缺陷修复（执行判定）',
  refs: [],
  anchors: [
    { file: 'lib/index.js', pattern: 'const healthHeavyEmpty = () => ({', note: '仓库存在性锚点（仅用于门禁）' },
  ],
  acceptance: 'out/report.md 含三段 ===EXEC-FIX n BEGIN/END=== 块，块内为可 import 的完整模块源码且导出名不变；必须写 done.flag；不得改动仓库任何文件（写入范围为空）。',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  writeScope: [],
  prompt: `你是 dsh-web-relay 项目组的资深工程师。下面给出 3 个**带缺陷的自包含模块**及其症状。请逐个定位根因并给出**修复后的完整模块源码**。

工作目录外不要改动任何文件；你可以自由地在 /tmp 下写临时脚本用于验证（推荐）。

【硬性要求】
- 修复后必须**保持原有导出名与调用签名**（探针会按原接口调用）。
- 输出必须包含上文的机器可读分隔行，块内**只放代码**。
- **完成后必须写入完成标记 done.flag**（路径见任务契约）——只写产物不写标记会被判为失败。

【必须输出机器可读块】报告 out/report.md 中必须包含如下块（严格使用下面的分隔行，逐案例按序）：

===EXEC-FIX 1 BEGIN===
<案例 1 修复后的**完整模块源码**（纯代码，不要 markdown 围栏）>
===EXEC-FIX 1 END===
===EXEC-FIX 2 BEGIN===
<案例 2 修复后的完整模块源码>
===EXEC-FIX 2 END===
===EXEC-FIX 3 BEGIN===
<案例 3 修复后的完整模块源码>
===EXEC-FIX 3 END===

块内只放代码（保持导出名不变、可直接被 import 运行）。块之后可另附简短说明。

================ 案例 ================

【案例 1】改动清单收集器
必须保留的导出：collectChanged(cwd)
症状：在某些工作区上，这个函数会让整个验收流程**崩溃**；而调用方只看到非零退出，于是把"工具崩溃"读成了"判定不合格"。请找出根因并修复。
带 bug 的现有源码：
\`\`\`js
import fs from 'node:fs';
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
\`\`\`

【案例 2】链条状态装载器
必须保留的导出：loadChainState({ stateFile, chainId, fsImpl }) 与 isComplete(state, itemCount)
症状：把调度器指向**另一条**链条后，新链条从来没有被派发过——日志只说"已完成，本次跳过"。请找出根因并修复。
带 bug 的现有源码：
\`\`\`js
import fs from 'node:fs';

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
\`\`\`

【案例 3】重派决策器
必须保留的导出：decideRedispatch({ prev, maxAttempts })
症状：当某一项**持续**失败（例如验收工具本身有缺陷、或环境被污染）时，链条会每 20 分钟重派一次，无限循环地消耗额度——实测连续重派 25 次、约 87 分钟执行时间，且没有任何终止条件。请找出根因并修复。
带 bug 的现有源码：
\`\`\`js
/**
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
\`\`\`

================ 案例结束 ================

【工作方式（E 组：可执行反例）】
1) 先按你的直觉给出每个案例的修复方案。
2) **反证**：以反证者身份，**必须写出一个可执行的 Node.js 复现脚本并真的运行它**，
   用**真实输出**证明你的修复在什么情况下会失效（或证明它成立）。
   若你无法构造出可执行的反例，必须在该案例的说明里明确写 NO_REPRO 并说明卡在哪一步——
   **不允许用散文代替可执行反例**。
3) 依据第 2 步的实测结论，输出最终修复后的完整源码。`,
};
