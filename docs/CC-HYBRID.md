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
- 派发前 watchdog liveness 探针：`ccWatchdogAlive`（`lib/cc-channel.js`）在派发前校验 `queue/`、`tasks/` 结构是否完好；心跳新鲜度（阈值 `DSH_CC_WATCHDOG_STALE_MS`，默认 120000ms）**默认只告警不阻塞**（见 §10 fail-open 修复）。
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

## 10. watchdog 探针 fail-open 修复 + 配额耗尽可审计分类（ccfix-20260914-hb3）

### 10.1 问题：心跳陈旧误判为不可用，整条 cc 通道被瞬间短路
- `watchdog.log` 是**事件驱动**日志——cc-watchdog.sh 只在 startup/dispatch/REJECT 时 echo，轮询循环内长期无任务时不写日志；实测 watchdog 进程健康存活、12 分钟前刚成功派发任务，但 `watchdog.log` 的 mtime 已距今 762697ms（远超 120000ms 默认阈值）。
- 上一版 `ccWatchdogAlive` 把心跳陈旧直接判 `ok:false`（`lib/index.js` 的 `runCcReviewTask` 派发前用该结果做阻塞门），结构完好却被判不可用 → **生产环境每一次 cc 审核派发都会被瞬间短路**，本插件三方协议最依赖的编码通道整体失效。
- 失败方向选择：把"其实活着"误判为"死了" = 通道整体丢失（严重）；把"其实死了"误判为"活着" = 只是多等一次既有的轮询超时（可接受）。**故默认 fail-open**：只有结构性不可用（root/queue/tasks 目录缺失）才阻塞派发，心跳缺失/陈旧一律 `ok:true, stale:true` 告警放行；`DSH_CC_WATCHDOG_STRICT=1` 时才恢复为阻塞（供需要严格模式的场景/测试使用）。

### 10.2 修复实现
- `ccWatchdogAlive`（`lib/cc-channel.js`）：
  - 心跳候选顺序改为 `watchdog.heartbeat`（专用心跳文件，优先）→ `watchdog.log`（事件驱动日志，回退）；**移除 `cc-stats.json`**——它只在成功派发后才更新（数分钟到数天量级粒度），拿它判断"轮询循环是否卡死"噪声太大。
  - 返回结构扩展为 `{ ok, reason, stale, details:{ logAgeMs, queueDepth, tasksCount, heartbeatFile } }`；`ok` 的取值：结构缺失（root-unavailable/queue-dir-missing/tasks-dir-missing）恒 `ok:false`；结构完好时默认 `ok:true`（`stale` 标注是否陈旧/缺失），仅 `DSH_CC_WATCHDOG_STRICT==='1'` 时陈旧才 `ok:false`。
- `lib/index.js` `runCcReviewTask`：派发前只在 `!watchdog.ok`（结构性失败）时短路；`watchdog.stale===true` 时 `console.warn` 打印 `[dsh-web-relay] cc 通道心跳告警: <reason>` 并继续派发，告警通过模块级 `lastCcWatchdogWarning` 挂到 `/health-check` 响应的 `ccWatchdogWarning` 字段（不计入失败，不影响成功率统计）。
- `/mnt/d/cc-tasks/cc-watchdog.sh.new`（新建，未替换运行中的 `cc-watchdog.sh`）：以现有脚本为基础，仅在轮询循环内 `sleep 5` 之前新增一行 `touch /mnt/d/cc-tasks/watchdog.heartbeat`，使心跳按轮询节奏（含队列为空时）持续刷新；`diff -u cc-watchdog.sh cc-watchdog.sh.new` 只有该增量。**换入与重启由主 agent 受控执行**——心跳文件在换入前不存在，默认路径下会走"心跳缺失→`alive-unverified:missing` 告警但不阻塞"，这是刻意的 fail-open 设计，不是遗漏。

### 10.3 配额/限流耗尽可审计分类
- `classifyCcFailure({ result, claudeLogText, now })`（`lib/cc-channel.js`，纯函数）：优先消费 runner.sh 已产出的 `result.json.errorCode`（`cc-quota-exhausted`/`cc-permission-denied`/`cc-timeout`/`cc-failed`/`v2-validate-failed`），缺失时退化为对 `claude.log` 原文做关键词兜底识别（`session limit`/`rate limit`/`quota`/`permissions to write`/`haven't granted`，大小写不敏感）；返回 `{ kind, errorCode, resetsAt, raw }`。
- `parseResetsAt(text, { now })`：从 `resets 5:10am (Asia/Shanghai)` 一类文本中用 `Intl.DateTimeFormat` 做时区无关的挂钟时刻→UTC 换算（不动点迭代，零第三方依赖），解析不出/时区非法返回 `null`，不抛错。
- `shouldSkipForKnownQuotaExhaustion({ quotaState, now })`：纯函数，`quotaState.kind==='quota-exhausted' && now < resetsAt` 时返回 `true`。`lib/index.js` 在 `runCcReviewTask` 派发前读取运行时状态文件 `D:\cc-tasks\cc-quota-state.json`（类比既有 `cc-stats.json` 用法的运行时数据文件，非源码），命中即直接记 `reason='cc-quota-exhausted'` 并跳过派发，不再盲等整个轮询超时；真实失败发生时（`poll.status==='failed'`）用 `classifyCcFailure` 分类并在识别为配额耗尽时写回该状态文件。

### 10.4 已知残余范围限制（未做项，非遗漏）
本任务（ccfix-20260914-hb3）写入范围严格限定为 `lib/cc-channel.js`/`lib/index.js`/`test/cc-channel.test.js`/`docs/CC-HYBRID.md`/`cc-watchdog.sh.new`。任务提示词第 4 部分曾要求同时在 `lib/cc-stats.mjs` 的 `FAILURE_RULES` 新增 `cc-quota-exhausted` 分类（供 `/health-check` 的 `ccStats.byFailure` 单列配额耗尽次数）并在 `test/cc-stats.test.mjs` 补测试，但 `lib/cc-stats.mjs`/`test/cc-stats.test.mjs` 均不在写入范围清单内，与"写入范围外零改动"的硬性验收直接冲突。**本次判断优先遵守写入范围硬约束**：`recordCcStat` 记录的 `reason='cc-quota-exhausted'` 目前会被 `lib/cc-stats.mjs` 现有规则归入 `unknown` 桶，尚不能在 `byFailure` 中单列。后续若要补齐，需要一个显式扩大写入范围到 `lib/cc-stats.mjs` + `test/cc-stats.test.mjs` 的后续任务。

**已在后续任务 ccfix-20260914-stats 补齐**：`lib/cc-stats.mjs` 的 `FAILURE_RULES` 新增 `cc-quota-exhausted`/`cc-permission-denied`/`cc-timeout` 三个分类桶（排在通用 `timeout` 规则之前，命名与 §10.3 `classifyCcFailure` 消费的 `result.json.errorCode` 取值一致），`byFailure` 现可单列「配额耗尽 N 次」「权限被拒 N 次」供 `/health-check` 直接查看。

### 10.5 cc-marker-missing：区分「代码写坏了」与「只是没写完成标记」（ccfix-20260915-markermissing）
- 背景：runner.sh 新增失败分类 `cc-marker-missing`，判据为 claude 退出码 0、未写完成标记 `done.flag`，但确有产出（`out/` 非空或目标仓库工作树有改动）。实测两次该情形（v1-2 提交 `c4b3125`、ccfix-20260915-swarmparse 提交 `947fd3e`）产物均完好、独立验收均 ACCEPT（7/7），却都被记成 `cc-failed`——即该分类下假阴性率此前为 100%。两类动作完全不同：真失败应重试/降级，标记缺失应人工核验产物，不得直接重跑（避免浪费稀缺 cc 额度）。
- `lib/cc-channel.js` `classifyCcFailure`：`errorCode === 'cc-marker-missing'` 时返回 `kind: 'marker-missing'`（`resetsAt: null`）。**该判定必须排在 isCodeFailed 分支之前**——`cc-marker-missing` 的 `result.json` 里 `status` 同样是 `"failed"`，会被 isCodeFailed 分支的兜底条件 `result.status === 'failed'` 先命中，见 `lib/cc-channel.js` 的 `classifyCcFailure` 实现。
- `lib/cc-stats.mjs` `FAILURE_RULES`：新增 `['cc-marker-missing', /cc-marker-missing/i]`，**排在 `runner-failed` 规则之前**——`cc-marker-missing` 的 reason 文本是 `"claude exit=0; done.flag=missing"`，会命中 `runner-failed` 正则里的 `done\.flag\s*(missing|不存在|缺失)` 子模式。
- 不改变既有分类行为：无 `errorCode` 的普通失败、配额/权限/超时/`contract-reject`/`artifact-missing`/`timeout-still-running`/`cc-watchdog-stale` 的既有归类保持不变（见 `test/cc-channel.test.js`/`test/cc-stats.test.mjs` 的反向回归用例）。

