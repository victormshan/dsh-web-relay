// v15-quotaclass 链条：插件侧额度分类覆盖 weekly limit（三处同款漏判的最后一处）。
// 本项无 planStepId（不给已收口计划伪造协议步骤），故不传 --close-after-accept。
export const chain = {
  id: 'v15-quotaclass',
  items: [
    {
      label: 'v15 插件侧额度分类覆盖 weekly limit（与 runner/链条对齐）',
      spec: 'cc-specs/fix-quota-weekly-classify.mjs',
      taskId: 'ccfix-20260919-quotaclass',
    },
  ],
};
