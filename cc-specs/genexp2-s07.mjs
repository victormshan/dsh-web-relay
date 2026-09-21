// 生成类实验第二轮（S 组第 7 轮）：由 gen-genexp2-specs.mjs 生成，请勿手改。
// 同一组内各轮的 prompt **逐字节相同**，仅 taskId 不同。
export const task = {
  taskId: 'ccgen2-20260917-s07',
  kind: 'understand',
  title: '生成类实验二轮 S07（机器可读结论块）',
  refs: ['lib/index.js', 'bin/watchdog.mjs'],
  anchors: [
    { file: 'lib/cc-stats.mjs', pattern: 'export function summarizeChainTasks', note: '仓库存在的符号之一' },
  ],
  acceptance: 'out/report.md 含严格格式 GEN2-RESULT 块（情境 1..5 各 ALTERNATIVE/RISK 一行）；必须写 done.flag；不得修改仓库任何文件（写入范围为空）。',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  writeScope: [],
  prompt: `你是 dsh-web-relay 项目组的资深架构师。下面给出 5 个**设计情境**（均为真实工程场景，但只给出决策前的上下文）。
请对每个情境**独立**给出你的设计建议。

仓库根：/mnt/d/dsh-web-relay（只读；你可以读它来了解现状，但**不得修改任何文件**）

【约束】
- **不得修改仓库任何文件**；只允许读取与检索。
- 产物写你自己的工作目录 out/report.md。
- **完成后必须写入完成标记 done.flag**（路径见任务契约）——只写产物不写标记会被判为失败。
- 不要猜测本任务的目的或情境的来源。

【必须输出机器可读块】报告 out/report.md 中必须包含如下块（严格格式，逐案例、顺序与编号一致）：

GEN2-RESULT-BEGIN
CASE 1:
ALTERNATIVE: <一句话：你最终推荐的做法>
RISK: <一句话：在你所推荐的做法下，最可能失效的地方>
CASE 2:
ALTERNATIVE: ...
RISK: ...
CASE 3:
ALTERNATIVE: ...
RISK: ...
CASE 4:
ALTERNATIVE: ...
RISK: ...
CASE 5:
ALTERNATIVE: ...
RISK: ...
GEN2-RESULT-END

块之后，每例另附 3-6 行说明：为什么这样设计、考虑过哪些替代、为什么排除它们。

【工作方式（S 组）】
按你作为资深架构师的常规判断，对每个情境给出你认为最合适的做法，并说明关键取舍。

================ 情境（共 5 个） ================

【情境 1】失败重派策略
某自动化链条由计划任务每 20 分钟触发一次。某项失败后，实现会把该项标记为"可重跑"，依赖下一次触发自动重试；
每次执行会占用一份稀缺的共享额度。请给出你的失败重派设计。

【情境 2】改动归属判定
一个验收器用 \`git status --porcelain\` 取出"本次任务改动的文件清单"，再与任务声明的写入范围核对。
请评估这个判定方式是否稳，并给出你的做法。

【情境 3】运行数据的落盘位置
某组件把运行记录写到 \`<工作区>/web-relay/experiments/\`；而"工作区"由调用方传入，未传时回退到进程的 cwd。
仓库根目录的 \`.gitignore\` 里写着 \`web-relay/experiments/\`。请评估这样设计会出什么问题、并给出改法。

【情境 4】避免重复派发（过度设计对照）
一条链条的若干项全部跑完后，计划任务仍会每 20 分钟触发一次，会把同一批项重新派发一遍。
请给出你的做法。

【情境 5】聚合持续增长的目录（过度设计对照）
要出一个统计：读某个持续增长的目录（已有数十个子目录，每个子目录一份小 JSON），聚合其中的结果。
请给出你的读取与聚合设计。

================ 情境结束 ================`,
};
