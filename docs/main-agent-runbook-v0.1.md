# dsh-web-relay · 主 agent 执行手册（Main-Agent Runbook）v0.1

> 适用版本：dsh-web-relay 3.4.0+
> 文档性质：**主 agent 侧的运行手册**。外部 AI 有 `WEB_RELAY_PROTOCOL` + `WEB_RELAY_EXTERNAL_AI_SKILL`（协议全文），
> 本手册补主 agent 侧缺失的一环：被唤起后该读什么、执行纪律、SOP、陷阱清单。
> 配套文档：`main-agent-lesson-schema-v0.1.md`（语境能力沉淀库 schema + 收口自检）。

---

## 0. 使用时机

出现以下任一信号，主 agent 应认为自己处于 dsh-web-relay 三方协作语境，先读本手册再行动：

- 收到 handoff：`【主 agent 请协助】dsh-web-relay 收到需要主 agent 接管的内容`
- 用户消息中出现 `workspacePath` / `试验记录` / `三方轨迹` / `Step List` 等字样
- 用户直接要求"按 dsh-web-relay 流程 / 走协议 / 自动迭代 / 版间门 / restructure / 提交审核"

收到后顺序：① 读本手册 ② 读试验记录 md ③ 读 `*.steps.json`（尤其顶层 `iterations/autoDecision/currentIteration`）④ 再表态。

## 1. 三方角色与产物约定

| 角色 | 职责 | 何时出现 |
|---|---|---|
| 用户（human） | 发起任务、最终拍板、面板操作（审核/一键收口）、宿主重启实测 | 熔断 paused、finalAcceptance、需面板操作时 |
| 主 agent（本会话） | 执行（读/写/验证/发布）、回写三方轨迹、按规则提审 | handoff 注入后全程 |
| 外部 AI | 方案/规划/评审/审核；`/ask` 或 `/steps/auto-review` 的调用方侧 | 每轮规划、每步 review |

产物约定：
- 记录：`web-relay/experiments/dsh-web-relay-<stamp>.md`（frontmatter 含 channel / requestProvider / providerLabel / fallbackReason）
- 状态：`web-relay/experiments/expr-<stamp>.steps.json`
- 轨迹：`web-relay/traces/expr-<stamp>.md`（追加幂等；主 agent 收口=追加 `## [主 agent] <ISO时间戳>` 条目）

## 2. 全局执行纪律（违反过的都在这里）

1. **先读后表态**：被唤起先读记录+steps.json（含顶层迭代字段），不凭印象判断。
2. **审核归属不可越权**：
   - `importance=high` 且 `review=true`（含 reviewSpecified=true）→ 主 agent **不得**自行置 approved；执行+回写证据后置 `review`/走 auto-review（服务器 external→dialog→manual），由外部 AI / dialog / 用户在面板批准。
   - `importance=low` / `review:false` → 可免审（complete 自动 approved，reviewedBy=mainagent 留审计）。
   - 手动直接改 steps.json 置 approved 只允许 low/review:false 情形；high 情形必须走审核来源（external/dialog/manual）。
3. **restructure 规划权在外部 AI / 面板 / 用户**：主 agent 发现"外部 AI 规划与现状冲突/重造"时，做审计取证（源码行号 + 历史 trace），把差异交回外部 AI 评审（`/ask`）请求 restructure；**不擅自替换外部 AI 的 Step List**。外部 AI 输出新列表（json:agent-action）后才按新列表执行。
4. **AutoIteration**：
   - 声明解析：严格 JSON 块 `{"iterations":N,"finalAcceptance":"...","autoDecision":true}` 优先；叙述式/中文（"自动迭代3个版本"）兜底（v3.3.2 起支持）。宿主旧版只认严格 JSON——要求外部 AI 输出独立 JSON 声明块。
   - 版间门：Vn 全 approved 才进 Vn+1；达 iterations 上限收口 done 并唤醒用户最终实测。
   - 熔断：连续打回 ≥3 → paused，停并报告用户，不无限重试。
