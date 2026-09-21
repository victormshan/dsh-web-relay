// v18-quotacap 链条：插件"已知耗尽跳过派发"补 cap（复用唯一模块）+ 持久化 quotaKind。
// 本项无 planStepId（不给已收口计划伪造协议步骤），故不传 --close-after-accept。
export const chain = {
  id: 'v18-quotacap',
  items: [
    {
      label: 'v18 插件跳过策略补 cap（复用 shortcutCapMs）+ 持久化 quotaKind',
      spec: 'cc-specs/fix-quota-skip-cap.mjs',
      taskId: 'ccfix-20260919-quotacap',
    },
  ],
};
