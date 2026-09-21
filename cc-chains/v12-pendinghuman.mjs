// v12-pendinghuman 链条：「需要人介入 → 唤醒主 agent」通路的插件侧实现（补齐自动演化缺口）。
// 本项无 planStepId（不给已收口计划伪造协议步骤），故不传 --close-after-accept。
export const chain = {
  id: 'v12-pendinghuman',
  items: [
    {
      label: 'v12 插件侧读取需要人介入信号并唤醒主 agent（/health-check 暴露 pendingHuman）',
      spec: 'cc-specs/feat-pending-human-wake.mjs',
      taskId: 'ccfeat-20260918-pendinghuman',
    },
  ],
};
