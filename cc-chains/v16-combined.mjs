// v16-combined 链条：把配额耗尽期间积压的两项合成一条按序执行（各自独立验收）。
//
// 为什么合成（2026-09-19 实测教训）：指针文件只有一个位置，我先 arm 了 v14（影子回退），
// 又 arm 了 v15（配额分类）→ **v14 被指针覆盖、永远不会派发**。链条的装填是"指针覆盖式"的，
// 积压多项时必须合成一条多项链条（或先跑完再 arm 下一条），不能连 arm 两次。
//
// 顺序：先影子回退（更早排期、且与额度无关的机制缺陷），再配额分类。
export const chain = {
  id: 'v16-combined',
  items: [
    {
      label: 'v14 影子沙盒 repoPath 自持回退（lib/ 上溯，不再依赖 DSH_RELAY_REPO_PATH）',
      spec: 'cc-specs/fix-shadow-repo-fallback.mjs',
      taskId: 'ccfix-20260919-shadowrepo',
    },
    {
      label: 'v15 配额判断收敛到唯一模块 lib/quota-parser.mjs（cc-channel + cc-stats 依赖它）',
      spec: 'cc-specs/converge-quota-single-source.mjs',
      taskId: 'ccfix-20260919-quotaclass',
    },
  ],
};