5. **该停就停**（把控制权交回协议指定方，而不是自作主张继续或把决策抛给用户）：
   - 需要外部 AI 评审/审核时 → 走 `/ask` 或提交 auto-review；
   - 熔断 paused、finalAcceptance（重启实测）→ 报告用户等实测；
   - 面板操作点（一键收口/手动审核）→ 提示用户在面板做。
6. **通道与降级**：gemini-free 失败会降级 web-gemini→dialog；记录 frontmatter 的 requestProvider/providerLabel/fallbackReason 是审计真相，先读它再解释"为什么走网页/降级"。
7. **重启/续跑/回合闭环纪律（v4.9.2，lesson 036/037）**：
   - 杀宿主（kill-host/restart-sync）**只能后台 job**（同步执行必被 harness 中断——工具调用与 3080 有连接）；kill 后**不 wait job 句柄**（跨回合失效+UI 悬挂），改同消息**同步 probe**（Start-Sleep 65 + /status）查 uptime/bootId 确认自愈。
   - 无介入续跑：expr 落盘 `sessionId = $env:DSH_SESSION_ID`（harness 环境变量）→ 宿主重启后 bootResumeScan 自动注入「宿主自愈重启·自动续跑」唤醒消息（零用户输入，实证 2 次）；心跳（15min 周期）兜底无重启场景的待办提醒；宿主与任务状态永不死（watchdog 自愈 + 双保险），盘上状态随时可续。
   - 回合自检：输出最终文字前自问「还有未竟工作吗」——有就同一回合继续工具调用，禁止「接下来做 X」预告式结尾；结束回合仅完成汇报或需用户决策。

## 3. 执行 SOP

1. 读 handoff 中的记录/轨迹路径；读记录 md 全文与 steps.json（含顶层字段）。
2. 核对通道审计：`channel / requestProvider / providerLabel / fallbackReason`——确认这次是 API 直连还是降级。
3. 取当前步骤（currentStep/activeSteps + 依赖门控：depends_on 全 approved 才可执行）。
4. 实施：源码改动遵循"源=D:\dsh-web-relay、运行=安装目录、工作副本"三副本同步；每处改动 `node --check`。
5. 验证：镜像单测先行（新增逻辑先在 test/ 写镜像断言跑绿，再打补丁）；改动后全量 `node --test test/*.test.js`（当前基线 ≥102）。
6. 回写证据：追加 trace 条目（改动点、测试结果、commit/tag、行号证据）。
7. 提审：按 §2.2 规则——high+review:true → 置 review 走外部审核；low/review:false → 直接 approved（reviewedBy=mainagent）。

## 4. 发布 SOP（版本延续 v3.x）

1. `package.json` 三份 bump（源 3.3.x→次版本递增；**用 node 重写避免 BOM**：PS5.1 `Set-Content -Encoding UTF8` 会写 BOM，BOM 破坏 `JSON.parse`）。
2. 版本锚点测试同步：`test/timeout-fix.test.js` 末例断言 package.json 版本号，随发布更新。
3. `node --check` 所有改动文件；全量 `node --test test/*.test.js` 全绿（传文件列表，勿用目录参数）。
   3.5 若本次改动涉及 docs/skills/capabilities，运行能力验证：`node scripts/verify-capabilities.mjs`，全绿后再继续。
4. 三副本同步：`D:\dsh-web-relay`（源）/ `C:\Users\Administrator\.dsh\profiles\web\node_modules\dsh-web-relay`（运行）/ `C:\Users\Administrator\web-relay\dsh-web-relay`（工作副本）。
5. git（在当前源仓库 D:\dsh-web-relay，origin=victormshan/dsh-web-relay；旧 monorepo D:\DSH\dsh-web-relay 已 ARCHIVED 勿再提交）：
   - 只 add 本任务范围路径（勿误纳 dsh-web-gemini-ext 等未提交改动；可先 stash）。
   - commit → tag `v3.x.y` → `git push origin main --tags`。
   - 远端落后先 `git pull --rebase origin main`（未提交改动需先 stash，push 后 `ls-remote --tags origin` 核对 tag 在列）。
6. 运行宿主需重启才加载新代码；重启是 finalAcceptance 的用户动作，主 agent 不自行杀宿主（会断自己会话）。

