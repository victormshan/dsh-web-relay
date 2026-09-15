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
