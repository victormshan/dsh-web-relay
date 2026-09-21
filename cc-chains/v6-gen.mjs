// 生成类实验链条：S 组（单方提议）→ D 组（多角色反证），串行。
// 两项均为 kind=understand（只读、不改仓库），故不传 --close-after-accept。
// 与 A/B 实验分开成链的原因：链条在任一项被判 rejected 时会**停止**，
// 若把 B 组（已知会因缺 done.flag 判 marker-missing）与 S/D 混在一条链里，B 会把 S/D 一起挡掉。
export const chain = {
  id: 'v6-gen',
  items: [
    { label: 'S 组：单方提议（4 个设计情境）', spec: 'cc-specs/genexp-s.mjs', taskId: 'ccgen-20260916-prop-s' },
    { label: 'D 组：多角色反证（同情境）', spec: 'cc-specs/genexp-d.mjs', taskId: 'ccgen-20260916-prop-d' },
  ],
};