## 5. 审计 SOP（"已实现 vs 重造"判定）

- 用 grep/read 取源码行号证据（如熔断 `rejectStreak>=3`、restructure 悬空 400、AutoIteration 版间门段落）。
- 对照历史 trace/experiments 的实测记录（如 8/27 AutoIteration 熔断实测 expr）。
- **产出差异表交外部 AI 评审**，由其裁决 restructure 与否；把裁决结果写入 trace。

## 6. 已知陷阱清单（本仓库实测）

| 陷阱 | 现象 | 对策 |
|---|---|---|
| PS5.1 `Set-Content -Encoding UTF8` | package.json 出现 BOM，node JSON.parse 崩 | 用 node `fs.writeFileSync(...,'utf8')` 重写（会去 BOM） |
| `deploy.ps1` | ANSI 编码，PS5.1 解析 UTF-8 中文报语法错 | 改用三副本手工同步 |
| `node --test test/`（目录参数） | 报 `Cannot find module ...\test` | 传文件列表：`node --test test/*.test.js`（展开后逐个传入） |
| PowerShell 控制台 UTF-8 | 中文显示乱码（`â` 前缀） | 不影响落盘；验证文件本体用 read 工具 / node 读取 |
| tag 体系 | v1.9.x 为旧协议时代命名，已弃 | 发布一律延续 v3.x |
| 面板实际状态 | 直接改 steps.json 与面板状态以文件为准 | 编辑后刷新面板核对；high 步骤禁自批见 §2.2 |
| 宿主运行版本 | 安装目录代码改动需重启宿主才生效 | 重启是用户动作（finalAcceptance） |
| cc 任务 outputDir 绝对路径 | buildReviewTask 曾硬编码 `/mnt/d/cc-tasks/tasks/<id>/out` → 每个任务被 v2 门控 REJECT（.invalid/ 堆积） | outputDir 字段必须相对（"out"）；绝对路径只放 prompt（lesson 038） |
| 宿主重启后延迟投递噪声 | aux 评审快照（/ask 落盘）被 bootResumeScan/心跳反复唤醒；陈旧信号分批延迟送达 | aux 快照逻辑归档（isTest=true+done）；收尾期实盘核对 steps.json + heartbeat.found 后 trace 留痕即可（lesson 039） |
| 三副本同步遗漏 | 开发源 lib 改动 ≠ 宿主生效（运行副本跑旧代码）；work copy 镜像滞后 | 运行副本同步 + restart-now；收口时 work copy 全量镜像；scripts/docs/test 不进运行副本（lesson 040） |
| 部署形态交付的加载路径 | 方案给的 `targetWorkspace` ≠ 运行时实际加载的那一份（如 Chrome 未打包扩展加载 `D:\dsh relay test\dsh-web-gemini-ext`，而加固落在 `D:\DSH\dsh-web-gemini-ext`）→ 代码正确但重载后零变化（静默落差）；服务/扩展两侧版本还可能错配 | 实施前先取运行时注册表确认加载目录：Chrome `Secure Preferences` 的 `extensions.settings[<id>].path`（location=4）+ `Preferences` 的 `file_data["manifest.json"]`（已加载 manifest 原文）；计划任务 `schtasks /query /v`；常驻进程查命令行+cwd。产物落加载目录、三副本 SHA256 一致、覆盖前 `*.bak-presync-<stamp>`；收口以"重载后生效"为验收前提（lesson 049） |

| 验收字段「从未被真实使用者触碰」 | `acceptanceScript` 在 schema/CLI/单测里齐全，但真实任务 0 使用者 → 首次真用即把值当 shell 命令执行（`/bin/sh: x.mjs: not found`），合格产物被判 failed | 新字段上线前必须有**至少一次真实使用者**跑通；探针必须落在双方共享命名空间 `<仓库>/probes/`，且**禁止硬编码单平台路径**（lesson 074/083） |
| 定时任务弹 cmd 窗口 | 计划任务直接跑 `.cmd` → 每次触发弹一个空窗口（输出已重定向，故窗口是空的） | 经 `_hidden-run-*.vbs` 启动（样式 0 + 等待 + **退出码透传**）；为「不弹窗」丢掉退出码 = 隐藏失败（lesson 081） |
| 无人值守下告警无人被叫 | 分层审计连续 9 次 ACTION-NEEDED 只写日志与 Last Result（4 小时无人处理） | 告警必须接到唤醒通路（信号文件 → 插件 boot/心跳 → 唤醒主 agent），同源用稳定键**只叫一次**，销账后复发再叫（lesson 078） |
## 7. 配套

