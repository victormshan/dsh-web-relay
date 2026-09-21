// v5-classify 自动链条定义（2026-09-16 装填）：修复失败分类器的 reason 回退路径
//
// 为什么是这项：主 agent 对 36 条真实结果做了独立分析，确认「unknown 盲区（3 条）」与
// 「同一失败模式分裂成 timeout / cc-timeout 两桶」都是分类器正则匹配不上 runner 真实 reason
// （done.flag=missing 带等号、exit=1 带等号）造成的——属目标「失败分类与降级可审计」的真实缺口。
//
// 新 chainId（不往已 completedAt 的 v4-a4b 里追加）：由 cc-chain.mjs 的按 chainId 隔离逻辑
// 自动备份旧状态并重开。
//
// 同样**故意不挂 planStepId**：权威计划已 finalized=true/done，不伪造协议步骤；
// 链条只推进「实现→验收→提交」，项停在 accepted-awaiting-review，审批仍归主 agent/人工。
// 调用方不应传 --close-after-accept（无 planStepId 时该项本就不做协议收口）。
export const chain = {
  id: 'v5-classify',
  items: [
    {
      label: '修复失败分类回退路径（等号形态 + 分桶统一 + 调用点合并 reason）',
      spec: 'cc-specs/fix-cc-failure-fallback.mjs',
      taskId: 'ccfix-20260916-fallback-classify',
    },
  ],
};
