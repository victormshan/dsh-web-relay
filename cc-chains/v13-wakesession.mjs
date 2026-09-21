// v13-wakesession 链条：唤醒目标解析补回退（env → 最近落盘 expr 的 sessionId）。
// 本项无 planStepId（不给已收口计划伪造协议步骤），故不传 --close-after-accept。
export const chain = {
  id: 'v13-wakesession',
  items: [
    {
      label: 'v13 唤醒目标解析补回退（否则宿主无 DSH_SESSION_ID 时永远只能记录）',
      spec: 'cc-specs/fix-wake-session-fallback.mjs',
      taskId: 'ccfix-20260918-wakesession',
    },
  ],
};
