// v6-gen-d 链条定义：**只跑 D 组**（S 组已完成并留档）
//
// 为什么单独成链：链条在 S 被判 verify-rejected 时停止（那个拒绝是 verify-cc-task 的工具缺陷所致：
// 只读任务零改动被误判"无法归属改动"，已修并加自测）。若重跑 v6-gen，会因 prev.status='verify-rejected'
// 触发 clearStaleAttempt —— 把 S 的产物归档并重新派发 S，既浪费配额又丢掉已完成数据。
//
// 说明：本链文件名带 gen，但 chainId 与 v6-gen 不同 → 状态隔离逻辑会备份旧状态并按 D 重开。
export const chain = {
  id: 'v6-gen-d',
  items: [
    { label: 'D 组：多角色反证（同情境，唯一变量为协议）', spec: 'cc-specs/genexp-d.mjs', taskId: 'ccgen-20260916-prop-d' },
  ],
};
