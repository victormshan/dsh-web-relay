// v17-quotakind 链条：给配额唯一模块补细节 API（kind/resetsAt），好让消费方删掉各自的 kind 兜底。
// 本项无 planStepId（不给已收口计划伪造协议步骤），故不传 --close-after-accept。
export const chain = {
  id: 'v17-quotakind',
  items: [
    {
      label: 'v17 quota-parser 补 quotaKindOf + classifyQuotaProbeDetail（收敛 kind/resetsAt）',
      spec: 'cc-specs/add-quota-kind-api.mjs',
      taskId: 'ccfeat-20260919-quotakind',
    },
  ],
};