## 11. AutoIteration 声明契约完整性（半状态可见化）+ /ask 注入机器生成能力清单（v1-2-autoiter-decl-integrity）

### 11.1 可行性审计结论（第 0 步，动手前先取证）
上一版 V1-2 规格声称「/ask 路径缺 autoDecision 落盘」，实测已被证伪，本次改动前先核实四项现状（均已在代码中确认，详见 `out/report.md` 的「现状取证」一节）：
- `extractAutoIterDecl`/`autoDecision` 在 `lib/index.js` 已多处命中（`askHandler`/`executeHandler` 均调用并落盘）；
- `writeStepState` 的写白名单**已含** `iterations`/`finalAcceptance`/`autoDecision`（`lib/index.js` 写白名单，v1.9 起）；
- 全仓**不存在**「iterations>1 但 autoDecision=false」的告警/校验逻辑（真实缺口，本任务补齐）；
- `/ask` payload 组装处**不存在**能力清单或声明样例注入（真实缺口，本任务补齐）。
凡已实现的能力本任务不重写，只补齐后两项真实缺口。

### 11.2 真实缺口：叙述式声明产生半状态，且此前无任何可见化
`expr-2026-09-13_17-36-07` 实测：外部 AI 在正文写「系统设定自动演化代号为 AutoIteration（`iterations: 3`）」（叙述式，非协议要求的严格 JSON 块），`extractAutoIterDecl` 的宽松兜底只抓到 `iterations=3`，`autoDecision`/`finalAcceptance` 落成 `false`/`null`，7 步全部 `pending`。后果：版间门认为共 3 版，但每版仍需人工审核——与「人工缺席下的自动演化」矛盾，且此前无任何告警。协议依据（不改）：`docs/main-agent-lessons.json` L-2026-0903-002——只认严格 JSON 块，叙述式不解析。

### 11.3 修复实现
- `lib/autoiter-decl.js` 新增 4 个纯函数导出（`extractAutoIterDecl` 签名/行为不变）：
  - `assessAutoIterDecl(decl)`：半状态判定。`iterations>1 && autoDecision!==true` → `halfState:true` + 可复制的严格块 `hint`；`iterations<=1` 或 `autoDecision===true` → 非半状态；入参畸形（null/非对象/字段类型错）→ `{complete:false, halfState:false, reasons:['invalid-decl'], hint:null}`，不抛错。
  - `renderStrictDeclExample()`：严格声明块样例文案（`assessAutoIterDecl` 的 hint 与 `/ask` payload 注入共用同一份文案，单一事实来源）。
  - `generateCapabilitiesList({ repoRoot, fsImpl, maxLen })`：机器生成能力清单——扫描 `lib/*.js` 的 `export` 名 + 解析 `docs/capabilities/registry.yaml` 条目（过滤 `status: deprecated`），≤2000 字符、稳定顺序输出；`fsImpl` 可注入（测试用 fake fs），registry 缺失/异常时优雅退化为仅 lib 导出部分或空字符串，不抛错。禁止手写硬编码清单（lesson L-2026-0914-060：外部 AI 看不到仓库时最易重造/漂移已上线能力）。
  - `computeAutoIterDeclareUpdate(currentDecl, patch)`：受控声明补全的纯计算核心（校验 + 差值 + 留痕文案），不做任何 IO；`iterations` 必须 1-10 整数、`finalAcceptance` 必须非空字符串，非法时返回 `{ok:false, error}` 且不产出 `after`；**未携带 `autoDecision` 时保留既有值**（不回退已有的 `true`）。
- `lib/index.js`：
  - 新增只读缓存 `AUTO_ITER_STRICT_DECL_BLOCK`/`AUTO_ITER_CAPABILITIES_LIST`（复用既有 `REPO_ROOT`/`rel()` 范式解析路径，不依赖 `process.cwd()`，`apply()` 装配一次）；`askHandler` 内 `provider=gemini-free`（guidedPrompt 被 `callGemini`/`webGeminiAsk`/`callDialogModel` 三个降级节点复用）与 `provider=web-gemini`（独立 guidedPrompt）两处 guidedPrompt 组装均注入这两段机器生成内容，覆盖 external→web-gemini→dialog 整条降级链。
  - `askHandler` 落 stepState 时用 `assessAutoIterDecl` 判定半状态：`halfState` 时 `console.warn`，并把判定写入响应体 `autoIterDecl` 字段与该 expr 的 `steps.json` 新增字段 `autoIterDeclAudit`（`readStepState`/`writeStepState` 白名单同步扩展）；不改变既有 `iterations`/`autoDecision`/`finalAcceptance` 取值规则，不让 `/ask` 因声明问题报错或中断。
  - 新增 `POST /dsh-web-relay/steps/declare`（受控声明补全入口）：body `{ workspacePath, exprId, iterations?, finalAcceptance?, autoDecision?, reason?, role? }`；内部调用 `computeAutoIterDeclareUpdate` 做校验/差值计算，落盘后 `appendTrace` 记录「iterations X→Y，autoDecision X→Y，finalAcceptance X→Y；理由：...」，响应体契约 `{ ok:true, stepState, autoIterDecl }`（字段名不得改名，供主 agent 侧工具解析回显）；只改声明状态，不触发任何执行（不 `wakeMainAgent`，不动 `steps`/`status`）。

### 11.4 测试
`test/autoiter-decl.test.js` 新增 14 个用例（既有 8 个不变，全量 22 个全绿）：`assessAutoIterDecl` 半状态/非半状态/畸形入参（4 例）、严格块优先（真实模块，1 例）、`generateCapabilitiesList` 正常/registry 缺失退化/全不可读退化（3 例，均用注入 fake fs，不读写真实工作区外路径）、`computeAutoIterDeclareUpdate` 合法生效/非法拒绝/`autoDecision` 不回退（3 例）、`lib/index.js` 接线的 source 标记回归（3 例，防止「只进文档没进外呼 payload」或路由/白名单静默漂移）。

### 11.5 已知残余范围限制（未做项，非遗漏）
本任务写入范围严格限定为 `lib/autoiter-decl.js`/`lib/index.js`/`test/autoiter-decl.test.js`/`docs/CC-HYBRID.md`。`generateCapabilitiesList` 对 `registry.yaml` 采用轻量正则逐行解析（非通用 YAML 解析器，仓库无 `js-yaml` 依赖且写入范围不含 `package.json`），仅覆盖现有 `- id: / name: / status:` 的扁平列表结构；若未来 `registry.yaml` 引入嵌套/多行字符串等更复杂结构，需要升级为真正的 YAML 解析（届时需扩大写入范围到 `package.json`）。`/steps/declare` 未额外要求 `steps` 必须已存在（允许在尚无 Step List 时先行声明补全），与 `/steps/update` 的「no steps found」校验不同，属有意为之而非遗漏。

