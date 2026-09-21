// 记录：实验一（验证类）最终判定 + 实验二装填
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — 实验一最终判定（负结果）+ 实验二装填

【实验一（验证类：评审协议 A/B）最终结果】B 组 10:00 派发、10:05:46 结算（约 5.5 分钟）。
评分（score-ab-experiment.mjs，确定性解析，已写 D:\\cc-tasks\\ab-result.json）：

| 指标 | A（单方评审） | B（结构化对抗） |
|---|---|---|
| 命中（含缺陷案例） | 3/5 | 3/5 |
| 其中**可达**的 3 条 | **3/3** | **3/3** |
| 误报（对照 2 条） | 0/2 | 0/2 |
| UNCERTAIN | 2 | 2 |
| 耗时 | ≈7 min | ≈5.5 min |

预登记判定规则为 B 更优 ⇔ detection_B > detection_A 且 falseAlarm_B ≤ falseAlarm_A；
实际 detection 相等 → **判定「该类别下协议无收益」（负结果照实报）**。

唯一可辨差异（不影响指标）：B 在**够不着的案例上仍在继续找证据**（给出 lib/index.js:4867、
docs/OPS-CC-CHAIN.md:11 等定位），而 A 的案例 4 直接写 evidence=-（放弃定位）。
即反证纪律改变了**行为方式**，但在可达范围内未改变结果。

【这个负结果说明了什么（重要）】一半原因是**语料对该协议没有 headroom**：
基座模型的普通评审已把可达缺陷全部找到（3/3）。**在基线已达天花板的任务上比较协议，必然测不出差异。**
故本次同时暴露的是**实验设计教训**（已写入报告方法论第 8 条）：设计前必须先确认"基线会漏"。
实验二（生成类）正是换到"基线可能漏"的问题上重做。

【两处附带价值】
- B 组同样被判 cc-marker-missing（与 A 同源：我的生成器漏写 done.flag 指令）——
  这再次验证同日上线的分类修复：正确识别为"产物完好、仅缺标记"，未被误判为"代码写坏"。
- 两臂在对照案例上**误报均为 0**：说明"反证纪律会导致乱报"这一常见担忧，在本类别下**未发生**。

【实验二装填】B 结算后链锁释放，已把 run-chain.cmd 指向 cc-chains/v6-gen.mjs（S → D，两项 kind=understand
只读、不传 --close-after-accept）。下一次计划任务触发（10:20）派发 S，随后串行 D。
两个观察器已挂（pwsh-3 盯 S、pwsh-4 盯 D）。此前 A/B 完成的备份链：
run-chain.cmd.v6-ab-b.bak。

【文档】两项实验合并报告已建立并回填实验一全部结论：D:\\dsh relay test\\_EXPERIMENTS-2026-09-16.md
（含预登记、方法论 8 条、自我更正 6 条、局限、证据索引；实验二部分标为进行中）。
未完成部分一律显式标注状态，不把未完成读成结论。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
