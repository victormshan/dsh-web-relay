# dsh-web-gemini-ext 扩展侧改动留痕（2026-09-10 稳定性迭代）

> 该扩展项目（`D:\DSH\dsh-web-gemini-ext`）**不在本仓库版本控制内**（非 git 目录）。
> 为可追溯，此文档记录本轮由主 agent 实施的改动、备份位置与生效条件。
> 原文件备份：`*.bak-wg-20260910-200057`（同目录）。

## 改动清单（按稳定性迭代 expr-2026-09-10_18-42-03）

### 1. `background.js`（Service Worker）
| 改动 | 原因 | 证据 |
|---|---|---|
| resp 三分支收敛：**无非空 answer 一律上报 `submit-error`**（区分 `resp.error` / `EMPTY_REPLY` / `NO_RESPONSE`） | 原实现在 `resp===null` 或 `answer` 为空时**既不上报也不报错** → bridge 任务永久 `processing`（16/16 历史任务无一成功的直接原因） | AutoIteration 实测 + `.invalid/` 现象；任务 t0001 |
| **`sendMessage` 加 70s 超时**（`Promise.race`） | Chrome `tabs.sendMessage` 的 Promise 在 content script 丢失/端口悬挂时可能**既不 resolve 也不 reject** → 原 `for` 循环永久 await（实测 t0001 claimed 后 132s 无终态，只能靠服务端 sweep 兜底） | 实测 2026-09-10（stab1_2） |
| token 401 自动重取重试 | 原 `ensureToken()` 缓存后永不刷新，`bridge.token` 轮换后永久 401 无自愈 | 代码走读 + 宿主侧已有 1h TTL 的对称缺口 |

### 2. `content.js`（页面脚本）
| 改动 | 原因 |
|---|---|
| `!input` 时 **throw**（原 `return ''`） | 静默失败：resolve 空串 → background 侧两个分支都不命中 → 任务泄漏 |
| 空回复时 **throw**（原直接把 `waitReply` 的空结果当成功答案） | 同上；`waitReply` 有硬兜底 `setTimeout(done, maxMs+5000)`，未捕获回复时同样 resolve 空串 |

### 3. `bridge-server.mjs`（本地桥接服务）
| 改动 | 原因 |
|---|---|
| `sweepTasks()`：**pending 超 60s 判 failed**（无人认领） | 扩展在「无 `gemini.google.com` 标签页」时不取任务（`pollOnce` 直接 return）→ 任务永久 pending，宿主白等 300s |
| `sweepTasks()`：**processing 超 120s 判 failed**（消费者未回传） | 防任务永久泄漏（实测 t0001 132s 被判定，error 含可诊断原因） |
| 保留期清理：done/failed 超 1h 从内存 Map 删除 | 原 `tasks` Map 只增不减（`/stats` total 持续增长，内存无界） |
| `/stats` 补 **`failed` 计数** | 原枚举遗漏 → 排查时只能靠 `total-pending-processing-done` 反推 |
| `/stats` 增**双活性指标**：`lastPollAt`/`pollCount`（轮询心跳）与 `lastClaimAt`/`claimCount`（真正认领任务） | 初版只统计后者且把**每次 `/next-task` 调用**都计入（扩展每秒轮询）→ 实测 9.5 分钟累计 299，无法区分"空闲轮询"与"取到任务" |

### 4. 生效条件
- `bridge-server.mjs` 改动：**已生效**（kill 后由 `bridge-watchdog` 5s 内自动拉起；实测自愈成功）
- `background.js` / `content.js` 改动：**需在 Chrome 重载扩展**（`chrome://extensions` → 刷新该扩展）+ 刷新 `gemini.google.com` 标签页

### 5. 外部依赖（排查首要项）
Chrome 中**必须存在 `https://gemini.google.com/*` 标签页**，否则扩展 `pollOnce` 直接返回、通道静默不可用。
判定信号：`/stats` 的 `lastPollAt` 停止更新（无轮询 = 无标签页）。

## 相关宿主侧配套（本仓库，已有版本控制）
- `lib/bridge-poll.js`：`classifyBridgeTask` — failed 立即失败 / processing 超 90s stalled / **pending 超 60s unavailable**（三层早退，不白等超时）
- `lib/index.js webGeminiAsk`：接入上述判定（记录 `processingSince`/`pendingSince`）
- 测试：`test/bridge-poll.test.js`（16 用例）
