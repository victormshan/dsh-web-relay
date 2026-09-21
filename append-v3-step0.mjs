// 追加 V3 Step 0 建模 + V3-2 终验证据清单（node 写 UTF-8）
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now}

【主 agent V3 Step 0 建模（V3 = 计划第 6/7 步；对齐 auto-iteration-modeling §3/§5）】

0.1 功能树（V3 触及的子系统）
- 文档层：docs/CC-HYBRID.md（协议/降级链/环境开关）、docs/COMPATIBILITY.md（版本锚点）、README.md、docs/capabilities/registry.yaml
- 引擎事实源：lib/*.js（webServer.register 路由、process.env.DSH_* 开关）、lib/*.mjs、package.json（version / files）
- 校验脚本层：scripts/verify-capabilities.mjs（registry 存在性与内容）、scripts/verify-lessons.mjs、scripts/verify-files-coverage.mjs
- 收口层：/steps/finalize、trace、chain-state、cc 通道四项可靠性证据（目标 (1) 收口证据包）

0.2 V3 两条真实流程
流程 A（V3-1 漂移校验）：node scripts/sync-engine-docs.mjs --check → collectEngineFacts(读 lib/*.js、package.json)
  → diffFacts(facts, docs) → 三类差异（routes / envSwitches / versionAnchors）→ 无漂移 exit 0，有漂移 exit≠0 并输出清单（--json 机器可读）
流程 B（V3-2 终验）：全量测试 + V1/V2 各步 approved + 版间门记录 + finalAcceptance 逐条核对 → 收口（/steps/finalize）→ trace 归档

0.3 影响面
- 新增：[NEW] scripts/sync-engine-docs.mjs、[NEW] test/sync-engine-docs.test.js
- 改动：docs/CC-HYBRID.md（仅补既有事实、不得虚构能力）、package.json（files 数组加入新脚本路径；**不得**加 scripts 字段）
- 回归风险：脚本只读校验，不修改文档；package.json 只动 files，不动其它字段
- 交付纪律：新脚本必须在 package files 覆盖内（verify-files-coverage 会查）

0.4 状态机
- 漂移校验：ok（三类均命中）｜drift（missing-in-doc）｜stale-doc（文档写了但代码无）｜diagnostic（某类零命中 → warning 而非静默通过）
- 终验：pending → 各步 approved → 版间门放行 → finalize 收口（finalized=true）；任一条不满足即不得收口

0.5 接口契约
- 脚本用法：node scripts/sync-engine-docs.mjs [--check（默认）] [--json] [--root <dir>]
- 退出码：0=无漂移；非 0=有漂移（--json 时同时输出机器可读结构 { routes, envSwitches, versionAnchors } 各自 ok 与差异数组）
- 纯函数：collectEngineFacts({ readFile, root }) 与 diffFacts(facts, docs)；CLI 只做 IO 与退出码（便于夹具测试）
- 版本锚点匹配规则：以文档实际格式为准（如 4.9.x 锚点），须在报告中写明所用规则，不得放宽到「出现版本号即算通过」

0.6 改动点（精确到行为）
- V3-1：三类机器事实收集与比对；漂移清单输出；夹具测试 ≥4 例（无漂移通过 / 路由缺失 / 开关缺失 / 版本锚点不一致 / 加分：stale-doc）；
  用真实仓库跑一次 --check 并把**真实漂移清单**贴进报告；属「文档漏记既有事实」的可补齐（只补事实），补完再跑一次给零漂移输出
- V3-2：全量回归 + 三版终验（见下）

0.7 重构候选
- 校验器同样受「校验器须自检」约束（lesson L-2026-0915-066）：新脚本必须先在夹具上证明能报出已知漂移，再对真实仓库下结论

【V3-2 终验证据清单（主 agent 收口时必须逐条给出，机械可核）】
① 全量测试：node --test（显式文件清单，**不要**用 test/ 目录式调用）100% 通过；基线口径：全量 ≥473 例、*.test.js 子集 ≥333 例
② 步骤状态：计划 7 步中 1/2/4/5/6 为 approved（3、7 为主 agent 收口步），且每步 notes 含 complete 证据与 approved 裁决
③ 版间门：V1 两步 approved 后给出进入 V2 的判定记录；V2 两步 approved 后同法进入 V3；若曾触发 blocked-needs-breakthrough，须记录当时 requiredType 与后续补齐方式
④ finalAcceptance：非空且逐条有对应证据（由 declare-autoiter.mjs 在 V1-2 落地后声明；若仍未声明，终验不得通过）
⑤ cc 通道四项可靠性（目标 (1)）：守护常驻自愈（linger + Restart=always + kill 实测 NRestarts）、派发前探活（fail-open + 专用心跳）、
   端到端可验证（verify-cc-task 五项 + V1/V2/V3 各步 ACCEPT 记录）、失败分类与降级可审计（runner errorCode + classifyCcFailure + cc-stats 桶 + /health-check 字段）
⑥ 文档一致性：node scripts/sync-engine-docs.mjs --check 零漂移或漂移清单已澄清留档
⑦ 轨迹完整性：V1/V2/V3 三版 Step 0、派发/验收/收口记录、教训条目（含本会话新增 060–066）齐备
【提交纪律】终验通过后按 /steps/finalize 收口（面板动作由用户/主 agent 触发），并把三版结论追加 trace。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
