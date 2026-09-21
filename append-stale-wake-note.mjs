// 记录陈旧唤醒拒执（node 写 UTF-8，避免 PowerShell 文本处理）
import fs from 'node:fs';

const p = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();
const lines = [
  '',
  `## [主 agent] ${now}`,
  '',
  '【陈旧唤醒拒执记录：Step 1「已开始/重新打开，请执行」】',
  '收到的装配唤醒声称 Step 1 刚开始/被重新打开，要求执行并置 review。经核对权威状态，该唤醒为**乱序投递的陈旧唤醒，不予执行**（避免重复实施已批准的成果）：',
  '- 权威 steps.json：step 1 = **approved**，reviewedBy=external，notes=4；currentStep="1"、activeSteps=[]（无在执行步骤）。',
  '- notes 时间线完整：start(16:23:55, mainagent) → shadow-degraded(16:23:55) → complete(16:23:55，含 5 条证据) → approved(16:24:28, external)。',
  '- 该次审核为 **Swarm 双角色盲审**：双角色均通过（Security-Auditor 通过 + Refactoring-Architect 通过）。',
  '- 代码与测试实存：lib/breakthrough-gate.js 含 evaluateBreakthroughPlan 与 gate-needs-declaration；test/breakthrough-gate.test.js 用例 20（要求 ≥13）；lib/index.js 中 auditBreakthrough 命中 5 处（含 /ask 路径审计）。',
  '- 提交 4d43ea1（3 文件 +264/-6）；工作树干净（HEAD 2680fb9）。',
  '- 唤醒来源判定：由主 agent 自身在 16:23:55 调用 /steps/update action=start 触发的 start 唤醒，而我随后 30 秒内已 complete + auto-review 完成闭环——即该唤醒相对后续动作**乱序/过期**（同类：lesson L-2026-0909-039 延迟投递噪声）。',
  '处置：不重做、不重复提交；仅在 trace 留痕。遗留 cosmetic 项：currentStep 仍指向 "1"（无 API 可直接清空），待 step 2 被 start 时自然前移；expr.phase=executing 与「计划进行中」语义一致，无需改动。',
  '下一步仍受外部约束：cc 订阅额度 3:20am 恢复；链条 dsh-cc-chain-v1v3-b 每 20 分钟触发至 08:20，将自动归档 V1-2 残留并续跑（含 lesson L-2026-0915-065 的 clearStaleAttempt 修复）。',
  '',
];
const body = lines.join('\n');
fs.appendFileSync(p, body, 'utf8');
console.log('  留痕字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(p).size);