- 协议全文（外部 AI 侧）：`lib/index.js` 顶部 `WEB_RELAY_PROTOCOL` / `WEB_RELAY_EXTERNAL_AI_SKILL`。
- cc-task-schema v2（cc 任务契约严格校验）：`docs/task-schema-v2.md`——validateTask/validateResult/CLI（validate-task/validate-result/report/recover/invalid）/watchdog 恢复/v2-check 端点/派发纪律；registry 条目 `cc-task-schema-v2`。
- 能力沉淀：`docs/main-agent-lesson-schema-v0.1.md`。
- 历史决策档案：`docs/dsh-web-relay-改进方案-2026-09-01.md`、`docs/dsh-web-relay-说明书.md`。

## 8. 无人值守与执行接地（2026-09-19 增补）

判定与升级是两个独立问题：**「这份产物算不算通过」**（执行接地）与**「没人在看时出问题谁来处理」**（升级通路）。
本节的机制全部接地到可复跑产物，细则与可复跑入口见 `docs/execution-grounded-gates.md`。

### 8.1 收到「链条停下等人」信号时必须销账
唤醒消息里的信号来自 `D:\cc-tasks\chain-needs-human.json`（链条在护栏触发 / 验收器自身出错 / 跑完待收口时写下）。
- 处理顺序：**先复核产物**（仓库侧探针 → 独立验收 → 必要时跨平台对照）→ **再销账**；
- 销账用 `acknowledgeHumanSignal(note)`（`D:\dsh relay test\chain-human-signal.mjs`），note 写清复核结论；
- **不销账 = 链条/通道一直停在那里**；销账后若同源复发，会以新代数（新 id）**再次唤醒**。

### 8.2 判定纪律（本仓库实测过代价）
- **按产物判定，不按执行体自述**：cc 的 `result.json` 已多次自报 failed 而产物完整正确（v9/v10/v11/v12/v13 均有实例）；
  反之也成立——自报 done 不等于通过。
- **权威环境 = 交集**：同一用例**两个平台都失败**才算真回归；单平台失败标注为平台差异、不阻断。
- **工具错误必须与判定失败可区分**（exit 3 vs exit 1）；**负控空转要判工具错误**。
- **跨进程只传 JSON**（位置化文本拼接会因空字段错位制造假结论）。

### 8.3 交付接地的判据
`/health-check` 的 `loadedLibHash` 必须与**运行时副本**的 lib 指纹逐字一致（`verify-delivery-live.mjs` 独立重算）。
「仓库领先于交付」只算待交付提示；「宿主加载的 ≠ 已交付的」才是需要重启的真问题。

### 8.4 计划任务入口纪律
定时入口一律经隐藏启动器（`D:\cc-tasks\_hidden-run-*.vbs`）：窗口样式 0（隐藏）+ 等待完成 + **WScript.Quit 透传退出码**。
不得为了「不弹窗」而丢掉退出码——Last Result 是无人值守下唯一的失败可见性出口（门禁 `verify-run-audit-cmd.mjs` 会拦）。

### 8.5 重启前必须「打欠条」：核对清单要落盘成对象
**重启/中断会清空进程内一切**：内存待办、会话里的「我打算…」、以及未落盘的意图。因此要重启时**先登记、后重启**：
- 用 `restart-with-checklist.mjs` 登记 `post-restart-verify#gN` 清单信号（写进 `D:\cc-tasks\chain-needs-human.json` 同源状态），**再**执行 `request-restart`；
- 插件启动扫描读到未结信号 → 自动注入主 agent 会话 → 核对 → `acknowledgeHumanSignal(note)` **销账**；
- 判据是**盘上有没有这个对象**（不是「我说过没有」）。同一 `stableKey` 只唤醒一次，销账后源再失败才重新唤醒；源自愈则自动销账。
- 反例（2026-09-19，代价 4 小时空转）：宿主重启前只有「重启后要核对」这句意图，重启后什么都没发生——恢复扫描只续跑**忙碌中的计划步骤**，
  而"核对"既不是 busy step 也没落盘；同型缺陷还有 v14 两次 arm 覆盖指针导致链条从未派发。详见 `docs/main-agent-lessons.json` L-088。

