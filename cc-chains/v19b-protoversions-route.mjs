// V1 增量链条：补 /protocol/versions 端点 + isConcurrent 别名（外部 AI 规划验收原文）
// 说明：链条状态文件是全局单文件，计划任务（PT20M）可能把链切回 v18-quotacap；
// 若被切走，重跑本文件会按 chainId 变化重新接管（旧状态自动备份）。
export const chain = {
  id: 'v19b-protoversions-route',
  items: [
    {
      label: 'V1 增量：/protocol/versions 只读端点 + isConcurrent 别名',
      spec: 'cc-specs/feat-protocol-versions-route.mjs',
      taskId: 'ccfeat-20260922-protoversions-route',
    },
  ],
};
