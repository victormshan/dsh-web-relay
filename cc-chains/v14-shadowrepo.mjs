// v14-shadowrepo 链条：影子沙盒 repoPath 自持回退（消除对环境变量的依赖）。
// 本项无 planStepId（不给已收口计划伪造协议步骤），故不传 --close-after-accept。
export const chain = {
  id: 'v14-shadowrepo',
  items: [
    {
      label: 'v14 影子沙盒 repoPath 自持回退（lib/ 上溯，不再依赖 DSH_RELAY_REPO_PATH）',
      spec: 'cc-specs/fix-shadow-repo-fallback.mjs',
      taskId: 'ccfix-20260919-shadowrepo',
    },
  ],
};