### 8.6 唤醒通路必须留痕，且「未验证」不得读成「通过」
- **唤醒通路是唯一一条「坏了就没人被叫醒」的能力**：它失灵与一次安静的无人值守空转**在现象上完全一样**（2026-09-19 实测代价 4 小时）。
  故插件在 boot 时**必留一行** `[pendingHuman] phase=boot decision=… woken=… id=…`（哪怕无待办）、有真实信号时**每个判定都留痕**——
  「有待办却零痕迹」正是通路失灵的唯一可检签名。
- **审计 ⑨ 层**（`verify-wake-occurrence.mjs`）按五条判据查：A 活 bootId 与启动痕迹一致；B 跨重启有待办则必须有 `wake/would-wake` 痕迹；
  B2 至少一条 `woken=true` 的成功记录；C 最近一次主动重启必须有**欠条台账**（`D:\cc-tasks\restart-debts.ndjson`，由 `restart-with-checklist.mjs` 追加）；
  D 清单的成功唤醒**不得全部发生在重启之前**（见下）。
- **三态必须分开**：`1 判定失败` / `3 工具错误` / `4 未验证（证据不足）`。**4 不等于通过**：层必须在汇总里被点名，
  总判定显示为 `OK-WITH-GAPS`；且 `code 4` 若不显式声明 `unverified` 仍按异常退出码处理（防任何层用 4 悄悄退场）。
- 判据一律**证据门控**：能证明才判失败。例：C 只认「重启当时留下的台账」——信号主槽是单槽文件会被后来源覆盖，
  事后反推会把"证据已被覆盖"误判成"当时没欠条"（假告警）。详见 `docs/main-agent-lessons.json` L-089。
- **判据 D：清单不得在重启之前被消费（2026-09-20 实测补）**。登记"重启后核对清单"是为让它在**重启之后**被评估，
  但**心跳也能消费它** —— 实测出现过"重启还没执行、心跳先把我叫醒"（日志对照：`phase=heartbeat` 在前、`phase=boot` 在后），
  此时按清单核对必然看到旧代码而失败。故 D 断言：该清单的成功唤醒不得**全部**发生在"重启之后那次启动"之前。
  **不要**写成"必须由 boot 消费"——由 boot 还是由 10 分钟后的心跳消费，对"核对发生在重启之后"无关，过严会假失败（初版即如此，被自检抓到）。
- **痕迹要按"有判定意义"留，不是按"每次评估"留**：boot 期一律留痕（证明通路跑过）；心跳期只在**存在未销账信号**时留痕。
  否则销账后的信号会每次心跳写一行（实测 4.5h 攒 19 行 ≈ 96 行/天纯噪声），反而稀释痕迹可读性。
- **插件侧根修 + 审计侧 backstop 并存**：重启清单在心跳期若"登记时刻晚于本进程启动"则**延后到 boot**消费
  （留痕 `decision=none err=deferred-to-boot`；延后窗口 30 分钟——超时仍允许心跳兜底，防重启请求丢失后清单永久无人处理）。
  判据 D 是它失效时的 backstop。
- **会改动信号通道的检查不得进周期门禁**：`verify-defer-restart-checklist.mjs`（两侧活体验证延后逻辑）**按需手动跑**，
  不接进 ⑨/门禁/回归——它需要写/销账主槽，放进周期审计可能误销真实告警（比它要防的问题更危险）。
- **触发型工具必须在文件头写明副作用**：`verify-postrestart-wake-path.mjs` 会**真的请求一次重启**（步骤②）。
  2026-09-20 我为修它的过时期望直接跑了整个文件，凭空造出一次计划外重启；此外"硬编码旧文案"会污染 durable 记录
  （其 `--reason` 长期写着 `activate v18 …`，与真实事件不符——现已改为如实描述并支持覆盖）。

