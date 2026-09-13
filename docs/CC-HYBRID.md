# dsh-web-relay · Claude Code 混合架构与降级策略（CC-HYBRID）

> POC 状态：POC-1 冒烟 ✅（Claude Code 2.1.251，Pro 订阅 firstParty，headless -p 可用）
> POC-2 实现链路 ✅（cc-task-schema 模块由 Claude 实现，主 agent 校验合入 commit 4d24565，全量 179/179）
> POC-3 审方链路 ✅（Claude 评审发现并确认高严重度缺陷：TASK_DEFAULTS.refs 共享引用污染——主 agent+10 单测均漏检；修复 commit 0884b90）
> POC-④ 大模块实现 ✅（verify-lessons.mjs 校验器 6.7KB+9 单测，Claude 实现主 agent 合入；含 WSL 路径/BOM 跨环境修复）
> 守护化 ✅（cc-watchdog.sh 常驻轮询 D:\cc-tasks\queue → tasks/；runner 失败检测写 result.json failed → 降级信号）
> 安全演练 ✅（demo1 矛盾 prompt 被 Claude 拒绝执行——判定疑似注入不写沙盒外文件 → 失败检测+降级链在"安全拒绝"场景同样生效）
> v4.9 协议化 ✅（v2.0：claude-code 正式进入协议级审核降级链 external→web-gemini→claude-code→dialog→manual；lib/cc-channel.js 客户端 + reviewChannel=claude-code 强制通道；batch 受控并发；全量 218/218）

## 1. 架构

```
harness 主 agent (deepseek-v4-flash) —— 主协调：任务定义/校验/合入/收口/状态机
        │ 写任务契约
        ▼
D:\cc-tasks\<taskId>\task.json   ← WSL 经 /mnt/d 直读（零网络配置）
        │ runner.sh（WSL）: timeout 900 claude -p --permission-mode acceptEdits --allowedTools Read,Write,Bash
        ▼
Claude Code (WSL, Pro 订阅)  → 产出 out/ + done.flag → result.json {status:done|failed}
        │ 主 agent 读回
        ▼
校验（node --check/test/验收）→ 合入 repo → 三方/混合闭环
```

kind 支持（语义澄清，cc-understand-hybrid 复盘 2026-09-06 修订）：
- implement（大块实现）
- review（评审，输出 review.md 结论 APPROVED/REJECTED + 逐条意见）
- understand（理解自述/架构探路型——如"通知 Claude 关于混合架构并请其自述理解"，输出 understanding.md；消除借用 review 的语义债）

**权限界限（裁决修订）**：`--permission-mode acceptEdits` **仅**=自动接受文件编辑/改动；**不等于**免批命令行工具。命令执行放宽依赖 `--allowedTools "Read,Write,Bash"`（headless 会话 Bash 放行）。两者权责分离——禁止将 acceptEdits 解读为"免批命令"（防不安全假设）。runner 唤起语已收敛为最小引导（仅指向 task.json），避免与契约内 prompt 职责重叠。

## 2. 降级策略（混合架构失败 → 主 agent 单一实现架构）

触发条件（任一）：
1. runner result.json status=failed（claude exit≠0 / timeout 900s / done.flag 缺失）
2. claude 不可达 / 认证失效（订阅登出） / Pro 自动化配额 429
3. 产出校验不通过（node --check/test/验收失败）且无法在 1 轮内修复
4. WSL 或 /mnt/d 不可用

降级动作（主 agent 决策，逐级回退）：
- kind=review：回退到原三方审方链（gemini-free → dialog → manual），trace 记 fallbackReason=cc-unavailable:<原因>
- kind=implement：主 agent 自行实现该任务（单一实现架构），trace 记 fallbackReason=cc-unavailable:<原因> + degraded=true
- 恢复检测：每次派发前探活（wsl claude auth status）；恢复后自动回到混合模式（不做 sticky 降级）

规则固化为 lesson 候选：cc 不可用时的 trace 字段（fallbackReason/degraded）与 expr 收口语义一致，不破坏验收证据链。

