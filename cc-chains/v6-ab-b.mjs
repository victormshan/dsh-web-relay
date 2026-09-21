// v6-ab-b 链条定义：**只跑 B 组**（A 组已于 09:40 完成并留档，不重跑、不归档其产物）
//
// 为什么不复用 v6-ab：链条在 A 组被判 verify-rejected 时停止（三项契约未满足之一：done.flag 缺失），
// 而 cc-chain 对 prev.status='verify-rejected' 会 clearStaleAttempt（归档并允许重派）——
// 重跑 v6-ab 会把 A 的产物归档并重新派发 A，既浪费配额又丢掉已完成的数据。
//
// B 组的 spec **保持与 A 组逐字节同源**（均由 gen-ab-specs.mjs 生成，唯一差异是协议段落）：
// 因此不修 spec、不加 done.flag 提示，否则会破坏「唯一变量」不变量。
// 代价：B 也会因缺 done.flag 被判 cc-marker-missing —— 但这不影响评分
// （评分直接读 out/report.md，不经链条验收），且正好复现今天分类器修复的价值。
export const chain = {
  id: 'v6-ab-b',
  items: [
    { label: 'B 组：结构化对抗评审（同语料）', spec: 'cc-specs/ab-review-b.mjs', taskId: 'ccab-20260916-review-b' },
  ],
};