### 8.7 写共享状态文件：先断言"写的是哪个文件/什么形状"，并发前先取单写者锁
- **背景（2026-09-20 实测事故，我造成）**：为清理队列残留，我在**内联 PowerShell** 里用
  `p.replace(/\.json$/i,'.queue.json')` 计算"规范队列路径"——PowerShell 吃掉正则里的 `$`，变量**落回主槽路径**，
  脚本把 `[]` 写进 `D:\cc-tasks\chain-needs-human.json`，**销毁了一条未销账信号的 durable 记录**。
  （结论未受影响、规范队列完好；丢的是信号本体与销账注记。详见 L-093。）
- **写入三重守卫（已机制化，门禁 `verify-signal-write-guard.mjs` 16 例守）**：
  ① **单写者锁** `agent-write-lock.mjs`（`assertWriteRight`）——已接入信号写入 / 三副本交付 / 重启登记；
  ② **路径断言** `assertSignalPath` ——写目标只能是 {主槽, 规范队列, 历史队列}，**路径只能来自格式权威**，绝不自己拼；
  ③ **形状校验** `assertSignalShape` ——主槽只接受合法信号对象，`[]`/`{}`/缺 `id|chainId|reason` 一律拒绝。
- **纪律**：清理/写信号通道一律走**脚本文件**并在写前打印"我将写入哪个文件"（内联 shell 的文本变换今天已连坑两次）；
  活工具**不得绕过格式权威直写信号文件**（⑩ 的调用点穷举会抓）；一次性脚本（`_` 前缀）视为临时物，用完即弃。
- **并发前提**：验证体系默认"唯一权威工作树"，但**这个前提此前没有任何机制保障**——GUI 刷新后旧会话仍可能被唤醒，
  于是"两个我"同时写同一工作区。故：凡"互相覆盖会丢数据"的写入一律先取锁；无 `DSH_SESSION_ID` 的无人值守路径
  **放行且不取锁**（挡死它只会制造永久假失败，见 L-086）。

### 8.8 手机访问链接：每次重启后**现读并实测**，不要贴未经验证的凭证
- **形态**：宿主只监听 `127.0.0.1:3080`，手机经 **Tailscale serve** 进来 →
  链接是 **`https://<tailnet 名>/?token=<token>`**（**https、不带端口**；`http://<名>:3080` 连不上）。
- **token 每次宿主重启都会轮换**（实测连看三条启动行＝三个不同 token）。故**不得**复用旧链接、
  也**不得**只把日志里的值贴给人 —— 这正是本会话反复踩的"写死旧值"陷阱在凭证上的版本。
- **取法（已工具化，门禁 `current-link.mjs --selftest` 8 例守）**：`node current-link.mjs`
  → 从日志**最后一条**启动行现读 token + 从最后一条「拉起宿主」取 `--trusted-host`，然后做**两侧探针**：
  正确 token 应被接受（303/200）、错误 token 应被拒（401/403）；只有两侧都符合才报"**有效**"，
  401+401 报"**已失效**"（要求重取），200+200 报"**存疑**"（鉴权异常）。找不到启动行 → **明确报错，不编链接**。
- **会话约定**：每次宿主重启后的核对报告里**附上现读+实测过的手机链接**（token 会因该次重启而变），
  省去用户翻日志。重启会同时失效手机上的 cookie → 手机上需重新用新链接进一次。

### 8.9 会话与写入权：token 是源站级凭证，唤醒目标按「最近活跃会话」
- **token 不绑定会话**（实测）：日志每次宿主启动只打印一次、每次重启换值；带正确 token → 303 + `location:/`
  （种下 `dsh-auth` cookie），带错/不带 → 401。即 **token 管"能不能进这个 GUI"，不管"你是哪个会话"** ——
  同一个 token 可打开 GUI 里任意会话，一个浏览器 profile 一个 cookie。（harness 鉴权实现未逐行读过，此点属强证据推断。）