## 3. 经验与风控
- Pro 订阅自动化配额有限：任务拆分 ≤ 数十分钟/个，连续派发留窗口；大实现优先，日常审方仍可用 gemini（省配额）。
- ToS：仅本机个人研究，禁止商业化代理。
- 审方价值实证：POC-3 Claude 审出 refs 共享引用污染（真实运行时缺陷，跨调用状态泄漏），证明高质审方可补主 agent+单测盲区。

## 4. 混合架构特性演进验收协议（Understand-Hybrid Protocol v1.0，外部 AI 定稿 2026-09-06 expr-16-27-44）

### §1 触发时机
- 强制：混合架构重大特性落地（拓扑/runner 调度变更）；核心契约或 API 语义修订（kind 语义、acceptEdits 行为、任务状态机）。
- 可选/跳过：样式修饰、措辞微调、无语义 Bug 修复（走常规 Step 审核）。

### §2 流程五步法（责任与配额）
1. 派发（主 agent）：D:\cc-tasks 发 kind=understand 任务，明确机制边界与重点核查项。
2. Claude 自述：按文档自述理解；未经查证的推理**必须标 [推测]**，禁硬猜。限额单次交互，超时 120s 视为失败→降级文档硬核对（Pro 配额保护）。
3. 偏差分析（主 agent）：逐节核对表 + git/代码交叉验证 + 危害判定。
4. 外部 AI 裁决：审偏差报告，仲裁=改文档/忽略/吸收为机制缺口。
5. 落地闭环（主 agent）：按裁决修订 + 新语义误区沉淀。

### §3 偏差判定与出口
- 高危（颠覆性误解/越界/死锁）→ **阻断发布**，修文档/提示词重测至通过。
- 中危（非主干误读）→ 外部 AI 裁决本轮修或记为已知限制。
- 低危（措辞/合理推测）→ 记录并忽略。
- Gap 去向：语义债→本轮改文档；机制缺口→登记下轮 v4.x 候选；流程瑕疵→优化 cc-tasks 契约模板。

### §4 与三方链/Lessons 衔接
- 理解测试 = 重大特性交付前**阶段门禁**：通过 + 外部 AI 裁决收口后，相关 Step List 才允许最终 Complete/Approved。
- 高频误读/隐晦语义（kind 借用、acceptEdits 误读）强制入库（CC-HYBRID 误区节或 lessons），防重复踩坑。

### §5 归档与登记
- 本协议即 CC-HYBRID §4（Active v1.0）；registry cc-hybrid-claude-code 条目 verification 含本协议关键词。
- 验证入口：node scripts/verify-capabilities.mjs（cc-hybrid-claude-code 条目含「混合架构特性演进验收协议」content 校验）。

## 6. v4.9 协议化（协议 v2.0，2026-09-07 expr-16-32-52）

混合架构由「主 agent 手动派发」升级为**协议级能力**（外部 AI 排位 C→A→B→D）：

- **lib/cc-channel.js**（Claude Code kind=implement 实现，主 agent 校验合入）：cc-tasks 审核通道客户端——buildReviewTask/parseCcVerdict/pollTaskResult/readReviewOut/ccChannelAvailable/sanitizeTaskId/nodeFsImpl，全部 IO 走可注入 fsImpl（21 单测内存 fake，不碰真实盘）。
- **审核降级链 v2.0**（lib/index.js reviewOneStep 拆层 obtainReviewVerdict / applyReviewOutcome）：
  `external(Gemini API) → web-gemini → claude-code（本地，D:\cc-tasks）→ dialog → manual`。
  `reviewChannel=claude-code` 强制首选 cc；cc 失败自动续降 dialog。cc 降级成功标注 `providerLabel/reviewedBy=claude-code`、轨迹 reviewerLabel「Claude-Code (降级)」。
