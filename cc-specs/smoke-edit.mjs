// 冒烟规格：验证修复后的 runner 是否真的允许 Edit/Write 写 /mnt/d/dsh-web-relay（commit 不参与）
// 目的：只验证「工具授权 + 跨目录写入」，不做任何真实改动；产物是一个待删除的探针文件。
export const task = {
  taskId: 'ccsmoke-20260914-edit',
  kind: 'implement',
  title: '冒烟：验证 Edit/Write 可写 /mnt/d/dsh-web-relay（跨目录授权修复验证）',
  refs: ['lib/index.js'],
  acceptance: '在 /mnt/d/dsh-web-relay 下用 Write 新建 .cc-edit-probe.txt（内容 probe-v1），用 Edit 改成 probe-v2，Read 回读确认，创建 done.flag；不改动仓库任何其它文件；不执行 git commit',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。这是一个**冒烟验证任务**，用来验证派发通道的文件工具授权是否正常；不要做任何真实代码改动，不要 git commit。

仓库根：/mnt/d/dsh-web-relay

【步骤（必须严格按序，并用指定工具，不要用 Bash 代替 Write/Edit）】
1) 用 **Write** 工具新建文件 /mnt/d/dsh-web-relay/.cc-edit-probe.txt，内容恰好一行：probe-v1
2) 用 **Edit** 工具把该文件里的 probe-v1 改成 probe-v2
3) 用 **Read** 工具读回该文件，确认内容是 probe-v2
4) 在任务目录（当前工作目录下的 tasks/ccsmoke-20260914-edit/）创建 out/report.md，写明：
   - 第 1 步用了哪个工具、是否成功；
   - 第 2 步用了哪个工具、是否成功（这是本次验证的核心）；
   - 第 3 步 Read 到的实际内容；
   - 若任何一步被拒绝，把拒绝原文一字不改地贴出来（不要重试超过 2 次，也不要停下来询问权限）。
5) 用 Bash 执行：touch tasks/ccsmoke-20260914-edit/done.flag

【硬约束】
- 除 .cc-edit-probe.txt 与任务目录内的 out/report.md、done.flag 外，不得创建或修改任何文件；
- 不得删除 .cc-edit-probe.txt（主 agent 会核对后自行清理）；
- 不得执行 git add/commit/push；
- 不得因为在某一步被拒就中途放弃：如 Edit 被拒，改用 Write 全文件重写完成第 2 步，并在报告中明确记录「Edit 被拒，已回退到 Write」。`,
};
