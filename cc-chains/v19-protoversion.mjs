// V1 链条：协议版本选择器接地（expr-2026-09-22_17-42-08 第 1 版）
// 7 步串行一次派发：第 2、3 步同改 lib/client.js，规划层未互相串行，派发层强制串行以消除并发冲突。
// planStepId 暂不传（协议 steps 的 complete/approve 由主 agent 在独立通道核验后统一收口）。
export const chain = {
  id: 'v19-protoversion',
  items: [
    {
      label: 'V1 协议版本选择器接地（后端单一来源 + 前端数据驱动 + contentKey 泛化）',
      spec: 'cc-specs/feat-protocol-version-grounding.mjs',
      taskId: 'ccfeat-20260922-protoversion',
    },
  ],
};
