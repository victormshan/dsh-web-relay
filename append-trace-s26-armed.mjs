// 记录：S 组 26 次重复的装填（补齐两臂对称样本）
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — 装填 S 组 26 次重复（补齐两臂对称，回应 §9.1 的"唯一缺失步骤"）

【为什么做】§9.1 结论为 inconclusive，三个原因中第一个是 **S 只有 n=1**——D 因重派循环意外得到 26 次独立运行，
两臂样本严重不对称，任何比较都是"单次观测对分布"的伪影。用户要求把 S 也跑到同轮数。

【装填方式（复用生成器，避免手写 26 份出错）】扩展 gen-genexp-specs.mjs：
  · 接受副本轮数参数，产出 cc-specs/genexp-s-r01..r26.mjs（唯一差别是 taskId 与元数据）；
  · 同时产出链条 cc-chains/v6-gen-s26.mjs（26 项，chainId=v6-gen-s26）。
【不变量校验（关键）】26 份复本 + 原 S 的 **prompt 逐字节相同**（2884 B），差异只在元数据——已实测
  "与基准不同的 = 0"。故复本与原 S 属同一处理，可与 D 组比较。
【门禁】27/27 通过（26 复本 + 原 S），链条引用的 26 个 spec 全部在盘。
【评分器加固（本轮同时修掉两个我自己的缺陷）】score-genexp-two-arms.mjs 初版：
  · RNG 用 \`seed * 1103515245\`——JS 下超出 2^53 精度、低位失真 → 退化成固定置换 →
    在 S n=1 时报出 \`p≈0.0000 → 拒绝同分布\`（荒谬）。改用 xorshift32（Math.imul 语义）；
  · 补 **最小样本护栏**：任一臂 n<5 时**拒绝报告 p 值**（正是 §9.1 伪影的来源）。
  双向自检通过：同分布 → p=1.000（不拒绝）；明显分离 → p=0.000（拒绝）。

【执行】调度器已从暂停恢复并指向 v6-gen-s26（备份 run-chain.cmd.paused.bak），
20:20 触发；链内 26 项串行、每项只读约 3 分钟，预计 80–110 分钟。
后台观察器 pwsh-5（watch-chain-then-score.mjs，窗口 200 分钟）会在链条达 26 项后**自动执行两臂分布比较**
并写入 D:\\cc-tasks\\_s26-watch.md —— 让评分由脚本完成，避免我在中途凭状态误判"跑完了"。

【下一步（脚本自动产出后）】把两臂分布（n、均值、每例命中率、分布形状、置换检验 p）写回
_EXPERIMENTS-2026-09-16.md §9，替换 inconclusive 为有分布支撑的结论；若 p 不显著，结论为
"在本规模与仪器下未见协议带来的提升"（并同时声明 token 仪器的系统性假阴性）。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
