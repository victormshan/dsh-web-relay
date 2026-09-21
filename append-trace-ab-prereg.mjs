// A/B 实验预登记（在见到任何结果之前落盘，防止事后改判据）
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — A/B 实验预登记：规格评审协议（单方评审 vs 结构化对抗）

【要回答的问题（用户提出）】cc + 主 agent + 外部 AI 协作讨论商定方案，对方案质量提升是否显著。
主 agent 的判断是：**验证类问题收益不显著、生成类问题可能显著**；与其继续推演，不如做可控实验。

【预登记（此刻尚未产生任何一组结果）】
- H1：要求「主动反证 + 每个结论必须引用 file:line + 无法证实标 UNCERTAIN」的评审协议，
  比「普通评审」发现**更多真实缺陷**。
- H0：无差异 → 判定「该缺陷类别下协议无收益」（负结果同样计入结论）。
- 主指标：detection = 语料中 5 份**含真实缺陷**的草稿被标 FOUND 的个数（越高越好）。
- 次指标：falseAlarm = 2 份**无缺陷对照**被标 FOUND 的个数（越低越好）；UNCERTAIN 数；耗时。
- 判定规则：B 更优 ⇔ detection_B > detection_A **且** falseAlarm_B <= falseAlarm_A；
  detection 相等即判「无收益」。**规则在此刻固定，事后不得调整。**
- 规模限制：n=7（缺陷 5 / 对照 2），**试点规模**，只能检出大效应，不能给精确效应量。

【实验设计（保证唯一变量）】
- 语料 7 份**全部取自本会话真实事件**（不是编造）：①锚点把箭头函数写成 function 声明
  ②写入范围引用不存在的 test/selfcheck.test.mjs（真名 .js）③数值断言取自过时注释（2000ms vs 权威
  bin/watchdog.mjs 的 4000ms）④修复不完整（只豁免分支、遗漏其后无条件执行的 state.chainId 赋值）
  ⑤开关与状态组合产生与事实不符的标注（无 planStepId + --close-after-accept → 标 approved-and-closed）
  ⑥⑦两份无缺陷对照。
- 两组 spec 由 gen-ab-specs.mjs 从**同一语料**生成，唯一差异是协议段落；
  已用 verify-ab-spec-parity.mjs 校验：语料段落逐字节相同（1223 B）、协议前共通段逐字节相同（662 B）、
  语料及其后逐字节相同，**parity 退出码 0**。
- ground truth 单独落在 D:\\cc-tasks\\ab-labels.json，**不下发给 cc**（否则等于泄题）。
- 两组门禁 check-spec 均 RESULT: OK（各 1 条锚点、0 告警）。
- 评分由 score-ab-experiment.mjs **确定性解析**报告里的 AB-RESULT 机器可读块，不靠人工判读；
  解析失败即判「实验无效」，不构成任何结论。

【执行】链条 v6-ab（新 chainId，靠状态隔离重开；两项均 kind=understand 只读评审、不改仓库，
故不传 --close-after-accept），下次计划任务触发（09:40）自动派发 A 组，随后串行派发 B 组。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
