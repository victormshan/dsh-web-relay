// 记录 A4b 重启后生效的核验结果（闭合「交付 → 重启 → 生效」闭环）
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — A4b 重启后生效核验（闭环完成）

【重启执行】信号由 watchdog 消费（restart.request.json 已消失）。新宿主 PID 10356 启动于 07:53:12
（信号定 07:53:11，watchdog tick 5s），命令行含 \`--trusted-host win10-dt.taile618c2.ts.net --no-open\`
（两个历史事故参数均正确）；3080 监听者**仅**该 PID，无第二宿主/EADDRINUSE。bootId
\`mu32to7l-5aeb301f\` → \`mu3buvhm-61e5def3\`，version 4.9.7。

【运行时核验 verify-a4b-live.mjs = 18/18 通过】
- ccChainStats 已在 /health-check 暴露，9 个子字段齐备，recent ≤10，total>0；
- **实测数字**：total=36 ok=25 failed=10 markerMissing=1 successRate=0.694
  byFailure={cc-quota-exhausted:2, cc-timeout:1, runner-failed:3, unknown:3, timeout:1}
  —— 编码通道（链条/主 agent 派发的 implement/fix/feat 任务）的失败分布**首次可观测**，
  正是目标第 (1) 项「失败分类与降级可审计」缺的那一块。
  注：byFailure 同时存在 \`timeout\` 与 \`cc-timeout\` 两桶，这是**既有设计**（见 docs/CC-HYBRID.md §10.3 附近：
  relay 侧轮询超时 reason='timeout-still-running' 与 cc 侧任务超时 cc-timeout 语义不同，刻意分桶），非缺陷；
  但运维口径上「超时几次」需合并两桶计。
- ccStats（审核通道）仍在且与 ccChainStats 为两个独立字段 → 无回归；
- selfCheck 契约 ok、differing 为空、bootId 与响应一致 → **交付完整**（未出现「改了 selfcheck.mjs
  却没改 index.js」的半交付状态；这正是本轮把 ccChainStats 写进 SELFCHECK_REQUIRED_HEALTH_FIELDS 的目的）。

【重启后回归 regression-post-restart.mjs = 14/14 通过】工具链与路由契约无漂移
（cc-doctor、verify-cc-task 正反例、收口器 noop、版间门、声明器、规格门控、\`--probe-only\` 无副作用、
clearStaleAttempt/额度解析/协议门/审核映射自测均符合预期）。

【对照证据（证明重启必要）】交付前实测运行时 /health-check **没有** ccChainStats；交付后重启才出现。
即「只交付不重启」不生效——与 deliver-three-copies.mjs 末尾提示一致。

【自动演化当前状态】按用户选择**不再装填**：run-chain.cmd 仍指 cc-chains/v4-a4b.mjs（已 completedAt），
计划任务每 20 分钟触发并按设计幂等空转。本轮累计两次无人值守派发成功（A4a 07:00→07:07、A4b 07:40→07:48）。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
