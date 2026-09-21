// 向权威轨迹追加一条「V1-1 已挂延迟自愈派发」记录（node 写 UTF-8）
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const stamp = new Date().toISOString();
const body = `
## [主 agent] ${stamp}

【V1-1 派发编排（额度约束下的无人值守恢复）】
- 背景：cc 通道订阅额度于 2026-09-14T07:42 耗尽（claude.log: resets 10:20am Asia/Shanghai）；
  本窗口内已完成两件通道级修复并提交：hb3（探针 fail-open + 专用心跳 + 失败分类 → 1113494）、
  stats（cc-stats 分类桶 → 见同日提交），后者虽 result.json=failed 但经独立验收 7/7 ACCEPT（lesson L-2026-0914-063）。
- 处置：V1-1 规格已通过派发前门控（node --check + v2 validate-task + 编码自检 + 引用文件存在性），
  暂存至 D:\\cc-tasks\\deferred\\v1-1-breakthrough-gate.task.json（**不入 queue**，避免 watchdog 立即取走必然失败），
  由 Windows 计划任务 dsh-cc-deferred-v11 在 10:22 启动 deferred-dispatch.ps1 探测通道（claude -p 探针），
  恢复后自动入队 → watchdog 派发 → runner 执行。
- 预期验收（主 agent 侧，落地后执行）：node verify-cc-task.mjs v1-1-breakthrough-gate（五项）+ 真实仓库跑
  evaluateBreakthroughPlan 对「7 步全 null」的保守拦截验证 + 断点续验（/ask 路径 incrementalStreak 落盘）。
- 若 10:22 仍受限：探针每 20 分钟重试，最多 30 次；每次尝试都写 D:\\cc-tasks\\deferred-dispatch.log 可审计。
`;
fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 文件现有字节 =', fs.statSync(trace).size);