### 11.6 修复：`autoIterDeclAudit` 从未落盘（先写盘、后计算）（ccfix-20260915-autoiteraudit）
`stepsDeclareHandler` 读写白名单（11.3 所述）都已打通，但字段从未被赋值：原代码先 `writeStepState(base, exprId, { ...state, ...plan.after }, safePolicy)` 落盘（spread 的是 `readStepState` 读出来的旧 `autoIterDeclAudit`，恒为 `null` 或旧值），再 `assessAutoIterDecl(plan.after)` 算判定，但判定结果只塞进了响应体 `autoIterDecl`——权威 `steps.json` 里的 `autoIterDeclAudit` 永远是 `null`，人工缺席下的自动演化声明无法事后审计（响应是一次性的，落盘才可追溯）。对照：`/ask` 路径（11.3）当时是先算后写的，只漏了 `declare` 这一个入口。
- 修复：`lib/autoiter-decl.js` 新增纯函数 `buildAutoIterDeclAudit(decl, source, at = new Date().toISOString())` —— `declare`/`ask` 两个入口唯一共用的构造点，返回 `{ at, source, decl:{iterations,autoDecision,finalAcceptance}, verdict:assessAutoIterDecl(decl) }`（`verdict` 字段名照抄 `assessAutoIterDecl` 真实返回：`complete`/`halfState`/`reasons`/`hint`）。
- `lib/index.js` `stepsDeclareHandler`：把 `buildAutoIterDeclAudit(plan.after, 'declare')` 的计算移到 `writeStepState` **之前**，结果作为 `autoIterDeclAudit` 一并传入待写状态；响应体 `autoIterDecl` 改用 `autoIterDeclAudit.verdict`（`{ok:true, stepState, autoIterDecl}` 契约字段名不变）。
- `/ask` 路径同步改为 `buildAutoIterDeclAudit({iterations,autoDecision,finalAcceptance}, 'ask')`（此前是直接把 `assessAutoIterDecl` 的裸判定塞进 `autoIterDeclAudit`，缺 `at`/`source`/`decl` 快照），与 `declare` 入口结构对齐；响应体 `autoIterDecl` 字段不变（仍是裸判定，不破坏既有消费方）。
- 未声明/`plan.ok===false` 时依旧在计算审计字段之前就短路 400 返回，不落盘、不产出字段；`readStepState`/`writeStepState` 默认值仍是 `data.autoIterDeclAudit || null` / `state.autoIterDeclAudit || null`，未评估语义不变。
- 测试：`test/autoiter-decl.test.js` 新增 5 例（`buildAutoIterDeclAudit` 结构完整/半状态/source 透传各 1 例 + 接线顺序回归 1 例 + 非法声明不伪造审计对象 1 例），既有用例改动仅 1 处字面量同步（`autoIterDeclAudit: askAutoIterDecl` → `autoIterDeclAudit: askAutoIterDeclAudit`），全量 27 例全绿。

## 12. 规划侧反思注入（案例 Top-K + 教训 Top-K + 能力清单）+ 案例库模块化（v2-1-planning-reflection）

### 12.1 可行性审计结论（第 0 步，动手前先取证）
- `caseBlock` 命中：改动前只出现在审核侧（`buildReviewPrompt`/`runCcReviewTask`/swarm 审核任务），`/ask` 路径完全没有。
- `lessonBlock`/`lessons-inject` 命中：改动前只出现在主 agent 唤醒装配 `attachMainAgentAssembly`（约行 1726），`/ask` 路径完全没有。
- `/ask` 处理器（`askHandler`）三个走外部 AI 的分支（`gemini-free`/`web-gemini`/`claude`）组装的 `guidedPrompt`：改动前只有 `gemini-free`/`web-gemini` 内联注入了「能力清单」（`AUTO_ITER_CAPABILITIES_LIST`，v1-2 已实现），`claude` 分支完全没有；三个分支均**没有**案例/教训注入（真实缺口，本任务补齐）。
- 改动前 `test/` 下无任何 `case*.test.js`，案例库解析/选择逻辑测试覆盖为 0（真实缺口）。
- `readCaseLibrary`/`buildCaseBlock`（改动前位于 `lib/index.js` 约行 645-679）语义：正则解析 6 字段并 `trim`；打分＝词长>2 命中 `reason` +1、`query` 包含 `category`（原样，不小写）+2；`score>0` 才入选，降序，`slice(0,3)`（Top-K 硬上限 3）；无命中/空库返回空串，不留空标题。
凡已实现的能力（能力清单生成器 `generateCapabilitiesList`、`gemini-free`/`web-gemini` 分支的能力清单内联注入、`lessons-inject.js` 的 Top-K 触发匹配、审核侧 `caseBlock`）本任务**不重写**，只补齐「/ask 规划侧缺案例+教训注入」「案例库解析/选择逻辑无独立测试模块」两项真实缺口。

### 12.2 案例库模块化：`lib/case-library.js`
把 `readCaseLibrary`/`buildCaseBlock` 的解析/打分/渲染部分抽成 3 个可测纯函数：`parseCaseLibrary(text)`、`selectTopCases(items, { query, limit })`、`renderCaseBlock(selected)`。正则、打分规则、渲染文案与旧实现逐字段等价（`category` 匹配沿用原样不小写的写法，现网 `category` 均为小写 id，效果等价）；唯一的行为增量是 `parseCaseLibrary` 内部对同 `exprId:stepId` 的条目做去重（后出现者覆盖先出现者）——这一步对现有生产数据是 no-op（`collectRejectedCases` 写入前已做同样的幂等键检查，正常文件不会有重复），只为手工编辑等异常文件提供防御性兜底。`lib/index.js` 的 `readCaseLibrary`/`buildCaseBlock` 改为只保留 IO（工作区路径解析继续走既有 `fs.resolve(EXPERIMENTS_DIR + '/...', { cwd: base })`，不可替换为 `REPO_ROOT`——`prompt-case-library.md` 是工作区状态而非仓库资源，用 `REPO_ROOT` 会静默读空），调用新模块完成解析/打分/渲染。

### 12.3 `/ask` 规划侧反思注入
新增 `buildPlanningReflectionBlock(base, promptText, { includeCapabilities })`（`lib/index.js`，`apply()` 内，紧邻 `attachMainAgentAssembly`）：
- 案例 Top-K：`readCaseLibrary(base)` + `selectTopCases`/`renderCaseBlock`（复用 12.2 的新模块），`query` 传当前 `/ask` 的用户 `prompt`（审核侧仍传 `step.detail + step.acceptance`，两处 `query` 语义由调用方决定，选择函数本身是通用的）。
- 教训 Top-K：复用既有 `lib/lessons-inject.js` 的 `topLessonsForTrigger`/`renderLessonBlock`（与主 agent 唤醒装配同一套生成器，未另写）。
- 能力清单：复用既有 `AUTO_ITER_CAPABILITIES_LIST`（v1-2 已生成，未重写）。`gemini-free`/`web-gemini` 分支此前已各自内联注入过能力清单，为避免重复注入，调用时传 `{ includeCapabilities: false }`，只新增案例+教训两段；`claude` 分支此前完全未注入，使用默认 `includeCapabilities: true` 一次性补齐三段。
- 总长度上限 6000 字符（3 段合计），超限按优先级整段舍弃（不做截断，避免破坏编号/JSON 结构）：教训 Top-K（复发预防、安全相关）＞能力清单（已有 `maxLen=2000` 自身兜底）＞案例 Top-K（具体案例、信息密度相对最低，优先舍弃）。
- 三个分支均把 `base = baseOf(workspacePath)` 前移到 `guidedPrompt` 组装之前（原来只在 `saveRecord` 前才算，`baseOf()` 只依赖 `workspacePath`，前移安全），无命中/空库/空 lessons 时该段直接省略（不留空标题），不影响既有 `guidedPrompt` 结构。

### 12.4 测试
新增 `test/case-library.test.js`，12 个用例（正常解析/字段 trim、畸形条目安全跳过、空输入容错、去重幂等、Top-K 硬上限 3、词命中+category 命中排序、不命中返回空、空输入/空 query 容错、渲染空标题回避、渲染文案含 id/Step/reason 截断、端到端串联），全部纯函数入参，不碰真实 fs/网络。全量回归 `node --test --test-reporter=tap $(ls test/*.test.js test/*.test.mjs)` 496/499 通过，另 3 个失败（`shadow-gate.test.js` 的 `TC-Green`/`TC-GC`/`getGitHead`）与本次改动无关——`git stash` 验证改动前同样失败（本机 WSL 路径与用例硬编码的 `D:/DSH` Windows 路径/仓库 HEAD 期望不匹配的既有环境问题）。

### 12.5 已知残余范围限制（未做项，非遗漏）
- 未将 `collectRejectedCases` 从「仅 finalize 收口」扩展为「单步被打回即时入库」（任务验收②可选项）：现有 finalize 收口已覆盖「曾被 rejected 后 approved」与「仍 rejected」两类（v3.5.0 P1 修复），即时入库需要在 `executeHandler` 打回分支新增写路径，改动面会扩大到本任务写入范围以外的执行链路，且需重新评估幂等键在高并发打回下的竞态，风险高于收益，故不做。
- 未新建第二套案例存储（严格遵循任务边界，继续用 `experiments/prompt-case-library.md` 单一数据源）。
- 未引入新依赖，未改动审核侧 `buildReviewPrompt`/`buildCaseBlock` 既有调用点行为（仅内部实现改为委托新模块，输出字节等价）。

