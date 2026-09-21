// 记录：三个开放项的处理（L410 修复 / 指针化装载 / 入口 ASCII 事故与护栏；仪器项的可行设计）
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — 三个开放项的处理（两项已修，仪器项给出可行设计）

【开放项 2：cc-chain.mjs 的 L410 标注缺陷 —— 已修并自测】
- 缺陷：状态标注原为 \`closeAfterAccept ? 'approved-and-closed' : 'accepted-awaiting-review'\`，
  **只看开关、不看是否真的收口**。而收口块的条件是 \`closeAfterAccept && it.planStepId\`——
  本会话 v4/v5/v6 各链条的项**都没有 planStepId**（为的是不给已收口计划伪造协议步骤），
  于是根本不进入收口，却被标成"已批准并闭环"，直接误导链条末尾的待审清单。
- 修复：抽出纯函数 \`itemFinalStatus({closeAfterAccept, planStepId, closure})\`——
  仅当「开关 + planStepId + closure 存在且无 error」三者齐备才算 approved-and-closed。
- 验证：新增 \`--selftest-final-status\` **5/5 通过**（含事故场景"无 planStepId 却传了开关 → 必须 awaiting"）；
  既有 selftest（quota/gate/clear）无回归；已纳入重启后回归套件。

【开放项 3：调度器指向已完成链条 —— 不是缺陷，但把"装填成本"降下来了】
- 重新界定：armed 空转是**设计**（completedAt 守卫），不是 bug。真实代价是**装填摩擦**：
  本轮为 v4-a4 / v4-a4b / v5-classify / v6-ab / v6-ab-b / v6-gen / v6-gen-d / v6-gen-s26 共**手改 run-chain.cmd 约 8 次**，
  每次都靠记忆决定"该不该带 --close-after-accept"——而该开关误用正是 L410 那类错误的温床。
- 改造：① 新增 \`arm-chain.mjs\`（装载+校验器）：校验链条 id 存在、items 非空、taskId 不重复、
  spec 文件存在、语法可解析；并对「请求收口但项无 planStepId」**直接拒绝**（需 --allow-close-without-planstep 才放行）。
  ② \`run-chain.cmd\` 改为**读指针** \`D:\\cc-tasks\\current-chain.txt\`，装填不再需要改 .cmd。
- 验证：arm-chain 自测 **7/7**；run-chain.cmd 三条路径实测——正常（记 armed + 幂等空转，exit 0）、
  缺指针（记 no chain armed - noop，exit 0）、空指针（同）——均不崩溃。

【本轮我自己又制造并修掉一个事故：UTF-8 注释击穿 .cmd 解析】
- 现象：新版 run-chain.cmd 跑出 **exit=255**，stderr 报 \`'.log' is not recognized\`、\`- was unexpected at this time\`。
- 根因：write 工具写的是 **UTF-8**，而 cmd.exe 按**系统 ANSI 代码页**解析 .cmd → 中文 rem 注释的字节被错解、
  破坏行结构。**这是入口文件，一旦解析失败整套无人值守会静默失效**。
- 修复：run-chain.cmd 改为**纯 ASCII 注释**（并保留"必须 ASCII"的显式警示注释），实测非 ASCII 字节 = 0、无 BOM。
- 加固（把错误变成永久护栏）：新增 \`verify-run-chain-cmd.mjs\`（校验纯 ASCII/无 BOM/指针化/延迟展开/noop 分支/未写死链条名），
  并纳入重启后回归套件 → 回归 **17/17 通过**（原 14 + 新 3）。

【开放项 1：仪器问题 —— 能优化，但**不能在同一批数据上**优化】
- 可优化处（工具层面，均可实现）：
  ① **成对比较**取代绝对 0/1 打分（成对判断远比绝对评分稳定，且直接测两臂差）；
  ② **风格归一**：截断到等长、剥离格式/标题层级后再评，直接压制"词密度/长度"这条混杂通道；
  ③ **多裁判平均**（单一裁判已有地板/天花板效应：案例1 全 0、案例2 11/12 判 1）；
  ④ 改用**与风格无关的判定**（如"是否给出可执行且正确的修复步骤"——由独立复算验证，而非读文字）。
- **不可做的事**：拿现在的 26+27 份数据去调仪器。那 50+ 份数据我已看过结果，
  在其上调参等于**事后拟合**，只会得到"我想要的结论"而不是真结论。
- 正确做法：**换新语料（out-of-sample）**——用本会话后段的真实事件做新 ground truth
  （例如"循环护栏缺失""EISDIR 崩溃=拒绝""漏传 workspacePath 导致仓库污染"这三条都是反直觉且特定于本系统的），
  先用改进后的仪器在新语料上**验证仪器本身**（例如加入已知好坏各一条作为锚点），再用于比较。
- 结论：仪器项**可优化，但代价是一次新的取数周期**（新语料 + 两臂各若干轮）；
  在拿到新语料前，生成类实验的结论只能停在 **inconclusive**——这是诚实的状态，不是待办遗漏。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
