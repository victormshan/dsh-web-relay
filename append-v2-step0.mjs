// 追加 V2 Step 0 建模（对齐 auto-iteration-modeling §3/§5；node 写 UTF-8 避免编码污染）
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now}

【主 agent V2 Step 0 建模（V2 = 计划第 4/5 步；对齐 auto-iteration-modeling §3/§5）】

前置：V1 已完成的现状（实测）
- V1-1（已 approved，提交 4d43ea1）：lib/breakthrough-gate.js 新增 evaluateBreakthroughPlan（纯函数）；
  restructure 接入硬门禁；/ask 路径审计并落盘 incrementalStreak（auditBreakthrough 命中 5 处 / incrementalStreak 13 处）。
- V1-2（待落地）：assessAutoIterDecl 半状态判定 + /ask 注入严格声明样例与机器生成能力清单 + /steps/declare 补全入口。
- 当前 expr 仍是半状态：iterations=3 / autoDecision=false / finalAcceptance=null（已备 declare-autoiter.mjs 待端点落地后一条命令补全）。

0.1 功能树（V2 触及的子系统）
- 规划入口层：/ask 的 guidedPrompt 组装（L2086-2096；降级节点 callGemini L2102 / webGeminiAsk L2106,L2117 / callDialogModel L2110,L2121 复用同一 guidedPrompt）
- 反思资产层：web-relay/experiments/prompt-case-library.md（案例库，实存 81 行）＋ docs/main-agent-lessons.json（66 条 lesson）
- 审核注入层：buildReviewPrompt（L719/L736）与 cc 审核任务（L3159）已注入 caseBlock
- 版间门层：/steps/update 的 status=done 分支（L3603-3634）
- 门禁层：lib/breakthrough-gate.js（V1-1 后含 evaluateBreakthroughPlan）
- 持久化层：writeStepState 白名单（L1577-1621）、trace、chain-state

0.2 两条真实调用流程（标注 V2 接入点）
流程 A（规划路径，V2-1 接入）：用户 prompt → POST /ask → 【V2-1 接入点】guidedPrompt 注入三段反思
  （案例 Top-K：selectTopCases(query=prompt)；教训 Top-K：topLessonsForTrigger+renderLessonBlock；能力清单：复用 V1-2 生成的机器清单）
  → callGemini/webGeminiAsk/callDialogModel → 外部 AI 回答 → extractAutoIterDecl → assessAutoIterDecl（V1-2）→ writeStepState → 唤醒主 agent
流程 B（版间门路径，V2-2 接入）：/steps/update status=done 分支 → 现仅判 iterations/currentIteration（L3606）
  → 【V2-2 接入点】evaluateVersionAdvance({steps, state, max}) → advance=false 时**不推进** currentIteration，
     改写 handoffText（要求下一版含 structural/paradigm）+ 落盘 breakthroughBlocked 审计字段 + appendTrace → 否则维持原推进逻辑

0.3 影响面
- 改动文件：lib/index.js、lib/lessons-inject.js（V2-1）；lib/breakthrough-gate.js、lib/index.js（V2-2）
- 新增文件：[NEW] lib/case-library.js、[NEW] test/case-library.test.js（V2-1）
- 受影响但不改：审核侧注入、Swarm 分支、/steps/auto-review 降级链
- 回归风险：writeStepState 新增 breakthroughBlocked 字段须保持既有字段语义；版间门 advance=true 路径行为必须零变化
- 交付纪律：三副本同步 + 宿主 request-restart 才在运行中生效（链条无需重启）

0.4 版间门状态机（V2-2 核心）
- advance=true：iterations<=1（single-iteration）｜currentIteration 达上限（final-iteration）｜连续 incremental < 阈值
- advance=false（blocked-needs-breakthrough）：连续 incremental >= MAX（DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL，默认 3）
  → 不推进 currentIteration、不置 paused/rejected（那是熔断语义）、要求补突破项后可恢复
- 恢复条件：主 agent 经 restructure 提交含 structural/paradigm 的新版 → versionTypeOf 归零 streak → advance 恢复 true

0.5 接口契约
- lib/case-library.js：parseCaseLibrary(text) → 条目[]；selectTopCases(items, { query, limit=3 }) → 选中[]；
  renderCaseBlock(selected) → 文本块（无命中 → 空串；与既有 buildCaseBlock 渲染格式逐字一致）
- evaluateVersionAdvance({ steps, state, max }) → { advance, verdict: 'advance'|'blocked-needs-breakthrough'|'final-iteration'|'single-iteration',
  consecutiveIncremental, requiredType, reasons[], handoffNote }
- 版间门审计字段：breakthroughBlocked: { at, consecutiveIncremental, requiredType, reasons }
- /ask 注入：三段合计设上限（建议 ≤6000 字符）并按声明优先级裁剪，须给出实测字符数

0.6 V2 改动点（精确到行为）
- V2-1：抽出可测的案例库解析/选择/渲染（行为等价，含既有计分与 Top-K=3）；/ask 注入三段反思（复用既有函数，禁止重写）；
  经验教训注入复用 lib/lessons-inject.js；能力清单复用 V1-2 生成器；测试 ≥6 例
- V2-2：新增 evaluateVersionAdvance 纯函数并接入版间门；advance=false 时不推进 + 审计字段 + trace；测试 ≥5 例

0.7 重构候选（本版只做必要隔离）
- 判定单点：突破度判定只允许 evaluateBreakthroughPlan（V1-1）/ evaluateVersionAdvance（V2-2）两处，禁止再写第三套
- 注入复用：案例/教训/能力清单三段都必须是**可复用函数调用**，不得在 /ask 里复制粘贴渲染逻辑

【V2 交付顺序与门控】V2-1 → V2-2（V2-2 复用 V1-1 的 evaluateBreakthroughPlan，故必须在 V1-1 之后；两者均 review:true/high 或 medium，
由链条依次派发 → 机械验收 → 提交 → 协议收口（独立审核 + min-reviewer=external 强度门）。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