- **唤醒投给谁由插件决定，与 token 无关**：`env DSH_SESSION_ID → 最近活跃会话（v22，按会话日志 mtime 倒序）
  → expr 里记的历史 sessionId（回退）`。**expr 会记 `sessionId`**（哪个会话建的它）——"刷新后 GUI 换了新会话、
  而 expr 仍绑旧会话"正是 2026-09-20「两个我并发写工作区」事故的根；v22 把唤醒目标改成"最近活跃会话"即为修此。
- **三条使用规矩**：
  ① **同一仓库只留一个 agent 会话**；要"重开一个干净的"，先确认旧会话没在跑任务（刷新本身没问题，唤醒会跟随最近活跃会话）。
  ② **第二个会话只做不相干的事**（不同项目/目录）。所有会话共用同一工作区、同一仓库、同一信号通道、同一 `cc-tasks` —— 写这些才会互相踩。
  ③ 判断"谁在干活"看 `/health-check` 的 `bootId`/`pendingHuman` 与日志里的 `[pendingHuman] … sid=<会话>` 痕迹，**不要看 token**。
- **现有防护的边界（务必如实告知）**：单写者锁只覆盖**信号文件 / 三副本交付 / 重启登记**三类写入；
  **普通文件编辑与 `git commit` 没有任何锁**。故"两个会话干同一件事"仍会丢更新与交错提交 ——
  锁只降低概率，不消除风险。按工作流/按文件的并行写权**尚未实现**（见下节方向）。
- **"同一仓库并行两路"若要做，方向是（未实现，需先设计再动手）**：
  · **租约而非长锁**：锁键＝资源（`repo:<路径>` / `workspace:<路径>` / `queue:cc-tasks`），
    锁文件 `cc-tasks/locks/<slug>.json` = `{owner, at, pid, note, ttlMs}`，每个**变更动作**前续租、TTL 约 10 分钟；
    他人持新鲜租约 → 拒绝变更并报 NOT-APPLICABLE（**不是**静默照写）。
  · **乐观检测兜底（关键）**：无法拦截任意 Edit/Write 工具调用，故在**每个我方代码路径**（commit / 交付 / 重启 /
    派发 / 信号写入）前重算"工作树指纹"，与任务开始时的不一致 → **停下并报告**（这能抓到锁覆盖不到的丢更新）。
  · **可验证设计**：租约 acquire/renew/expire/takeover + 指纹不一致检测，各自两侧自检（含"合成变更必须被抓到"负控）。

### 8.10 乐观检测（已实现）：覆写前先问"世界还是我记得的样子吗"
- **工具**：`node optimistic-guard.mjs --record <name>`（开工前记指纹）/ `--check <name>`（覆写前检查，
  **exit 1 = 已变动**）/ `--show <name>` / `--selftest`（7 例，含端到端"合成改动必须被抓到"负控。
  门禁与回归各 1 项覆盖）。L1＝`cc-tasks\.guards\<name>.json`。
- **它测什么**：① repo 指纹＝`HEAD` + `git status --porcelain`（谁提交/切分支/改动都会变）；
  ② 工作区**活工具链**指纹＝根目录 `*.mjs`（排除 `_` 前缀与 `.bak`）+ `probes/*.mjs` 的内容哈希。
- **它说什么、不说什么（必须说准）**：它**不区分"我改的"与"别人改的"**，只说"**世界已不是记录时的样子**" ⇒
  正确反应是**停下、重读、再决定**，而不是盲目盖上去。这不削弱价值：本会话的丢更新正是"以为自己知道当前状态"。
- **不能覆盖的范围（如实）**：它**拦不住任意的 Edit/Write 工具调用**（那不在代码里）。故它只在**我方代码路径**
  生效：开工前 record、以及 **commit / 交付 / 重启 / 大范围覆写 / 派发**之前 check。要拦编辑本身，需要的是
  租约式的写权（§8.9 末段的方向，尚未实现）。
- **用法纪律**：多步改动型任务**开工先 record**（名字用任务名，如 `sess-v23`）；每次覆写型动作前 check；
  报"已变动"时**不要**用 `--record` 覆盖掉那条记录来"消警"——那等于把检测器关掉（同"改断言让门禁变绿"）。
