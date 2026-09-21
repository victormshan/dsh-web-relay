// v4 自动链条定义（2026-09-16 装填）：把「目标外积压」中最成熟的 A4a 交给无人值守链条。
//
// 为什么**故意不挂 planStepId**：
//   权威计划 expr-2026-09-13_17-36-07 已 finalized=true / status=done（7 步全 approved）。
//   链条项若挂 planStepId，收口器会要求该步存在并走 /steps/auto-review 自动裁决；
//   而给已收口计划补塞步骤会造成「已收口却有待办步」的协议不一致状态，且等于伪造计划状态。
//   故本链条项不挂 planStepId → cc-chain.mjs L383 不尝试收口，项在「实现→验收→提交」后停在
//   accepted-awaiting-review，由链条产出 chain-review-needed.md，审批仍归主 agent/人工。
//   这与协议「高价值步骤禁止自审自批」一致：无人值守只推进实现与提交，绝不代为批准。
//
// 运行配置：调用方**不应**传 --close-after-accept（无 planStepId 时该项只做实现与提交；
//   若仍传该开关，cc-chain.mjs L410 会把状态标成 approved-and-closed，与「未收口」的事实不符）。
export const chain = {
  id: 'v4-a4',
  items: [
    {
      label: 'A4a 编码通道统计（纯逻辑层 + 有界读取器 + 用例）',
      spec: 'cc-specs/feat-chain-stats-a.mjs',
      taskId: 'ccfeat-20260916-chainstats-a',
    },
  ],
};