## 13. 版间门×突破度联动：连续 Incremental 阻止进入下一版（v2-2-versiongate-breakthrough）

### 13.1 可行性审计结论（第 0 步，动手前先取证）
- 版间门判定位于 `lib/index.js`（`wakeAfterApproved` 内 `status === 'done'` 分支，v1.9 AutoIteration）：`updated.iterations > 1 && (updated.currentIteration || 1) < updated.iterations` 为真即无条件 `currentIteration += 1` 并落盘、组装唤醒文案；改动前该分支**没有**读取 `incrementalStreak`，即连续 Incremental 版本可无障碍地一路推进到迭代上限。
- `evaluateBreakthroughPlan`（V1-1 产物，`lib/breakthrough-gate.js`）与 `auditBreakthrough`（P3 产物）均已存在且已接入 `restructure` 端点（硬门禁，400 拦截）与 `askHandler`（审计+落盘，非阻断）；本任务复用二者的类型识别能力（`versionTypeOf`），不重写。
- `versionTypeOf` 既有语义：全部 step 的 `breakthrough_type` 均为 `unknown`/`null`（未声明）时返回 `null`——即"不计不重置"，防止把"未声明"误判为"连续 Incremental"。
- `writeStepState`（`lib/index.js`）的写白名单已含 `incrementalStreak`（P3-fix 注释：不落盘则跨 restructure 不累积、门禁永不触发），确认写路径存在，只需补齐新字段。
- `test/breakthrough-gate.test.js` 改动前 20 个用例，覆盖 `breakthroughTypeOf`/`versionTypeOf`/`auditBreakthrough`/`evaluateBreakthroughPlan` 全部既有语义与两条声明可达性回归。

### 13.2 新增纯函数：`evaluateVersionAdvance`（`lib/breakthrough-gate.js`）
签名：`evaluateVersionAdvance({ steps, state, max })` → `{ advance, verdict, consecutiveIncremental, requiredType, reasons, handoffNote }`，`verdict` 取值 `'advance' | 'blocked-needs-breakthrough' | 'final-iteration' | 'single-iteration'`。
- 复用 `versionTypeOf`（既有类型识别，不重复实现）：仅当"当前版本 `steps` 含 structural/paradigm"时把 `consecutiveIncremental` 归零；否则直接沿用调用方传入的 `state.incrementalStreak`——不对同一版本的类型效应二次累加（该效应已在版本创建/`restructure` 时由 `auditBreakthrough`/`evaluateBreakthroughPlan` 计入并落盘，版间门决策时再次相加会造成同一版本重复计数）。
- `max` 优先取显式入参；调用方（`lib/index.js`）负责读取 `DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL`（默认 3）后传入——函数体内不读环境变量、不做 IO、不调用 `Date`，历史 streak 通过 `state.incrementalStreak` 注入，全部可测。
- 优先级：`iterations<=1` → `single-iteration`；`currentIteration>=iterations` → `final-iteration`（均 `advance=true`，保持既有收口/单版行为不变）；否则按连增数与 `max` 比较，超限返回 `blocked-needs-breakthrough`（`advance=false`，`requiredType='structural'`，`handoffNote` 显式要求下一版含 structural/paradigm）。

### 13.3 接入版间门（`lib/index.js`，`status==='done'` 分支）
- `advance=true`（含 `final-iteration`/`single-iteration`）：原有 `currentIteration` 推进与 `handoffText` 组装代码逐字保留，零变化。
- `advance=false`：不推进 `currentIteration`（保持原值），落盘审计字段 `breakthroughBlocked: { at, consecutiveIncremental, requiredType, reasons }`，`handoffText` 改用 `gateDecision.handoffNote` 明确要求下一版含 structural/paradigm 并附 `reasons`；不改 `expr`/`step` 状态为 `paused`/`rejected`（区别于打回熔断语义）；沿用既有共用 `appendTrace(role='mainagent')` 留痕（三分支共享同一段 `appendTrace` 调用，未新增重复调用）。
- 白名单（本仓库高危点，读+写两处均需覆盖，否则字段写盘即丢或读不回来——同 v3.8 Step3-fix 教训）：
  - 写白名单：`lib/index.js`「`breakthroughBlocked: state.breakthroughBlocked || null,`」，紧邻注释「V2-2: 版间门×突破度联动——阻断判定审计字段纳入写白名单（v3.8 Step3-fix 同类教训：漏加写白名单会导致字段写盘即丢，面板/审计永远读到 null）」。
  - 读白名单：`lib/index.js`「`breakthroughBlocked: data.breakthroughBlocked || null }`」，紧邻注释「V2-2: 版间门×突破度联动——阻断判定审计字段纳入读白名单（同 v3.8 Step3-fix 教训：若只加写白名单、漏加读白名单，字段落盘却读不回来，面板/幂等判定会读到 undefined）」。
  - `readStepState`/`writeStepState` 的"无状态/默认"回退对象也同步补 `breakthroughBlocked: null`，与既有字段（如 `autoIterDeclAudit`）保持同一模式。

### 13.4 幂等与可恢复
同一 `exprId` 重复触发版间门（未发生新的 `restructure`）时，`updated.currentIteration`/`updated.incrementalStreak` 不变，`evaluateVersionAdvance` 对相同入参返回相同结果（无副作用），不会重复推进或重复阻断。主 agent 通过 `restructure` 提交含 structural/paradigm 的新版 `newSteps` 后，`evaluateBreakthroughPlan`/`auditBreakthrough` 会把落盘的 `incrementalStreak` 归零，下次版间门决策时 `evaluateVersionAdvance` 随之 `advance=true`，恢复正常推进。

### 13.5 测试
`test/breakthrough-gate.test.js` 新增 11 个用例（原 20 个全部保留未改）：阈值触发（`advance=false`/`requiredType='structural'`/`handoffNote` 含 Incremental/Structural/Paradigm 关键词）、本版含 structural 时 `advance=true` 且 streak 归零（即使落盘 streak 已超阈值）、历史为空放行、全 unknown/null 不触发额外拦截、达到 iterations 上限 `verdict='final-iteration'`、单版任务 `verdict='single-iteration'`、`reasons` 含可读依据（连增次数与阈值文案）、`max` 显式入参覆盖默认阈值、同入参重复调用结果一致（幂等）、接入点 source 标记回归（调用点+两处白名单同时存在）。全量回归 `node --test --test-reporter=tap $(ls test/*.test.js test/*.test.mjs)` 509 个用例，506 通过、3 个失败（`shadow-gate.test.js` 的 `TC-Green`/`TC-GC`/`getGitHead`）与本次改动无关——`git stash` 验证改动前同样失败（本机 WSL 路径与用例硬编码的 `D:/DSH` Windows 路径/仓库 HEAD 期望不匹配的既有环境问题，同 12.4 记录的问题）。

### 13.6 已知残余范围限制（未做项，非遗漏）
- 未改动 `restructure` 端点既有的 `evaluateBreakthroughPlan` 硬门禁（400 拦截）与其响应结构，两处门禁（`restructure` 提交时 / 版间门推进时）职责不同：前者拦截"提交一个仍不达标的新计划"，后者拦截"在未补突破项前就推进版本号"，二者互补而非重复。
- 未改变 `rejectStreak`/`paused` 熔断语义：`breakthroughBlocked` 只是"暂不推进版本号 + 要求补突破项"，不等价于打回或暂停，不清空 `activeSteps`、不改 `step.status`。
- 未对 `breakthroughBlocked` 字段做历史清理（一旦阻断发生，字段会一直保留到下次成功推进版本号时被新的写入覆盖）；面板展示/清理策略超出本任务写入范围。

## 14. 引擎↔文档一致性校验器（V3-1，机器事实清单固化）

### 14.1 背景
此前发生过"文档与代码漂移"：突破度门禁的判定规则只在文档里成立、环境开关的语义描述与代码实现不一致。`scripts/sync-engine-docs.mjs` 新增只读校验器，从代码里机械提取三类事实（路由 / 环境开关 / 版本锚点）并与文档比对，`--check` 漂移即非零退出，防止本文档与 `lib/index.js`、`lib/*.js`、`package.json` 再次脱节。

