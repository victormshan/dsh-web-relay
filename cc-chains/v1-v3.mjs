// V1→V3 自动链条定义：按计划依赖顺序串联 cc 步骤，供 cc-chain.mjs 执行
// 说明：链条只负责「派发→验收→提交→续派」，**不做协议审核/approve**（高价值步骤禁止自审自批，
//       审核由主 agent 走 /steps/update + /steps/auto-review 记录，链条结束会产出待审清单）。
export const chain = {
  id: 'v1-v3',
  items: [
    { label: 'V1-1 突破度硬门禁', planStepId: '1', spec: 'cc-specs/v1-1.mjs', taskId: 'v1-1-breakthrough-gate' },
    { label: 'V1-2 声明完整性 + 能力清单 + 声明入口', planStepId: '2', spec: 'cc-specs/v1-2.mjs', taskId: 'v1-2-autoiter-decl-integrity' },
    // V2-1 之前必须先过「V1 版间门」（计划第 3 步，主 agent 步；step 4 的 depends_on=[3]）。
    // 链条不代做版间门，但必须**等它 approved** 才允许推进 V2——否则等于绕过本计划核心的门禁设计。
    { label: 'V2-1 规划侧反思注入 + 案例库可测化', planStepId: '4', spec: 'cc-specs/v2-1.mjs', taskId: 'v2-1-planning-reflection', requiresApproved: ['3'] },
    { label: 'V2-2 版间门与突破度联动', planStepId: '5', spec: 'cc-specs/v2-2.mjs', taskId: 'v2-2-versiongate-breakthrough' },
    { label: 'V3-1 引擎↔文档一致性校验器', planStepId: '6', spec: 'cc-specs/v3-1.mjs', taskId: 'v3-1-engine-doc-sync' },
  ],
};
