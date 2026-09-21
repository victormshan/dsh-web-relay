// 向权威轨迹追加 V1 Step 0 建模（审计后修订版）——用 node 写 UTF-8，避免 PowerShell 双重编码
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const stamp = new Date().toISOString();
const body = `
## [主 agent] ${stamp}

【主 agent V1 Step 0 建模（审计后修订版；对齐 auto-iteration-modeling §3/§5）】

背景：17:42 那版 Step 0 是审计前的。本轮对全计划做了可行性审计（lesson L-2026-0914-060 对策），
发现 3 步前提被证伪（V1-2 落盘已实现、V2-1 案例库已存在、V2-2 lessons-inject 已接线），
以下为修订后的 V1 建模，权威计划文本已按此更新（/steps/restructure，依赖图未动）。

0.1 功能树（V1 触及的子系统）
- 规划入口层：/ask（外部 AI 生成 Step List）→ record md + steps.json 落盘；/steps/restructure（在线重构，仅 pending/rejected）
- 门禁层：lib/breakthrough-gate.js（breakthroughTypeOf / versionTypeOf / auditBreakthrough，现仅 warn 非阻断）
- 状态持久化层：writeStepState 写白名单（iterations/currentIteration/finalAcceptance/autoDecision/rejectStreak/incrementalStreak）
- 声明解析层：lib/autoiter-decl.js（extractAutoIterDecl，严格 JSON 块优先 + 叙述式兜底）
- 版间门层：/steps/update 的 status=done 分支（L3606 起）——现只判 iterations/currentIteration
- 测试面：test/breakthrough-gate.test.js（5 例）、test/autoiter-decl.test.js、test/auto-iter-decl.test.js

0.2 V1 两条真实调用流程（标出门禁接入点）
流程 A（重构路径）：外部 AI → POST /steps/restructure → 依赖校验（悬空 depends_on→400）→ normalizeStep →
  【V1-1 接入点①】evaluateBreakthroughPlan({steps:newSteps, history}) → gatePassed=false 则 400 breakthrough-gate + trace 留痕 →
  writeStepState → 唤醒主 agent
流程 B（规划路径）：用户 prompt → POST /ask → payload 组装【V1-2 接入点：注入严格声明样例 + 机器生成能力清单】→
  外部 AI 回答 → extractAutoIterDecl(prompt+answer) → assessAutoIterDecl【V1-2 新增：半状态判定】→
  writeStepState（iterations/finalAcceptance/autoDecision + 新增 autoIterDeclAudit）→
  【V1-1 接入点②】auditBreakthrough 并把 incrementalStreak 落盘（现状 /ask 完全不审计 → 绕过门禁）→ 响应体透出审计字段（不阻断）

0.3 影响面
- 改动文件：lib/breakthrough-gate.js、lib/index.js、test/breakthrough-gate.test.js（V1-1）；lib/autoiter-decl.js、test/autoiter-decl.test.js（V1-2）
- 受影响但不改：审核侧 buildReviewPrompt/caseBlock 注入、Swarm 分支、/steps/auto-review 降级链
- 回归风险点：writeStepState 新增字段（须保持既有字段语义不变）；restructure 400 分支不得影响 approved 历史与悬空依赖既有 400
- 交付纪律：三副本同步（lesson L-2026-0909-040）+ 宿主 request-restart 后新代码才生效

0.4 突破度状态机（V1-1 的核心）
- 版本级判定：任一步 structural/paradigm → breakthrough（streak 归零）；否则任一步 incremental → incremental（streak+1）；全 unknown/null → 不计不重置
- 【实测缺陷】权威计划 7 步 breakthrough_type 全为 null → 恒不进 incremental 分支 → streak 永远为 0 → 门禁在任何阈值下都不会触发
- 【V1-1 新增状态】全未声明 → gate-needs-declaration（默认拦截；DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED=1 时放行，verdict=gate-passed-undeclared-allowed）
- 阈值状态：consecutiveIncremental >= MAX（env DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL，默认 3）→ gate-blocked，requiredType=structural

0.5 接口契约
- evaluateBreakthroughPlan({ steps, history }) → { gatePassed, consecutiveIncremental, verdict, requiredType, reasons[] }（纯函数，可注入历史）
- restructure 拒绝：HTTP 400 + { ok:false, error:'breakthrough-gate', gatePassed:false, requiredType, consecutiveIncremental, reasons }
- restructure 通过：响应体附 breakthrough:{ gatePassed, consecutiveIncremental, verdict }
- /ask：不阻断，响应体附 breakthrough:{ gatePassed, verdict, consecutiveIncremental, reasons }；半状态另附 autoIterDecl:{ complete, halfState, reasons, hint }
- 既有导出保持不变：breakthroughTypeOf / versionTypeOf / auditBreakthrough（warn at streak>=2，非阻断）

0.6 V1 改动点（精确到行为）
- V1-1：新增 evaluateBreakthroughPlan（复用既有类型判定）；restructure 接入阻断；/ask 接入审计落盘（堵绕过）；用例 5→≥13
- V1-2：新增 assessAutoIterDecl 半状态判定；/ask 响应 + steps.json 可见化；/ask payload 注入严格声明样例与机器生成能力清单；用例 ≥5

0.7 重构候选（本版只做必要隔离，不做大重构）
- 突破度判定必须单点：/ask 与 restructure 都调用同一 evaluateBreakthroughPlan/auditBreakthrough，禁止各写一套判定（否则又是漂移源）
- 能力清单生成器（V1-2 引入）应导出为可复用函数，供 V2-1 的规划侧注入直接调用，避免重复实现

【V1 审计基线（行号证据）】
- lib/breakthrough-gate.js 43 行，3 个既有导出；warn 仅 streak>=2 且非阻断
- lib/index.js：L2620 解析路径 auditBreakthrough(steps, 0)（prevStreak=0 → warn 永不触发）；L2256-2270 /ask 路径无审计；L4080-4082 restructure 侧 warn 非阻断；L3606 版间门不读突破度
- lib/autoiter-decl.js：严格 JSON 块优先（L11-22），叙述式兜底（L24-31）
- 实测：expr-2026-09-13_17-36-07.steps.json → iterations=3、autoDecision=false、finalAcceptance=null、7 步 breakthrough_type 全 null
`;
fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'));
console.log('  文件现有字节 =', fs.statSync(trace).size);