- **alternatives 裁决管道**（lib/alternatives-compare.js + POST /steps/alternatives-review）：6 段模板逐方案打分择优 → `step.decision` + notes(action=decision) + 轨迹。
- **batchStepIds 受控并发**：预检（串行）→ `mapLimit`（默认并发 2，env DSH_RELAY_BATCH_CONCURRENCY）并发取结论（不落盘）→ 串行 apply / 原子打回统一落盘——无 state 文件写盘竞态；callGemini 429/5xx 退避（1.5s/3s×2）。
- 环境开关：`DSH_CC_REVIEW_ENABLED=0` 关闭 cc 通道；`DSH_CC_TASKS_ROOT` 覆盖目录。
- 轮询上限（可靠性加固，2026-09）：优先级 显式 timeoutMs（调用方传入）> `DSH_CC_REVIEW_TIMEOUT_MS`（env 覆盖，任意 kind 通吃）> 按 kind 默认档位（`lib/cc-channel.js` `DEFAULT_TIMEOUT_BY_KIND`：`review`=150000ms 不变；`implement`/`understand`=960000ms，对齐 runner.sh `timeout 900` 硬上限并留 60s 余量——此前三类 kind 共用硬编码 150000ms，导致本节所述"4-8 分钟固定开销"的任务在正常执行中即被 relay 误判超时降级）。
- 超时语义可区分：`pollTaskResult` 超时返回 `reason='timeout-still-running'`（任务可能仍在执行，只是超出 relay 侧轮询上限，非任务失败），真失败返回 `reason='failed'`（`errorCode`/`errorText` 沿用 result.json 解析）；两者在 `lib/cc-stats.mjs` 的 `byFailure` 中分属不同分类，供 `/health-check` 审计区分。
- 派发前 watchdog liveness 探针：`ccWatchdogAlive`（`lib/cc-channel.js`）在派发前校验 `queue/`、`tasks/` 结构存在且 `watchdog.log`（或 `cc-stats.json`）心跳新鲜（阈值 `DSH_CC_WATCHDOG_STALE_MS`，默认 120000ms）；不新鲜时直接降级并记 `fallbackReason` 含 `cc-watchdog-stale:<ageMs>`，不再白等整个轮询超时。
- 注册表：registry.yaml 新增 protocol-v2-evolution 条目；cc-hybrid-claude-code 条目 verification 增 lib/cc-channel.js。

## 7. 默认化判定规则（2026-09-10 架构征询落地 P0-1）

> 结论来源：外部 AI（web-gemini）与 Claude Code 双方**独立**征询（cc 任务 `hybrid-default-advisory`），
> 均判 **conditional**——三方协作机制适合默认，但**混合架构（cc 派发）应条件默认**
> （cc 有 4-8 分钟固定开销与硬边界：900s 总超时、无 `--resume`、白名单三工具、无 GUI、Pro 配额）。
> 判定逻辑固化为纯函数 `lib/triage-route.js`（16 单测），可经 `POST /dsh-web-relay/route/decide` 调用。

### 7.1 默认启用混合架构（cc 派发）
- 代码实现类且涉及文件 ≥3（跨模块改动）
- 静态代码诊断 / 架构核查（kind=understand）——cc 可读全仓并给出 file:line 依据
- 代码级评审（kind=review）——实证价值：POC-3 审出主 agent 与既有单测均漏检的 `refs` 共享引用污染
- AutoIteration 多版本演进（iterations>1）内的实现/理解步
- 多方案裁决（alternatives>1）——需要独立第三方视角

### 7.2 默认不启用（硬边界，任何情况都不派 cc）
| 边界 | 原因 |
|---|---|
| 需要 GUI/浏览器/真实页面交互 | cc 无 GUI 能力（如 web-gemini 桥接调试）——由主 agent 做端到端探活验证 |
| 需要跨会话状态收敛 | cc 每次全新进程、无 `--resume`、无模型记忆继承（记忆只在磁盘产物） |
| 需要主 agent 专属工具 | cc 白名单仅 `Read,Write,Bash`（无 Glob/Grep/Web/subagent 并发） |
| 预估 >900s | runner.sh `timeout 900` 硬上限——应由主 agent 先拆分为多个 task.json |

### 7.3 默认不启用（豁免：固定开销不划算）
- 涉及文件 ≤1 的局部小改
- 纯配置/环境探路（kind=config/probe）——主 agent 本地极速完成

### 7.4 调用示例
```sh
curl -X POST http://127.0.0.1:3080/dsh-web-relay/route/decide -H 'content-type: application/json' \
  -d '{"kind":"understand","changedFiles":5,"iterations":6}'
# → {"ok":true,"useHybrid":true,"confidence":"high","reasons":[...],"blockers":[],"summary":"route=hybrid(cc) ..."}
```

## 8. cc 产物与路径硬校验（P0-2 审计结论：已实现，无需重造）

