// v10-acceptcall 链条：修复 acceptanceScript 的执行语义（通道自带验收器把合格产物判成失败）。
//
// 本项无 planStepId（不给已收口计划伪造协议步骤），故不传 --close-after-accept。
export const chain = {
  id: 'v10-acceptcall',
  items: [
    {
      label: 'v10 验收脚本执行语义修复（裸 token→node + 三类结局可区分）',
      spec: 'cc-specs/fix-acceptance-invocation.mjs',
      taskId: 'ccfix-20260918-acceptcall',
    },
  ],
};
