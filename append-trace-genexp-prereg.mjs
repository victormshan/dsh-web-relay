// 生成类实验预登记（在见结果前落盘）
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — 生成类实验预登记（多角色反证能否想出更优替代方案）+ A/B 实验 A 组结果与两处自我更正

【A/B（验证类）实验 A 组结果】A 组 = 单方评审，已完成：命中 3/5、误报 0/2（仓库 0 改动，HEAD 347ac69，已独立核对）。
- 案例 1/2/3 全部 FOUND，且案例 3 **回源读到** bin/watchdog.mjs 的 4000ms，未被过时注释误导。
- 案例 4/5 报 **UNCERTAIN** —— 原因不是协议失效，而是**我的选题缺陷**：这两例的证据在 cc-chain.mjs，
  而它在 D:\\dsh relay test（主 agent 工作区），**不在仓库 /mnt/d/dsh-web-relay 内**，评审方无权限读。
  该缺陷**与协议无关**（两组同等受制），但使可达缺陷只剩 3 条 → **两组天花板都是 3/5**，
  按预登记规则「detection 相等即判无收益」，主指标实际已被判定为无 headroom。
- 自我更正 1（选题）：标注集必须落在评审方可读范围内，否则测的是权限边界而不是评审能力。
- 自我更正 2（spec bug）：A 组 result.json 为 status=failed / exit=0 / errorCode=cc-marker-missing /
  reason="claude exit=0; done.flag=missing" —— 根因是**我的生成器漏写「完成后必须写入 done.flag」**。
  两点值得记录：① 这是今天刚修的分类器**当场体现价值**（正确识别为"产物完好、仅缺标记"，未被误判为"代码写坏"）；
  ② B 组 spec 保持与 A 逐字节同源，**故意不补该指令**，否则破坏"唯一变量"不变量。
  B 组已单独成链 v6-ab-b（不重跑 A、不归档其产物），10:00 触发。

【生成类实验预登记（此刻尚未跑任何一组）】
- 目的：测「多角色反证协议」能否提出**历史上被事件验证过的更优替代方案**（生成问题），
  区别于 A/B 的验证类问题（能否发现既存缺陷）。
- H1：多角色反证（架构师提案 → 反证架构师专找"在本系统特定机制下会失效之处" → 择优）
  在 **repo-specific 子集** 上命中数多于单方提议。H0：无差异 → 判「该层面协议无收益」。
- 主指标：**specific 子集（案例 1 链条状态设计、案例 2 诊断模式副作用）命中数 0-2**。
  次指标：全 4 例命中；无关/误解建议（定性）；耗时。
- 判定规则：D 更优 ⇔ specific 命中 D > S；相等即判无收益。**此刻固定，事后不得调整。**
- 混淆控制（关键）：通用建议（案例 4「大任务要拆」）靠训练知识就能答对 → 会吹高效应，
  故主指标**只在 specific 子集**上算；案例 3（交付方式）标 mid 单独列出。
  案例 1、2 特意选**反直觉且特定于本仓库**者：状态被谁在什么条件下写盘、只在某入口加判断够不够。
- 语料只给**决策前上下文**，不给任何事后线索、不给答案；ground truth 落在
  D:\\cc-tasks\\genexp-labels.json（不下发）。
- 唯一变量：两组 spec 由 gen-genexp-specs.mjs 从同一语料生成；用**通用化**的
  verify-spec-pair-parity.mjs 校验：语料段 611B、协议前共通段 589B、语料及其后 634B 均逐字节相同，exit 0；
  该脚本同时回归了 A/B 两 spec（传协议标记 '【评审协议'）通过。
- 评分：score-genexp.mjs 确定性 token 匹配（每例若干概念组，全部组命中才算 hit），
  并保留 ALTERNATIVE 原文供人工阅读；无报告时**拒绝给结论**（已空跑自检）。
- 自我更正 3（工具）：通用 parity 脚本第一版把协议标题写死为 '【工作方式'，校验 A/B 时误报 FAIL。
  已参数化，并加**变异测试**（在语料中插入 TAMPERED → 脚本必须 exit 1）证明它非空转。

【执行次序（避免互相干扰）】B 组 10:00 由 v6-ab-b 触发（预计因缺 done.flag 判 marker-missing 并停止该链）；
待其结算后再把 run-chain.cmd 指向 v6-gen（S → D）。**不顺延合用一条链**：链条在任一项 rejected 时会停止，
若混链，B 会把 S/D 一起挡掉；也不并发——多条链会争 chain.lock，后者直接跳过。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