### 14.2 三类机器事实与匹配规则
- **路由**：从 `lib/index.js` 提取所有 `webServer.register({ ..., path: '...' })` 的 path 字符串；与本文档做子串比对，缺项记为 `missing-in-doc`；反向从本文档提取形如 `/dsh-web-relay/...` 的路径片段，代码里未注册的记为 `stale-in-doc`。
- **环境开关**：从 `lib/*.js` 提取所有 `process.env.DSH_*` 引用；与本文档做子串比对，缺项记为 `missing-in-doc`。
- **版本锚点**：取 `package.json` 的 `version`；分别在 `README.md`、`docs/COMPATIBILITY.md` 中查找该精确字符串，或退化为 `{major}.{minor}.x` 简写锚点（本仓库 `docs/COMPATIBILITY.md` 曾用 "4.9.x" 这种写法）任一命中即算记载。

### 14.3 路由表全量清单（与 `lib/index.js` 注册的 25 条一一对应）
| 路径 | 处理函数（`lib/index.js`） |
| --- | --- |
| `/dsh-web-relay/status` | `statusHandler` |
| `/dsh-web-relay/health-check` | `healthCheckHandler` |
| `/dsh-web-relay/ask` | `askHandler` |
| `/dsh-web-relay/context` | `contextHandler` |
| `/dsh-web-relay/parse` | `parseHandler` |
| `/dsh-web-relay/execute` | `executeHandler` |
| `/dsh-web-relay/steps` | `stepsHandler` |
| `/dsh-web-relay/steps/update` | `stepUpdateHandler` |
| `/dsh-web-relay/steps/declare` | `stepsDeclareHandler` |
| `/dsh-web-relay/steps/v2-check` | `v2CheckHandler` |
| `/dsh-web-relay/route/decide` | `routeDecideHandler` |
| `/dsh-web-relay/steps/auto-review` | `autoReviewHandler` |
| `/dsh-web-relay/steps/alternatives-review` | `alternativesReviewHandler` |
| `/dsh-web-relay/trace` | `traceHandler` |
| `/dsh-web-relay/replay` | `replayHandler` |
| `/dsh-web-relay/shadow` | `shadowHandler` |
| `/dsh-web-relay/traces` | `tracesHandler` |
| `/dsh-web-relay/record` | `recordHandler` |
| `/dsh-web-relay/protocol` | `protocolHandler` |
| `/dsh-web-relay/steps/finalize` | `finalizeHandler` |
| `/dsh-web-relay/steps/rollback` | `rollbackHandler` |
| `/dsh-web-relay/steps/restructure` | `restructureHandler` |
| `/dsh-web-relay/admin/prepare-restart` | `adminPrepareHandler` |
| `/dsh-web-relay/admin/resume-scan` | `adminResumeScanHandler` |
| `/dsh-web-relay/admin/heartbeat-check` | `adminHeartbeatHandler` |

### 14.4 环境开关全量清单（与 `lib/*.js` 提取的 21 个一一对应）
| 开关 | 定义/读取位置（`lib/`） |
| --- | --- |
| `DSH_CC_REVIEW_ENABLED` | `index.js` |
| `DSH_CC_REVIEW_POLL_MS` | `index.js` |
| `DSH_RELAY_BATCH_CONCURRENCY` | `index.js` |
| `DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED` | `breakthrough-gate.js` |
| `DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL` | `breakthrough-gate.js`、`index.js` |
| `DSH_RELAY_BRIDGE` | `index.js` |
| `DSH_RELAY_BRIDGE_STALL_MS` | `index.js` |
| `DSH_RELAY_CLAUDE_MODEL` | `index.js` |
| `DSH_RELAY_GC_MS` | `index.js` |
| `DSH_RELAY_HEALTH_CACHE_MS` | `index.js` |
| `DSH_RELAY_HEARTBEAT_MAX_AGE_MS` | `index.js` |
| `DSH_RELAY_HEARTBEAT_MIN_GAP_MS` | `index.js` |
| `DSH_RELAY_HEARTBEAT_MS` | `index.js` |
| `DSH_RELAY_HEARTBEAT_STALE_MS` | `index.js` |
| `DSH_RELAY_REPO` | `index.js` |
| `DSH_RELAY_REPO_PATH` | `index.js` |
| `DSH_RELAY_UNCLAIMED_MS` | `index.js` |
| `DSH_RELAY_WEBHOOK_URL` | `index.js` |
| `DSH_RELAY_WORKSPACE` | `index.js` |
| `DSH_SESSION_ID` | `index.js` |
| `DSH_WORKSPACE` | `index.js` |

### 14.5 版本锚点
`package.json` 当前 `version` 为 `4.9.7`；`README.md`（版本对照表/更新记录）与 `docs/COMPATIBILITY.md`（兼容矩阵）均已用精确字符串 `4.9.7` 记载，`--check` 对此类零命中。

### 14.6 实现与测试
- 可注入纯函数：`collectEngineFacts({ readFile, root, libFiles })` / `collectDocFacts({ readFile, root })` / `diffFacts(engine, docs)`，CLI 只做 `fs` IO 与退出码（`scripts/sync-engine-docs.mjs`）。
- `test/sync-engine-docs.test.js` 用真实临时目录（`fs.mkdtempSync(path.join(os.tmpdir(), 'sed-'))`）+ 真实 `fs.readFileSync` 夹具覆盖：无漂移通过、路由缺失、环境开关缺失、版本锚点不一致、版本锚点简写格式、stale-in-doc（文档未注册路由）、文档缺失（诊断 warning 不抛栈）、正则无命中（warning 不静默通过）共 8 例；夹具刻意不用内存 map + 手写正斜杠路径字符串，因为脚本内部用 `path.join` 拼接路径，在 Windows 上会产出反斜杠路径，手写正斜杠键会导致 ENOENT 误判。
- 用法：`node scripts/sync-engine-docs.mjs [--check] [--json] [--root <dir>]`；无漂移 exit 0，有漂移（含 warning）exit 非 0；`--json` 输出机器可读结构。

### 14.7 已知残余范围限制（未做项，非遗漏）
- 只读校验，不自动改写文档；发现的缺项由人工/主 agent 判断是否补齐，脚本本身不写文件。
- 路由/环境开关的比对范围限定在 `docs/CC-HYBRID.md`；`docs/dsh-web-relay-说明书.md` 等其他文档虽然也记载了部分路由，但未纳入本校验器比对范围（任务契约明确指定比对文档，未扩大范围）。

## 15. Swarm 空打回修复：parseRoleReview 区分「无法解析/unknown」与「显式 rejected」（ccfix-20260915-swarmparse）

### 15.1 缺陷回顾
`lib/swarm-prompts.js` 的 `parseRoleReview`（修复前约 L48-62）在 `JSON.parse` 失败且宽松正则 `/"verdict"\s*:\s*"(approved|rejected)"/` 也匹配不到时，**静默默认返回 `rejected`**，且 `findings: []`、`suggestion: ''`——即「无法解析角色输出」被误判为「角色明确打回」，且没有任何可执行意见。`lib/index.js` 的 `swarmConsensus` 要求双 Approve 才通过，任一角色被误判 `rejected` 即整步打回，造成「同一份交付、同样输入」出现随机假打回，只能靠人工重提碰运气。命中实测：step 4（V2-1）2/3 次、step 7（V3-2）2/2 次。

### 15.2 修复实现
- `lib/swarm-prompts.js`：`parseRoleReview` 新增 `verdict:'unknown'` 语义——合法 JSON 但 `verdict` 非法值、或完全无法解析时返回 `unknown`（不再默认 `rejected`），并新增 `raw` 字段（原始输出截断 ≤500 字，`RAW_CLIP_LEN`），unknown 分支尽力用正则从原文提取 `findings`/`suggestion`（提不到则留空但保留 `raw`）。`swarmConsensus` 新增 unknown 短路分支（在 approved/rejected 判定之前）：任一角色 `unknown` → `result:'unknown'`，不再落入「非 approved 即算打回」的既有二元判断，双 approve/双 reject/单打回三种既有矩阵行为不变。
- `lib/index.js`（`obtainReviewVerdict` 的 `enableSwarm` 分支，约 L3417-L3480）：
  1. 角色通道完全不可用（四链全失败）原先也硬编码返回 `verdict:'rejected'`，一并修正为 `verdict:'unknown'`（`raw:'（审核通道不可用）'`）——通道不可用同样是「无法裁决」而非「显式打回」；
  2. `swarmConsensus` 结果为 `unknown` 时，**重问一次**：仅对 `verdict==='unknown'` 的角色重新发起独立请求（新 `runRole` 调用，非缓存），重新合成 consensus；
  3. 重问后仍 `unknown` → **降级到标准独立审核链**：递归调用 `obtainReviewVerdict(..., enableSwarm=false, ...)`（等价于 `enableSwarm:false` 路径：external → web-gemini → claude-code → dialog → manual），并将降级原因拼进 `fallbackReason`（`Swarm 角色 X 无法裁决（unknown，已重问一次仍无法判定），已降级标准链 → ...`）与 `reason`（notes 落盘可见），响应/降级结果均带 `swarm:{ security, refactor, consensus:'unknown', downgraded:true }`；
  4. 双角色显式 `rejected`（非 unknown）时行为不变（判 `rejected`），但 `reason` 本就是 `consensus.summary + JSON.stringify(sec.review) + JSON.stringify(ref.review)`，`review` 对象新增的 `raw` 字段随 `JSON.stringify` 自动带入 `reason` → 落盘 notes，使打回意见可执行、可追溯原始输出。
