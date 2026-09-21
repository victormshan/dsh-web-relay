// v4-a4b 自动链条定义（2026-09-16 装填）：接续已完成的 v4-a4，装第二项 A4b。
//
// 为什么不直接往 v4-a4 里加第二项：v4-a4 的状态已 completedAt（index=1 == items.length），
// 追加项会让「已完成」标记与实际不符（completedAt 已设却仍有待办项）。改为**新链条 id**，
// 由 cc-chain.mjs 的按 chainId 隔离逻辑自动备份旧状态并重开——这正是本轮新修能力的用途。
//
// 同样**故意不挂 planStepId**：权威计划已 finalized=true/done，不伪造协议步骤；
// 链条只推进「实现→验收→提交」，项停在 accepted-awaiting-review，审批仍归主 agent/人工。
// 调用方不应传 --close-after-accept（无 planStepId 时该项本就不做协议收口）。
export const chain = {
  id: 'v4-a4b',
  items: [
    {
      label: 'A4b /health-check 接线 ccChainStats + 自检契约 + 文档 + 耗时实测',
      spec: 'cc-specs/feat-chain-stats-b.mjs',
      taskId: 'ccfeat-20260916-chainstats-b',
    },
  ],
};
