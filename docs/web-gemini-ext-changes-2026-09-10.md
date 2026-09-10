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

---

# v0.4.0：Chrome 侧稳定性加固（2026-09-10，expr-2026-09-10_20-29-05）

> 方案来源：三方协作征询（外部 AI，3 步 P0/P1 方案）；落地与实测由主 agent 完成。
> 背景：宿主侧兜底与可观测已到位（pending/processing 双早退、sweep、双活性指标），
> 但**通道可用性的真正瓶颈在 Chrome 侧**（标签页存在性、SW 被回收、页面态不可控）。

## 1. Tab 自动补建（P0）
`background.js` 的 `pollOnce` 查无 gemini 标签页时**不再静默 return**，改为每 30s 节流调用
`chrome.tabs.create({url:'https://gemini.google.com/app', active:false, pinned:true})`（后台 + pinned，
不抢焦点；失败静默下轮再试）。这是通道"静默不可用"的根治——此前无标签页 → 扩展不取任务 →
桥接任务永久 pending → 宿主只能靠 60s 早退感知（`/stats` 的 `pollCount` 停更是该状态表征）。

## 2. Offscreen 保活（P0）
- `manifest.json`：权限加 `offscreen`，版本 `0.3.0 → 0.4.0`
- 新增 `offscreen.html` / `offscreen.js`：唯一职责是 **20s 周期心跳**，使 MV3 Service Worker 持续
  被唤醒续期，避免被回收导致 1s 轮询停摆（原实现仅有 `chrome.alarms` ≥0.5min 兜底，粒度太粗）。
  **不做任何抓取/网络请求**（不与 content script 职责重叠，规避 offscreen 滥用风险）
- `background.js`：`ensureOffscreen()` 用 `chrome.offscreen.createDocument({reasons:['DOM_SCRAPING']})`
  创建（`hasDocument`/`getContexts` 双探测防重复；失败降级为 alarms 兜底并记 `offscreenFailed`；
  收到 `keepalive-ping` 时兜底重建）

## 3. 选择器降级链 + 页面预检 + reload 自愈（P1）
- `content.js` `getInput()` 重构为四级候选：语义属性（`contenteditable[role=textbox]`、`aria-label`
  含 prompt/message/输入/对话、`rich-textarea` 容器、`textarea[aria-label]`）→ 任意
  `contenteditable`/`textarea` 按 chat 语义过滤 → 可见性过滤 → 兜底最后一个
- 新增 `pageHealth()`：`isReady`（输入框命中）+ `authState`（OK/LOGGED_OUT/UNKNOWN，未就绪时按
  页面文本匹配 sign in/登录 特征）；经 `page-health` 消息同步返回，供 background 每轮轮询携带
- **reload 自愈**：`INPUT_NOT_FOUND`/`EMPTY_REPLY` 的 Error 带 `needsReload` 标记；background 按
  `tabReloadAt` 节流（同 Tab 60s 最多一次，防 reload 风暴）执行 `chrome.tabs.reload`；
  `NO_RESPONSE`（sendMessage 全失败/页面卡死）同样触发

## 4. 扩展健康上报 + Bridge 快速降级（P1，已实测）
- `bridge-server.mjs` 的 `/next-task` 接受 `authState=OK|LOGGED_OUT|UNKNOWN` 与 `isReady=1|0`，
  记录 `worker{authState,isReady,lastSeenAt}` 并在 `/stats` 暴露
- 上报"未登录/页面未就绪"时**立即**把 pending/processing 任务判 `failed`
  （`error='扩展侧不可用：…'`）→ 宿主侧 <3s 拿到失败并续降，**不再死等 60s/120s**
- **实测证据**：创建任务 t0001 → 调用 `/next-task?authState=LOGGED_OUT&isReady=0` → 任务立即
  `status=failed`、`error='扩展侧不可用：扩展上报未登录（gemini.google.com 未登录）'`；
  `/stats.worker` 记录 `{"authState":"LOGGED_OUT","isReady":false}` ✅

## 5. 生效条件与验证
**需在 `chrome://extensions` 重载扩展**（manifest 权限变更必须重载）；宿主侧**无需重启**。
验证清单：
1. 关闭所有 Gemini 标签页 → 30s 内应自动补建一个 pinned 后台标签页
2. 静置 5 分钟 → `/stats` 的 `pollCount` 仍持续增长（SW 未被回收）
3. 退出 Gemini 登录 → `/stats.worker.authState` 变为 `LOGGED_OUT`，此时创建的任务立即 failed
4. 制造页面异常 → 观察是否触发一次标签页 reload（60s 节流）
备份：改动前版本 `.bak-p1-20260911-044615`（background.js/content.js/bridge-server.mjs/manifest.json）

## 6. 本轮审核来源（三方协作实证）
- step 1（P0 Offscreen + Tab 补建）→ **external**（4.9s）
- step 2（P1 选择器降级 + reload 自愈）→ **claude-code**（164s）← cc 审核通道修复后**首次在真实任务中成功审核**（此前仅测试步 ccv2 90s；历史 13 例全 REJECT）
- step 3（P1 健康上报 + 快速降级）→ **external**（5.1s）