- `applyReviewOutcome`/`reviewOneStep`/`/steps/auto-review` 响应（单步 + 批量非原子路径）新增透传 `swarm` 字段（`applied.swarm` / `out.swarm`），单步响应新增 `fallbackReason` 字段（原非 manual 路径的成功响应此前未回传 `fallbackReason`，unknown/降级发生时无法在响应中感知）。

unknown 处置流程（文字流程图）：
```
角色输出 → parseRoleReview → verdict ∈ {approved, rejected, unknown}
                                              │
                         swarmConsensus(sec, ref)
                                              │
              ┌── 双 approved ────────────→ approved
              │
              ├── 双 rejected 或 单 rejected ─→ rejected（findings/suggestion/raw 随 reason 落盘）
              │
              └── 任一 unknown ──→ 重问一次（仅重问 unknown 的角色）
                                        │
                              ┌── 仍有 unknown ──→ 降级标准链（enableSwarm:false）
                              │                      fallbackReason 标注「已重问一次仍无法判定，已降级标准链」
                              └── 重问后可判定 ──→ 回到 swarmConsensus 重新合成
```

### 15.3 测试
- 新增 `test/swarm-prompts.test.js`（8 例，纯函数、不碰网络）：合法 JSON approved/rejected 原样返回、非法 verdict 值（`"LGTM"`）→ unknown 且保留 raw、宽松正则匹配（非法 JSON 但含 `"verdict":"rejected"`）、完全不可解析文本 → unknown 且 raw 非空、raw 截断 ≤500 字、`swarmConsensus` 一角色 unknown+一角色 approved → 不判 rejected（双向 + 双 unknown 共 3 断言组）、`swarmConsensus` 双 rejected 及既有矩阵回归、打回可执行（findings/suggestion/raw 均非空）。
- `test/swarm-review.test.js` 第 38-42 行原有用例 `parseRoleReview('乱码').verdict === 'rejected'` 直接编码了本次要修复的缺陷（完全不可解析仍应默认 rejected），修复后该断言与新语义矛盾，已同步改为 `'乱码'` → `verdict==='unknown'` 且 `raw.length>0`；用例数不变（仍是该 `test()` 块内 2 条断言），其余既有用例未改动。该文件不在任务契约写入范围清单内，但契约的硬性验收明确要求「全量测试全绿且既有用例不减」，两者冲突时以可运行、全绿的回归为准，改动仅此一行断言，已在此记录以便审计。

### 15.4 已知残余范围限制（未做项，非遗漏）
- 批量原子打回路径（`/steps/auto-review` 的 `batchStepIds` 且 `anyRejected` 为真时）返回的 `batchResults` 目前仅对预检阶段（not_found/非 review/锁冲突/manual）逐项带 `fallbackReason`；已取得 verdict 但被原子打回的项，`batchResults` 仍沿用既有的通用文案（「批量原子打回：同批步骤含被拒项，统一退回 rejected 待补证据」），不逐项携带该 Step 自身的 `swarm`/`findings`/`raw`。这是批量原子打回分支既有的、更广泛的可观测性缺口（非本次 unknown 语义修复引入），修复它需要改动批量分支落盘逻辑，超出本任务「修复 parseRoleReview 空打回」的范围，留待后续任务。
- 重问仅重试一次（不做指数退避/多次重试），与任务要求的「重问一次」一致；若重问后仍 unknown 且降级标准链的所有通道也不可用，最终会走到标准链自身的 manual 降级（前端展开人工审核框），这是既有 manual 兜底行为，非本次新增。
- 版本锚点比对限定在 `README.md`/`docs/COMPATIBILITY.md`，不校验其余文档（如更新日志类文档）里的历史版本号提及。

## 16. 重启后自检钩子（ccfeat-20260915-selfcheck）

### 16.1 背景
2026-09-15 实测：宿主重启后 relay 的 `bootResumeScan` 打印「重启续跑扫描完成：… 续跑 0（）｜熔断 0（）」——这是**正确行为**（它只续跑「在飞」的 expr，已 finalize 的计划不在续跑名单里），但后果是：三副本（源码/运行端/其余副本）里仍可能残留修复前的旧代码（**交付漂移**），却没有任何机制在重启后主动叫醒主 agent 去核验，只能靠人工事后发现。另一背景：harness 侧 goal 会被宿主重启解除武装，需要人开口才重新武装；relay 侧的 `wakeMainAgent` 唤醒是唯一可自动化、无需用户开口的通道。本钩子把「重启后该做的检查」变成 relay 自己的 boot 动作，只在**发现问题时**才用既有唤醒通道叫人。

### 16.2 设计与实现
- 纯逻辑抽到 `lib/selfcheck.mjs`（不碰 IO，磁盘/子进程 IO 均由 `lib/index.js` 注入）：
  - `computeDrift({ manifest, listDir, readFile, hash })`：按 `package.json` 的 `files` 清单展开 source/runtime 两端文件列表并逐文件比对内容摘要，区分 `content-diff`/`missing-source`/`missing-runtime` 三种漂移；
  - `checkRouteContract({ registeredRoutes, requiredRoutes, handlerSource, requiredHealthFields })`：校验自身已注册的关键路由是否仍存在、`/health-check` handler 源码里是否仍含预期审计字段；
  - `needsNotify({ drift, contract })`：drift 非空或 contract 未通过 → 需要通知；两者皆正常 → 不通知（无问题绝不打扰）；
  - `mapExternalResult({ exitCode, signal, timedOut, tail })`：外部命令 exitCode/超时/信号 → `{ ok, reason, tail }`，超时与非 0 退出可通过 `reason` 文本区分（`timeout` vs `exit=N`）；
  - `shouldSkipBoot({ lastBootId, currentBootId })`：同 bootId → 跳过（每 boot 只跑一次）。
- `lib/index.js` 的 `bootSelfCheck()`（挂在 `bootResumeScan()` 定义之后、boot 尾部与 `bootResumeScan()` 同批次异步触发，约 L4763-4767 调用点）：
  1. 读 `web-relay/selfcheck/.last-boot-id` 判定是否已跑过本 boot（`shouldSkipBoot`）；
  2. 交付漂移：`REPO_ROOT`（源码端，`DSH_RELAY_REPO` 或 import.meta.url 上溯）vs 本插件实际加载副本（运行端，import.meta.url 推导），按 `PLUGIN_FILES_MANIFEST`（即 `package.json` 的 `files`）逐文件 sha256；
  3. 路由契约：读自身源码文本，用既有 `scripts/sync-engine-docs.mjs` 的 `extractRoutes()` 正则提取已注册路由（不重复造轮子），与 `/health-check` handler 源码切片一起传给 `checkRouteContract`；
  4. 可选外部重回归：`DSH_RELAY_SELFCHECK_CMD` 非空时，用 `node:child_process` **异步 `spawn`**（`shell:true`，超时后 `SIGKILL`，默认超时 `DSH_RELAY_SELFCHECK_TIMEOUT_MS` 见下表）执行；
  5. `needsNotify(...)` 或外部命令失败 → `wakeMainAgent({ sessionId, handoffText })`；`sessionId` 取 `process.env.DSH_SESSION_ID`，缺失则回退到最近一个（`updatedAt` 最大）落盘 expr 的 `sessionId`，两者皆无则只落盘记 `wakeReason`、不报错；
  6. 结果落盘到 `<workspace>/web-relay/selfcheck/<bootId>.json`，并写入内存态 `lastSelfCheck` 供 `/health-check` 直读暴露。
  7. 全程 `try/catch` 包裹，任何一步异常只 `console.warn` 记录、不 `throw`，不影响 boot、不使 `/health-check` 500。

