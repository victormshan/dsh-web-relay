// v6-ab 自动链条定义（2026-09-16 装填）：规格评审协议的 A/B 对照实验
//
// 目的：验证「结构化对抗（主动反证 + 结论必须引用 file:line + 无法证实标 UNCERTAIN）」
//       是否比「普通评审」更能发现方案真实缺陷。语料 7 份（5 份含真实缺陷 + 2 份对照），
//       全部取自本会话真实事件；两组 spec 由 gen-ab-specs.mjs 从同一语料生成，
//       唯一变量是协议段落（已用 verify-ab-spec-parity.mjs 校验逐字节相同）。
//
// 新 chainId（不往已 completedAt 的 v5-classify 里追加）：由 cc-chain.mjs 的 chainId 隔离逻辑重开状态。
//
// 同样**不挂 planStepId**：权威计划已 finalized，不伪造协议步骤；链条只做实现与提交。
// 本实验项均为 kind=understand（只读评审、不改仓库），故不传 --close-after-accept。
export const chain = {
  id: 'v6-ab',
  items: [
    { label: 'A 组：单方评审（7 份 spec 草稿）', spec: 'cc-specs/ab-review-a.mjs', taskId: 'ccab-20260916-review-a' },
    { label: 'B 组：结构化对抗评审（同语料）', spec: 'cc-specs/ab-review-b.mjs', taskId: 'ccab-20260916-review-b' },
  ],
};