架构征询的 P0-2 项（"cc 产物合入前置检查器 / 路径错误立即拒绝进入 review"）**已由既有四重校验覆盖**：

| 门控位置 | 实现 | 证据 |
|---|---|---|
| 宿主派发前置 | `validateTask(task)` 不合格拒绝派发（防畸形入队） | `lib/index.js:2997-2999` |
| 宿主 poll 后 | `validateResult`（done.flag 根 / result.json / review.md）不合格不进 approved；**异常已收紧为显式失败**（两态不变式，2026-09-10） | `lib/index.js:3013-3022` |
| cc-watchdog 侧 | dispatch 前 `validate-task` 门控，非法任务隔离 `queue/.invalid/` 不派发 | `cc-watchdog.sh:25-26` |
| runner 完成侧 | `validate-result` 门控，不合格覆写 `failed`（`errorCode: v2-validate-failed`，坏结果不逃逸） | `runner.sh:38-41` |

**差异说明**：现状为返回 `{ok:false, error}`（而非抛出 ContractError 异常）——语义等价（不进入 review、自动走降级链），且更契合五级降级链的错误传递设计。

**修复后实测（2026-09-10）**：`enableSwarm=false + reviewChannel=claude-code` → `reviewedBy=claude-code`，90s 完成审核（任务 `rev-1a08b460fc2`）；此前因 outputDir 绝对路径契约 bug，13 例 cc 审核任务全被门控 REJECT（成功率 0%），该 bug 已由 s2v5_3 修复。

## 9. 默认化配套治理能力（2026-09-10 架构征询落地 P1-1/P2-1）

### 9.1 审核降级率审计（P1-1）
- `lib/review-audit.js`：`auditReviewSources(steps)` 统计审核来源分布，dialog 兜底占比超阈值（默认 0.3）即标记告警；三级判定 **ok / warn / risk**（risk = 超阈值且外部通道成功 0 步）。
- 接入 finalize 收口汇总（`summarizeReviewSources`）：超阈值自动追加告警段，写入 `finalSummary` 与三方轨迹；汇总分组新增 claude-code 行。
- 实证依据：AutoIteration 6 版迭代 dialog 13/23 ≈ 57% 超阈值——此前收口只有分组清单无比例告警，"外部通道连续不可用 → 静默降级内部模型"难以察觉。
- 阈值可覆盖：`auditReviewSources(steps, { dialogRatioWarn })`；最小样本 3 步防噪声。

### 9.2 importance=high 双通道交叉校验（P2-1）
- `lib/cross-check.js`：`crossCheckVerdicts(primary, secondary)` 仲裁两条**独立**外部通道的结论：
  - 一致 → `consensus-approved/rejected`（采信，reason 保留双方依据）
  - **冲突**（一 approved 一 rejected）→ `escalate-conflict`：不自动判定，返回 `manual: true` 由前端展开人工裁决框
  - 任一方无结论/无法识别 → `escalate-unusable`（不得由单方结论自动采信）
- 请求级开关：`POST /steps/auto-review` body 增 `enableCrossCheck: true`（配合 `shouldCrossCheck` 门控：仅显式开启且 importance=high 生效）。
  - ⚠️ v4.9.4 修复（claude-code 审核 `xc3` 发现）：批量分支（`batchStepIds`）原先只传 6 个参数、**遗漏第 7 参 `enableCrossCheck`**
    → `shouldCrossCheck(step, undefined)` 恒 false → 凡走批量接口的 high 步骤，交叉校验（含"结论冲突升人工"的安全网）**静默失效**，
    而单步分支一直正确（文档承诺"请求级开关"与实现对不上，属静默放行）。现已让两条入口传同一请求级开关，
    并在 `test/cross-check.test.js` 加**源码级接线回归**（括号配对提取每个 `obtainReviewVerdict` / `reviewOneStep` 调用点，
    断言都传该开关且由 `payload.enableCrossCheck === true` 驱动）；反向验证：人为去掉第 7 参时该用例 FAIL（13 pass/1 fail）。
- 通道不可用与结论冲突严格区分：次通道（cc）不可用时**采信主通道并标注"交叉校验未完成"**，避免把"通道故障"误升级为人工。