### 16.3 为何必须异步、绝不能用 execSync
宿主对本插件的健康探针以数秒级超时轮询，连续多次探测不到响应即判定「宿主失联」→ 触发 `bin/watchdog.mjs` 重启整个宿主进程（详见 §7/§8 的重启风暴实证）。若自检的外部重回归用 `execSync` 同步执行，一次动辄 1-2 分钟的阻塞会让事件循环在这段时间内完全无法响应任何请求（包括探针本身），造成「探针连续超时 → watchdog 判定失联 → 重启宿主 → 重启后又触发一次同步阻塞」的自我维持重启风暴——这正是本仓库刚修复过的故障类别（见 §7 的实测：拉起宿主 18 次、判定重启 37 次）。因此：
- `runSelfCheckExternalCommand()`（`lib/index.js`）一律用 `node:child_process` 的 `spawn`（配合 `setTimeout` + `child.kill('SIGKILL')` 超时熔断），绝不使用 `execSync`；
- `test/selfcheck.test.js` 有一条源码契约用例专门断言该函数体内不含 `execSync(` 调用、且含 `spawn(` 调用，防止后人「图省事」把它退回同步阻塞实现；
- 默认（不设 `DSH_RELAY_SELFCHECK_CMD`）只做进程内的漂移比对 + 路由契约判定，均为内存/本地磁盘操作，无网络、无子进程，实测耗时为毫秒级。

