# 三方向稳定性 V1/V2 实测证据链（2026-09-10）

> expr-2026-09-10_18-42-03（AutoIteration iterations=2，主题：重启续跑 / web-gemini / 混合架构 cc 编码）
> 用途：把分散在 watchdog 日志、bridge `/stats`、expr 状态机中的证据汇聚成可复核的链条；
> 同时显式回应 V2 评审提出的三条质疑。

## 一、重启续跑（stab1_1）

### 根因（进程级取证）
执行工具命令时逐级查 `ParentProcessId`：
```
[0] powershell.exe          ← 主 agent 的工具调用进程
[1] node.exe (dsh web 宿主)  ← 直接父进程
[2] node.exe (watchdog.mjs)
[3] cmd.exe → wscript.exe → svchost.exe (Task Scheduler)
```
`bin/watchdog.mjs:killPidTree` → `platformOps.killPidTree` → Windows `taskkill /T /F <pid>`
（`/T` = 杀整棵子树）→ **正在执行重启命令的工具进程一并被杀 → 工具结果永不返回 → 回合卡死**。

### 修复
`bin/watchdog.mjs` 新增 `request-restart [delaySecs]`（`CFG.restartRequestFile`）：
只写 `bin/restart.request.json` 后立即返回；常驻 watchdog（Task Scheduler 独立进程树）
在 tick 中 `checkRestartRequest()` 检测到期信号 → `doRestart()`。

### 端到端实测（19:02:41–19:03:04Z）
| 时点 | 观测 |
|---|---|
| 19:02:41 | `request-restart 4` 返回 `RESTART_REQUESTED` **exit=0**（工具调用正常落地） |
| 19:02:45 | 信号到期，watchdog 执行 prepare → 树杀 → 拉起 |
| — | 宿主 PID **5764 → 16860** 换代；watchdog 自身 **7592 存活**（独立树未被自己杀掉） |
| 19:03:04 | `resumeQueuedAt=2026-09-10T19:03:04.241Z` → bootResumeScan 检测活跃 expr + bootId 变化 → `wakeMainAgent` 自动唤醒续跑 |
| 后续核查 | 状态机完整：`restartCount=1`、已 approved 的 stab1_2/1_3/1_4 状态保留、sessionId 落盘、信号文件已消费清理；bridge 6364 在线 |

**验收对照**：无用户介入 ✅ ／ 进程不被树杀 ✅ ／ 重启后回合继续 ✅ ／ 托管链正常 ✅

## 二、web-gemini（stab1_2 / stab2_1）

### 三层兜底（每层都有终态，不再有"永久中间态"）
| 层 | 实现 | 阈值 | 实测证据 |
|---|---|---|---|
| 宿主侧 | `lib/bridge-poll.js` `classifyBridgeTask` | failed→立即；processing>90s→stalled；pending>60s→unavailable | /ask 实测 **95s 返回**，诊断 `processing 91s 无终态` |
| 服务端 | `bridge-server.mjs` `sweepTasks()` | pending>60s / processing>120s → failed | 任务 t0001 **132s 被判 failed**，error=`server 端超时兜底：processing 132s 无终态` |
| 扩展侧 | `background.js` `sendMessage` 70s 超时 | 超时→NO_RESPONSE 上报 | 代码就位（需 Chrome 重载验证，见 §四） |

### 可观测（区分"没在轮询"与"取了不回传"）
`/stats` 输出双指标：`lastPollAt`/`pollCount`（轮询心跳）、`lastClaimAt`/`claimCount`（真正认领）、
`serverUptimeSec`、`byStatus`（含 **failed**）。

- 实例 A（无 Gemini 标签页）：`pollCount` 不增长 → 判定"扩展未轮询（无标签页）"
- 实例 B（有标签页但 content 无响应）：`pollCount` 持续增长（实测 231）、任务停在 processing → 判定"取了不回传"
- 初版缺陷：`claimCount` 把每次 `/next-task` 调用都计入（每秒轮询 → 9.5 分钟累计 299）→ 已拆分双指标

### 回应评审质疑①「5s 自愈是否为 auxBridgeTick(60s) 巧合」
**不是巧合，有进程级 + 源码级直接证据**：
- `bridge-watchdog` PID=12944，其父进程 12160（**非宿主树**）——它是**专用守护**，与宿主/watchdog 独立
- `bridge-watchdog.mjs` `CHECK_INTERVAL_MS = 5000` → 收敛上限 ≈ 10s
- 强杀 bridge-server 后实测 **5s 恢复**（新 pid）与 5s 探测周期吻合
- `watchdog.mjs auxBridgeTick`（每 12 tick×5s≈60s）是**兜底**：仅在专用守护也失效时才介入
→ 两者主备关系，自愈主要路径是专用守护。

## 三、混合架构 cc 编码（stab1_3 / stab1_4）

| 项 | 证据 |
|---|---|
| cc 审核通道修复后成功率 | `reviewChannel=claude-code` → `reviewedBy=claude-code`，**90s 成功**（rev-1a08b460fc2）；修复前 13 例全 REJECT |
| 范围评估器 | `lib/task-scope.mjs` 二次校准 **4/4 实测基准通过**（RCA→too-big 770s / 征询→risky 430s / 实现→ok 290s / stab1-4 型→risky 590s） |
| 任务规模实证 | 成功：校验器 3.7min、代码诊断 8min、征询 4.3min、范围评估器 4.8min、门控测试 1.6min；失败：RCA 超时 900s 零产物 |
| 防回退 | `test/gate-regression.test.mjs` 17 用例（含 `validateTask(buildReviewTask(...))` **组合断言**——事故实际防线） |

## 四、仍未闭合的缺口（诚实清单）

1. **扩展侧改动未端到端验证**：`background.js`（sendMessage 70s 超时）、`content.js`（两处 throw）
   需在 Chrome **重载扩展** 才生效。验证清单见 `docs/web-gemini-ext-changes-2026-09-10.md` §4。
2. **unavailable 路径（无标签页 pending>60s）**：本次 /ask 实测走的是 **stalled**（有标签页但 content 无响应）；
   unavailable 由单测覆盖 + 服务端 sweep 实测（t0001）间接佐证，缺"无标签页 + /ask"的端到端直证。
3. **cc-watchdog / runner 两重 bash 门控**：自动化测试由 stab2_2（Claude Code 派发）补齐中。
4. **watchdog 自身被 Task Scheduler 拉起**：尚无压力/崩溃场景验证（仅正常运行期观测）。
5. **cc 通道成功率样本仍少**（3 次成功 / 1 次超时）。
