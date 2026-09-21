// 追加 round-6 记录 + finalAcceptance 草案（node 写 UTF-8）
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const stamp = new Date().toISOString();
const body = `
## [主 agent] ${stamp}

【V2-2 规格补齐 + V1-2 增补声明补全入口（额度恢复前的规划工作）】
- V2-2 已按审计重划并写出规格（cc-specs/v2-2.mjs）：原「对接 lessons-inject」实测已接好（L32 / L1730-1736），
  改为「版间门与突破度联动」——L3606 现只判 iterations/currentIteration 与全 approved，不读 incrementalStreak，
  故协议「每 2 个 Incremental 后下一版须含 Structural/Paradigm」在自动迭代中无人执行。
  要求抽出纯函数 evaluateVersionAdvance({steps,state,max}) 并接入：advance=false 时不推进 currentIteration，
  改为在唤醒文案中要求下一版含 structural/paradigm + 落盘审计字段 breakthroughBlocked + appendTrace 留痕（不得置 paused/rejected）。
- V1-2 增补第 5/6 条：新增受控「声明补全入口」（/steps/declare 或 /steps/update action=declare），
  解决半状态只能靠重新 /ask 或手改 JSON 的问题；只允许显式置 true（未携带 autoDecision 不得把已有 true 回退），
  必须 appendTrace 记录前后值与理由，并接测试 ≥3 例。改后规格仍通过派发前门控。
- 延迟派发机制**干跑验证通过**（deferred-dispatch.ps1 -MaxTries 1）：探针返回 limit=True（resets 10:20am）→
  正确拒绝提前入队 → 队列保持 0 → 日志留痕 2026-09-14T07:44:36/07:44:41。10:22 的正式运行按同一路径执行。

【finalAcceptance 草案（待 V1-2 的声明补全入口落地后正式声明，用于 iterations=3 的三版自动演化收口）】
三版迭代全部落地并可核验：
① V1：突破度硬门禁可在 restructure 上阻断（含「全未声明」保守拦截 gate-needs-declaration 与
   DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED=1 显式放行），且 /ask 路径审计并落盘 incrementalStreak（不再绕过）；
   AutoIteration 声明完整性可见化（半状态告警 + 响应/steps.json 审计字段 + /steps/declare 补全入口）；
   /ask 注入严格声明样例与机器生成能力清单（给出注入前后字符数与裁剪策略实测）。
② V2：/ask payload 具备三段反思注入（案例 Top-K / 教训 Top-K / 能力清单），案例库抽出 lib/case-library.js 且测试 ≥6 例；
   版间门在连续 Incremental 达阈值时阻止进入下一版并要求 structural/paradigm（有审计字段与 trace 留痕）。
③ V3：node scripts/sync-engine-docs.mjs --check 零漂移（或漂移清单已澄清留档）；
   全量测试 100% 通过（基线口径：全量 ≥458 例、*.test.js 子集 ≥318 例）；
   cc 通道四项可靠性各有实测证据：守护常驻自愈（linger + Restart=always + kill 实测 NRestarts=1）、
   派发前探活（fail-open + 专用心跳 watchdog.heartbeat）、端到端验收器（verify-cc-task.mjs 五项）、
   失败分类与降级可审计（runner errorCode + classifyCcFailure + cc-stats 三类桶 + /health-check 字段）。
`;
fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 文件现有字节 =', fs.statSync(trace).size);