### 16.4 开关与字段
| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_RELAY_SELFCHECK_CMD` | 未设置（不跑） | 外部重回归命令（如主 agent 的 `regression-post-restart.mjs`）；**严格 opt-in**，不设则只做进程内检查 |
| `DSH_RELAY_SELFCHECK_TIMEOUT_MS` | `240000`（4 分钟） | 外部命令超时后 `SIGKILL` 熔断 |

`/health-check` 响应新增 `selfCheck` 字段（`null` = 尚未跑完，boot 期间短暂出现）：
```jsonc
{
  "selfCheck": {
    "at": "2026-09-15T12:00:00.000Z",
    "bootId": "mu1xhb9d-eca1256e",
    "ran": true,
    "drift": { "checked": 42, "differing": [{ "path": "bin/watchdog.mjs", "kind": "content-diff" }] },
    "contract": { "ok": true, "failed": [] },
    "external": { "ran": false, "ok": null, "reason": "DSH_RELAY_SELFCHECK_CMD 未设置（默认不跑外部重回归，见 docs/CC-HYBRID.md）", "tail": "" },
    "notified": true,
    "wakeReason": null
  }
}
```
结果同时落盘到 `<workspace>/web-relay/selfcheck/<bootId>.json`（幂等标记 `<workspace>/web-relay/selfcheck/.last-boot-id`）。

### 16.5 失败模式（均 fail-open）
- `REPO_ROOT` 未设置 `DSH_RELAY_REPO` 时会回退到运行端自身路径，此时源码端=运行端，drift 恒为空——这不是缺陷，是「没有独立源码端可比对」时的安全兜底（不会产生假阳性）。
- 清单条目缺失/不可读、`listDir`/`readFile` 抛错 → 该文件按「缺失」处理（`missing-source`/`missing-runtime`），不会让整个自检抛出。
- 外部命令不存在/权限不足 → `spawn` 触发 `error` 事件，映射为 `{ ok:false, reason:'spawn 失败：...' }`，不抛出。
- 外部命令超时 → `SIGKILL` 熔断，`reason` 含 `timeout` 字样，与「exit≠0」可区分。
- `sessionId` 缺失（无 `DSH_SESSION_ID` 且无任何落盘 expr 的 `sessionId`）→ 只落盘、`wakeReason` 记录原因，不报错、不重试。
- 每 boot 仅执行一次（`shouldSkipBoot` 以 bootId 为幂等键），防止 boot 序列被多次触发（如 apply 被重复调用）时重复唤醒刷屏。

### 16.6 已知残余范围限制（未做项，非遗漏）
- 外部重回归默认不跑：`DSH_RELAY_SELFCHECK_CMD` 需要显式设置才启用。理由是本钩子在 boot 路径上执行，任何默认开启的外部命令都会成为「boot 必经的额外耗时/额外失败面」，与「boot 绝不能被自检拖慢/拖垮」的硬约束冲突；把它做成 opt-in，让运维方（或主 agent 自身的部署脚本）按需在自己可控的环境里接上（例如主 agent 的 `regression-post-restart.mjs`），而不是让 relay 自身对外部脚本的存在与退出码语义做假设。
- 路由契约自检的 `requiredRoutes`/`requiredHealthFields` 是当前已知的关键子集（非全量自动派生自 `webServer.register` 调用），随功能演进需要人工同步维护（与 §14 的 `sync-engine-docs.mjs` 面对的维护成本是同一类问题）。

## 17. 心跳自查新增 unclaimed-pending 信号：可执行但无人认领的待办步骤（ccfeat-20260915-unclaimed）

### 17.1 真实事故回顾
2026-09-15 实测：某计划 Step 7 处于「pending 且依赖（step 6）已 approved」的可执行状态，但链条的 `items` 只覆盖 planStepId 1/2/4/5/6，根本不包含 step 7；跑完 V3-1 后整条管线静默结束，轨迹在 `2026-09-15T01:50:26Z → 11:47:42Z` 之间零条目，白等 9 小时 57 分，最后靠人工发现才继续。根因：`lib/heartbeat-scan.js` 原有 5 个信号（`resume-circuit-paused` / `review-pending` / `rejected-pending` / `executing-stale` / `finalize-pending`）没有一个能匹配「可执行但没人认领」这一状态——心跳每轮扫描都「无待办可报」，属合法静默。

### 17.2 新信号：unclaimed-pending
`scanExprSignals`（`lib/heartbeat-scan.js`）新增第 ⑥ 个信号，判据（全部满足才 push）：
1. 该 expr 已通过既有 archived（第 25-26 行）与 maxAgeMs（第 28-31 行）两道前置守卫，即仍属活跃；
2. 存在步骤 `s`：`s.status === 'pending'` 且其 `depends_on` 中每一项对应的步骤都是 `approved`（`depends_on` 缺失/空数组视为无依赖，天然满足）；
3. 该 expr 的 `st.updatedAt` 距 `now` 已超过新 opt `unclaimedMs`（默认 `1800000` = 30 分钟，风格与 `staleMs` 同级，可经 `opts` 注入覆盖，便于单测与 env 调节）。

依赖判定语义与 `lib/index.js` 的 `depsSatisfied`（约 L1645-1652）保持一致：deps 为空数组 → 满足；否则每个依赖 id 必须能在 `steps` 中找到且 `status === 'approved'`（按 `String(id)` 比对，容忍 number/string id 混用）。

**为何不复用 `staleMs`**：`staleMs` 是 `executing-stale`（④）专用的「执行中停滞」语义——衡量的是「已经在做但卡住了」；`unclaimedMs` 衡量的是完全不同的状态——「压根没人在做」（`pending` 而非 `executing`）。两者混用会让「可执行没人做」与「执行中卡住」互相干扰：例如运维把 `staleMs` 调小以更快发现卡死的执行，会连带误触发大量「刚变可执行还没来得及认领」的假阳性；反之调大 `staleMs` 以容忍长任务，又会让无人认领的步骤迟迟不被发现。这是本规格的明确设计决定，两个阈值语义独立、互不复用。

**计时基准的取舍**：用 `st.updatedAt` 而非「最后一个依赖被 approve 的时刻」——任何写入该 expr 的操作都会重置这个计时器，因此该判据天然偏保守、偏少报（宁可晚叫不可误叫）。若某依赖早已 approved 但 expr 因其它步骤的活动而频繁 touch `updatedAt`，本信号会被持续推迟触发。后续可改进方向：改用「该步骤最后一个依赖被 approve 的时刻」（需读 `steps[].notes` 里的审批时间戳）以更精确定位「认领窗口」的起点，本次先用 `updatedAt` 这一保守近似。

### 17.3 与既有 5 个信号的边界
`unclaimed-pending` 只匹配 `status === 'pending'` 的步骤，与其余信号的匹配条件结构性互斥：
- 依赖已满足但步骤是 `executing` → 归 `executing-stale`（④）负责，不报 `unclaimed-pending`；
- 依赖已满足但步骤是 `review` → 归 `review-pending`（②）负责，不报 `unclaimed-pending`；
- 全部步骤已 `approved`（无 `pending` 步骤）→ 仍只报 `finalize-pending`（⑤），`unclaimedSteps` 恒为空，不会被 `unclaimed-pending` 吞并。

同一 expr 允许并列命中多个信号（`signals` 数组本就支持），但每个信号的触发条件均独立成立，互不覆盖、互不替代。

### 17.4 范围
本任务只补这一个纯函数层信号。接线到心跳循环、唤醒台账、`/health-check` 暴露由后续任务负责，本任务未改动 `lib/index.js`。（后续任务见 §18，ccfeat-20260915-wakeledger 已完成接线。）

### 17.5 测试
`test/heartbeat-scan.test.js` 新增 8 组用例（含多断言组），覆盖：`pending`+依赖已 approved+超阈值 → 报信号且 detail 含步骤 id/title；同上但未超阈值 → 不报；依赖未 approved → 不报；已 finalized / 已归档（isTest+done）→ 不报（前置守卫仍生效）；依赖已满足但步骤是 `executing`/`review` → 不报（分别验证仍由既有信号负责）；`unclaimedMs` 可经 opts 注入覆盖（传 `1000` 立即触发）且默认值 `1800000`；`depends_on` 缺失视为无依赖；全 approved 时仍只报 `finalize-pending` 不被吞并。既有 14 条用例全部保持通过（未改动其断言）。
- 交付漂移比对的范围严格等于 `package.json` 的 `files` 清单——清单外的文件（如 `node_modules`、临时产物）不在比对范围内，这是刻意的（清单即「交付契约」，不应扩大范围）。

## 18. 心跳接线 unclaimed-pending + 唤醒台账：区分「没唤醒」与「唤醒了没人动」（ccfeat-20260915-wakeledger）

### 18.1 审计盲点（为什么需要唤醒台账）
`lastHeartbeatState.injected` 只表示「`wakeMainAgent` 调用成功」，不代表主 agent 真的行动了——心跳注入若落进一个没人消费的会话，`injected` 仍为 `true` 而实际什么都没发生。§17 事故排查时发现：因宿主日志被重启截断，事后已无法判定「到底是没唤醒，还是唤醒了没人动」。唤醒台账（`wakeLedger`）就是为消灭这个盲区新增的：每次成功唤醒时记录被唤醒的 expr 状态指纹，下一轮心跳核对该指纹是否变化，从而把两种情形区分开。

### 18.2 接线：unclaimedMs 传入 scanPendingSignals
`heartbeatTick`（`lib/index.js`）新增 `HEARTBEAT_UNCLAIMED_MS`（读取 `DSH_RELAY_UNCLAIMED_MS`，非法/缺失回退 `1800000`），与既有 `HEARTBEAT_STALE_MS`/`HEARTBEAT_MAX_AGE_MS` 同级传入 `scanPendingSignals(all, { staleMs, maxAgeMs, unclaimedMs })`。`heartbeatHandoff` 文案补一句 `unclaimed-pending` 的处置指引（判断应自行执行还是派发给 cc），否则收到唤醒的主 agent 不知道新信号该怎么办。

### 18.3 唤醒台账（wakeLedger）
- 模块级内存态，与 `lastHeartbeatState` 同级（`let wakeLedger = []`），进程内状态，宿主重启会清空——定位是让「同一宿主生命周期内」的唤醒可审计，不是跨重启持久化。
- 每次 `wakeMainAgent` 调用成功（`w.agentWoken === true`）才追加一条记录：`{ at, exprs: [{exprId, fingerprint}], signals, sessionId, agentWoken, reason, outcomes: {} }`；一次注入覆盖多个 expr 时逐个记录指纹。
- 容量上限 20 条：`wakeLedger.push(entry)` 后 `if (wakeLedger.length > 20) wakeLedger.splice(0, wakeLedger.length - 20)`，超出丢弃最旧，避免无界增长。
- `/health-check` 新增 `wakeLedger` 字段（最近 ≤20 条，含 `outcomes`），与既有 `heartbeat` 字段并列；因 `wakeLedger` 与 `lastHeartbeatState` 一样是模块级同步状态（不经 `heavyHealth()` 的异步聚合/TTL 缓存），故按 §14 历史教训的精神在两处都补齐：模块级默认值 `let wakeLedger = []`（避免未初始化）与 `healthCheckHandler` 返回体里的 `wakeLedger: wakeLedger || []`。

### 18.4 状态指纹与核对（纯函数，`lib/heartbeat-scan.js`）
- `exprFingerprint(st)`：由 expr 级 `status`/`finalized`，以及每个 step 的 `id`/`status`/`reviewedBy`/`notes.length`/最后一条 note 的 `at` 拼接成稳定字符串。选择这些字段的原因：`status`/`reviewedBy` 覆盖「步骤状态变化」；`notes.length` + 最后一条 note 的 `at` 覆盖「新增 note 但 status 未变」；expr 级 `status`/`finalized` 覆盖「收口」。不用整份 `JSON.stringify(st)`：`st` 里混有 `updatedAt` 等可能被无关操作 touch 的字段，用它做指纹会把「什么都没变」误判为 `changed`，噪音过大。
- `evaluateWakeOutcomes(entry, currentStates)`：给定一条台账记录与当前状态列表，为 `entry.exprs` 里每个 `exprId` 判定 `'changed'`（指纹不同）/`'unchanged'`（指纹相同）/`'gone'`（当前状态列表里已找不到该 expr）。fail-open：`entry`/`currentStates` 畸形（缺 `exprs`、非数组、成员缺 `exprId` 等）不抛错，尽力返回能算出的部分结果。

### 18.5 结算时机（顺序硬性要求）
`heartbeatTick` 内新增 `settleWakeLedger(all)`：对 `outcomes` 仍为空（尚未结算）的台账记录，用本轮扫描到的 `all`（当前状态列表）计算并回填 `outcomes`，然后 `console.warn` 一行汇总（`[心跳台账] 上次注入后 N 个 expr 状态有变化、M 个无变化`）。

**该调用必须放在两道 early return（`if (pending.length === 0) return` 与 `if (距上次成功注入 < HEARTBEAT_MIN_GAP_MS) return`）之前**，理由：若放在其后，恰恰是「本轮无新待办」（`pending.length === 0`）的那些轮次——也正是「唤醒了但没人动」的典型场景——永远不会执行到结算代码，台账就失去意义。`test/heartbeat-scan.test.js` 用源码字符串 index 比较（`body.indexOf('settleWakeLedger(') < body.indexOf('if (pending.length === 0) return')`）把这条顺序约束钉成契约测试，防止后人重构时把它挪到 early return 之后。

### 18.6 fail-open
台账结算（`settleWakeLedger`）与台账写入（`wakeLedger.push`）各自包一层 `try/catch`，异常只 `console.warn`，绝不允许阻断既有的 `scanPendingSignals → wakeMainAgent` 唤醒路径——即使台账代码整体出错，心跳唤醒仍照常工作。

### 18.7 不变量
本任务未改变既有 5 个信号（①-⑤）语义、`unclaimed-pending`（⑥）判据、`HEARTBEAT_MIN_GAP_MS` 注入间隔、`lastHeartbeatState` 既有字段与唤醒行为；只做接线（传参）、新增台账（旁路状态）与核对（旁路只读计算 + 回填自身字段），不改动既有唤醒判断逻辑的任何分支条件。

### 18.8 测试
`test/heartbeat-scan.test.js` 新增 11 组用例：`exprFingerprint` 步骤状态变化/新增 note/收口三种情形指纹均不同、同一状态两次调用指纹相同（稳定）、无效输入容错；`evaluateWakeOutcomes` changed/unchanged/gone 三态、fail-open（畸形 entry 不抛错）；唤醒台账容量上限 20 条（镜像 `lib/index.js` 内 `push`+`splice` 逻辑复测，因该逻辑位于 `apply()` 闭包内不可直接 import，与 `test/artifacts-update.test.js` 对闭包内逻辑的既有测试方式一致）；源码契约顺序守卫（见 §18.5）。既有 22 条用例全部保持通过（未改动其断言）。
