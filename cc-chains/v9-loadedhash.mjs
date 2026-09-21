// v9-loadedhash 链条：⑤b（暴露已加载代码指纹 + 修正过时注释）
//
// 目的：让「宿主到底加载了哪份代码」从"靠 bootId 间接推断"升级为**精确可证**——
// 插件启动时按约定算法算一次 lib 代码指纹并暴露到 /health-check，
// 而 verify-delivery-live.mjs 用**同一算法**对仓库独立重算并比对。
// 本项无 planStepId（不给已收口计划伪造协议步骤），故不传 --close-after-accept。
export const chain = {
  id: 'v9-loadedhash',
  items: [
    {
      label: '⑤b /health-check 暴露 loadedLibHash + 修正过时注释',
      spec: 'cc-specs/feat-loaded-code-hash.mjs',
      taskId: 'ccfeat-20260917-loadedhash',
    },
  ],
};
