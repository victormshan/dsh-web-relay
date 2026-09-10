# web-gemini 桥接链路诊断与修复（2026-09-10）

> 出处：混合架构 cc 任务 `wg-gap-analysis`（Claude Code kind=understand，2026-09-10T11:51-11:59Z，exit 0）
> 触发：主 agent 端到端探活实测发现 web-gemini 通道「扩展在线但任务永不完成」（16/16 历史任务无一成功；processing 190s+ 无终态；AutoIteration V5/V6 两次 /ask 各白等 300s）
> 评审：主 agent 独立诊断（getInput return '' → resp.answer 空 → background else 只打日志 → 任务泄漏）与 Claude 分析**结论一致**，构成双盲交叉验证；主 agent 另核对了 background.js 原实现的 v2.3-1 else 分支（确实存在但仅 console.warn 不 submit-error）
> 落地：P0 background.js（resp 三分支收敛 + token 401 自愈）+ content.js 两处 throw 补丁已合入 D:\DSH\dsh-web-gemini-ext（原文件已 .bak 备份）；P1 bridge-server.mjs（processing 120s 超时兜底 + done/failed 保留期清理 + /stats 补 failed 计数）已合入并重启验证
> 生效条件：扩展侧改动需在 Chrome 重载扩展（chrome://extensions → 刷新）+ 刷新 gemini.google.com 标签页

## 主 agent 侧配套修复（本仓库）

宿主 `lib/index.js webGeminiAsk` 原实现只认 `status === 'done'`，遇 failed/泄漏只能死等满 300s。
已新增 `lib/bridge-poll.js`（`classifyBridgeTask` 纯函数）：failed → 立即失败携带扩展诊断；
processing 超 `BRIDGE_STALL_MS`（默认 90s，content waitReply 60s+5s 之上留余量）→ stalled 提前失败；
其余 → waiting。测试 `test/bridge-poll.test.js` 11 例。

---

# web-gemini 桥接链路代码问题分析

调查范围（均已实际读取全文）：
- 宿主侧：`/mnt/d/dsh-web-relay/lib/index.js`（`webGeminiAsk` L881-912、`bridgeHeaders`/`getBridgeToken` L862-880、askHandler `provider==='web-gemini'` 分支 L1989-2014、`gemini-free` 降级分支 L1958-1988、Swarm 评审调用 L3070-3084、审核降级链调用 L3105-3144 等）
- 宿主侧判定：`/mnt/d/dsh-web-relay/lib/bridge-poll.js`（`classifyBridgeTask`，全文 61 行，**仅评审，不改**）
- 桥接服务：`/mnt/d/DSH/dsh-web-gemini-ext/bridge-server.mjs`（全文 146 行）
- 扩展 SW：`/mnt/d/DSH/dsh-web-gemini-ext/background.js`（全文 179 行）
- 页面脚本：`/mnt/d/DSH/dsh-web-gemini-ext/content.js`（全文 350 行）
- `manifest.json` / `README.md` / `docs/CC-HYBRID.md` 用于确认部署拓扑与既有降级策略文档，无代码问题。

---

## Q1：任务泄漏根因

### 问题 1.1（核心根因）【严重｜高优先级】

**现象**：Chrome 扩展在线、能在 3s 内取到任务（pending→processing），但任务此后永久停在 processing，从不转 done/failed；宿主侧只能死等到 300s 超时。

**代码位置**：`dsh-web-gemini-ext/background.js` L86-115（核心是 L111-115 的 `else` 分支）

```js
let resp = null
for (let attempt = 0; attempt < 4 && resp === null; attempt++) { ... }
if (resp && resp.answer) {
  ...submit-answer...
} else if (resp && resp.error) {
  ...submit-error...
} else {
  // v2.3-1: 该标签页不可用（content script 未注入/页面卡死）→ 记录活跃度（下次选别的）并告警
  tabActivity.set(target.id, Date.now())
  console.warn('[web-gemini] 任务', d.task.id, '处理未返回答案（Tab ' + target.id + ' content script 可能未注入，请刷新 Gemini 标签页）')
}
```

**根因**：三分支判定只覆盖了 `resp.answer` 非空、`resp.error` 非空两种情况。但实际会落入第三个 `else` 分支的，**不止「resp === null」一种场景**，至少还包括：

- `resp === null`：4 次 `chrome.tabs.sendMessage` 全部失败（`.catch(() => null)`，见 L93）——content script 未注入/端口未就绪/页面崩溃。
- `resp = { answer: '' }`：content.js 的 `handleTask` **正常 resolve 但返回空字符串**（见 Q2 问题 2.1/2.2），此时 `resp` 为真值对象，但 `resp.answer` 和 `resp.error` 都是 falsy（空串/undefined），同样落入 `else`。

无论哪种，`else` 分支只打印 `console.warn`，**从不调用 `/submit-error`**（也不调用 `/submit-answer`）。而 bridge-server 的任务状态机里，一个任务一旦被 `/next-task` 置为 `processing`（`bridge-server.mjs` L96），此后只有 `/submit-answer` 或 `/submit-error` 两个端点能把它转成终态——没有人调用，任务永久卡在 `processing`，这就是「16 个历史任务全部既非 pending/processing/done」（即全部落在未被 `/stats` 统计的 `failed` 桶，或部分仍挂在 `processing` 里，取决于具体失败路径）的直接原因。

**优化方案（高优先级，已在 `out/background.js` 中修复）**：把三分支收敛为两分支——只要没有拿到非空 `answer`，一律上报 `/submit-error`（区分 `resp===null`/`resp.error` 存在/`resp.answer` 为空三种情况生成不同诊断文案），彻底消灭“既不 submit-answer 也不 submit-error”的第三态。

### 问题 1.2（Map 无过期清理/无上限）【中优先级】

**现象**：`/stats` 显示 `total=16`，说明桥接服务把每个任务永久留在内存里。

**代码位置**：`bridge-server.mjs` L43（`const tasks = new Map()`）、全文搜索确认无任何 `tasks.delete(...)` 调用，也无容量上限判断。

**根因**：`tasks` 是纯内存 `Map`，`create-task` 只增不减，`submit-answer`/`submit-error` 只改状态不做清理，进程常驻（配合 `bridge-watchdog.mjs` 崩溃自愈）意味着 Map 会无限增长，长期运行会造成内存缓慢泄漏；且历史任务永远占用 `/task-result/:id` 命名空间，无法区分“刚失败”和“三天前失败”的任务。

**优化方案（中优先级，见 `out/bridge-server-patch.md`）**：加一个定时清理（sweep），对 `done`/`failed` 超过保留期（如 1 小时）的任务从 Map 里删除。

### 问题 1.3（乐观 claim + 无 stale-processing 重新入队，注释与实现不一致）【中优先级】

**现象**：多 Tab/单 Tab 场景下，任务被 `/next-task` claim 之后，如果分发失败（sendMessage 4 次全败，或 content.js 侧失败），任务已经是 `processing`，却没有任何“退回 pending 重试”的机制。

**代码位置**：`bridge-server.mjs` L89-99：

```js
if (req.method === 'GET' && url.pathname === '/next-task') {
  // 找最早 pending 任务（同 id 幂等：processing 任务若上次未完成可重取）
  let picked = null
  for (const t of tasks.values()) {
    if (t.status === 'pending') { picked = t; break }
  }
  if (!picked) return json(res, 200, { ok: true, task: null })
  picked.status = 'processing'
  picked.claimedAt = new Date().toISOString()
  return json(res, 200, { ok: true, task: { id: picked.id, prompt: picked.prompt } })
}
```

**根因**：注释写的“processing 任务若上次未完成可重取”**在代码里并未实现**——过滤条件只有 `t.status === 'pending'`，从不检查 stale `processing`。这是文档（注释）与实现之间的漂移，容易误导后来者以为已有重试保护。结合问题 1.1，claim 是“乐观”的：`/next-task` 一旦返回任务就立刻标记 processing，不等待/不确认 content script 真的能处理它；如果后续分发失败又没有终态上报（问题 1.1），任务就是“分发后无人认领”的典型泄漏。

多 Tab 场景本身（`pickIdleTab`/`tabActivity`，`background.js` L49-60）在**单个扩展实例内**没有并发竞态——`pollOnce` 有 `polling` 重入锁（L63-64），且是单线程 `setTimeout` 自调度循环，同一时刻只处理一个任务，`tabActivity` 的读写不会并发冲突。真正的风险点不是“竞态”，而是：`chrome.tabs.query` 到 `chrome.tabs.sendMessage` 之间存在 TOCTOU 窗口（标签页可能在这期间被用户关闭/跳转），叠加问题 1.1 的静默失败，就会表现为“分发后无人认领”。

**优化方案（中优先级，可选）**：结合问题 1.1 的修复后，此问题的严重度已大幅降低（分发失败会正确终态化为 failed，不再无限期挂起）；如需进一步加固，可在 `bridge-server.mjs` 增加服务端 `processing` 超时兜底（见 `out/bridge-server-patch.md`），作为“即使没有任何消费者在轮询/或扩展本身挂掉”场景下的最后防线。不建议实现“stale processing 自动退回 pending 重新分发”——同一个坏 Tab 大概率会重复失败，自动重试价值低且可能与终态兜底逻辑打架，优先级降为 P2，仅记录待评估。

---

## Q2：失败不可见（content.js 静默失败路径）

### 问题 2.1【严重｜高优先级】

**现象**：`content.js` 的 `handleTask` 在“未找到输入框”时不抛异常，而是直接 `return ''`。

**代码位置**：`content.js` L285-286

```js
const input = getInput()
if (!input) { console.error('[web-gemini] 未找到输入框'); return '' }
```

**根因**：`handleTask(...).then((answer) => sendResponse({ answer }))`（`content.js` L339-343）——只要 `handleTask` 是 resolve（不管返回值是什么），background 收到的就是 `{ answer: '' }`，`resp.answer` 是空串（falsy），`resp.error` 是 `undefined`，两个分支都不命中，直接掉进 `background.js` 问题 1.1 描述的那个“只打日志”的 `else` 分支——**这是一条完全静默的失败路径**：没有 `throw`、没有 `error` 字段、日志只在 content script 自己的 DevTools 控制台（用户很少主动打开 Gemini 页面的 console），宿主侧和桥接服务对此一无所知。这是「页面未登录/未就绪」场景的典型表现——未登录时 `gemini.google.com` 通常没有可编辑的输入框，`getInput()` 直接返回 `null`。

**优化方案（高优先级，见 `out/content-fixes.md` 补丁 1）**：`!input` 时 `throw new Error(...)` 而不是 `return ''`，让 `.catch()` 正确捕获并把诊断信息带进 `resp.error`。

### 问题 2.2【严重｜高优先级】

**现象**：即使输入框和发送按钮都正常，回复抓取失败（选择器未命中/页面无新增内容）时同样静默返回空串。

**代码位置**：`content.js` L332-334

```js
const answer = await waitReply(60000, baseCount, beforePageText, task.prompt)
console.log('[web-gemini] 任务', task.id, '回复完成, 长度', answer.length, ...)
return answer
```

**根因**：`waitReply` 内部有一个硬性兜底 `setTimeout(() => { done() }, maxMs + 5000)`（`content.js` L225），无论有没有真正捕获到回复文本都会 resolve（可能是空串，见 `grabReply`/`addedPageText` 在选择器未命中且页面文本比对失败时返回 `''`）。`handleTask` 对此不做任何校验，直接把空串当「成功」返回。这条路径同样会导致 `resp = { answer: '' }`，在 background.js 侧被静默吞掉。**这正是主 agent 实测「processing 190s+ 无终态」最可能的根因之一**：Gemini 页面可能因为 DOM 结构变化（选择器漂移）、生成极慢、或页面卡死等原因导致 65s 内确实拿不到有效回复文本，content script 如期在 65s 内 resolve，但 resolve 的是空答案，而不是错误——链路上没有任何一层把“resolve 了但没内容”当作失败处理。

**优化方案（高优先级，见 `out/content-fixes.md` 补丁 2）**：`waitReply` 返回空结果时 `throw`，而不是当作正常答案返回。

### 问题 2.3（`setInputValue` 静默失败但有下游兜底）【低优先级，仅记录】

**代码位置**：`content.js` L66-97

**现象/根因**：`setInputValue` 对 contenteditable 元素尝试 paste 事件模拟 → clipboard API → `execCommand('insertText')` 三级兜底，但无论哪级实际生效与否都返回 `true`（不校验最终内容是否等于目标文本）。如果三种方式都被页面 CSP/权限策略拦截，输入框会保持空白，但 `handleTask` 不会立即察觉。

**为什么不需要单独修复**：`handleTask` 后续有“发送确认”逻辑（L314-330，检测输入框发送后是否清空，不清空则重试/抛 `SEND_FAIL`），且发送空 prompt 后 Gemini 大概率不会产生新回复，会走到问题 2.2 描述的“空回复”路径。在补丁 1/2 落地后，这条隐藏失败最终也会被“回复为空则 throw”这一道统一终态检查兜住，不需要在 `setInputValue` 内部额外插桩。**这是本次补丁设计的核心思路：把 content.js 的成功判定收敛为单一不变式——`handleTask` 要么 resolve 一个非空 `answer`，要么 throw，不允许第三态**，从而不必逐一枚举 DOM 层面的所有失败原因。

### 问题 2.4（诊断粒度不足）【低优先级】

**现象**：修复后 `EMPTY_REPLY`/`INPUT_NOT_FOUND` 这类诊断信息虽然能让任务正确转入 `failed`，但相比 `SEND_FAIL` 分支（`content.js` L322-329，带输入框类型/按钮状态/残留文本等详细现场信息），信息量偏少，后续人工排查“到底是没登录还是选择器过期”时还需要看 content script 自身的 console 日志。

**优化方案（低优先级，`out/content-fixes.md` 已采纳）**：诊断文案里带上关键上下文（页面 URL、`document.readyState`、是否存在任意 `contenteditable`/`textarea` 节点等），便于宿主侧日志直接定位问题类别，无需回头翻 DevTools。

---

## Q3：状态机健壮性

### 问题 3.1（无服务端超时终态，依赖消费者自己判定）【中优先级】

**现象**：`bridge-server.mjs` 的状态机只有 `pending → processing → {done|failed}` 四态，一旦卡在 `processing`，服务端自己永远不会主动结束它——必须靠**外部消费者**（宿主 `webGeminiAsk`）自行判断超时/停滞。这次事故里，宿主侧原实现只认 `status==='done'`，于是白等 300s；即便有了 `bridge-poll.js` 的 90s 停滞早退，那也只是**客户端兜底**，服务端状态本身依然是脏的 `processing`（问题 1.2/1.3 的成因）。

**代码位置**：`bridge-server.mjs` 全文搜索确认没有任何 `setInterval`/`setTimeout` 做状态扫描。

**根因**：状态终结的责任被完全下放给了轮询消费者，服务端不做兜底；一旦某次消费者提前放弃轮询（例如宿主进程重启、请求异常中断），这个 `processing` 任务就会**永久**卡住，无法通过任何机制自愈——只能靠 `bridge-watchdog.mjs` 整体重启服务器（内存 Map 清零）来间接“清理”。

**优化方案（中优先级，见 `out/bridge-server-patch.md`）**：服务端自身加一个周期性 sweep，对 `processing` 超过阈值（建议 120s，见 Q4 的余量分析）的任务主动标记为 `failed`（带“server 端超时兜底”诊断），使状态机自身闭环，不依赖任何特定消费者的行为。

### 问题 3.2（`/stats` 不含 `failed` 计数，排查困难）【中优先级】

**现象**：主 agent 只能通过 `total - pending - processing - done` **反推**出 16 个任务全部失败，`/stats` 本身给不出直接证据。

**代码位置**：`bridge-server.mjs` L128-134

```js
if (req.method === 'GET' && url.pathname === '/stats') {
  return json(res, 200, { ok: true, total: tasks.size, byStatus: {
    pending: [...tasks.values()].filter((t) => t.status === 'pending').length,
    processing: [...tasks.values()].filter((t) => t.status === 'processing').length,
    done: [...tasks.values()].filter((t) => t.status === 'done').length
  } })
}
```

**根因**：`byStatus` 枚举漏了 `failed`（代码里明明已经支持 `t.status === 'failed'`，见 `/submit-error` 实现 L111-119），纯属遗漏，不是设计选择。

**优化方案（中优先级，见 `out/bridge-server-patch.md`）**：`byStatus` 补上 `failed` 字段（如果采纳问题 3.1 的服务端超时兜底，`failed` 桶会同时包含“扩展主动上报的失败”和“服务端超时判定的失败”，建议诊断文案里保留区分度，不需要额外状态位）。

---

## Q4：宿主侧判定（`bridge-poll.js`）完备性评审

> 本节仅评审，不修改 `bridge-poll.js`。

### 4.1 语义基本完备，但对“task 丢失”场景处理保守（有误判风险，但方向安全）【低优先级，仅记录】

**现象**：如果 bridge-server 中途重启（如被 `bridge-watchdog.mjs` 拉起），内存 `Map` 清零，宿主此时对一个已存在 taskId 发起 `/task-result/:id` 会收到 `404 { ok:false, error:'task not found' }`。

**代码位置**：`lib/index.js` L900-902 与 `bridge-poll.js` L35（`if (!task || typeof task !== 'object') return { state: 'waiting' }`）

**根因**：`lib/index.js` 里 `const task = td && td.ok ? td.task : null`——404 响应体本身仍是合法 JSON（`{ok:false,...}`），`td.ok` 为 `false` 时 `task` 被置为 `null`，传入 `classifyBridgeTask(null, ...)` 直接返回 `{ state: 'waiting' }`。也就是说“bridge 重启丢任务”和“任务确实还没被处理”在当前判定语义下**无法区分**，都会让宿主继续傻等到完整的 300s 超时，才因为 `deadline` 到期给出一个笼统的“bridge 超时”提示。

**是否是误判**：不是错误判定（不会误报成功/误判失败），只是**丢失场景下反应偏慢、诊断信息不够精确**——300s 满超时 vs 能不能提前区分“task not found（多半是 bridge 重启）”。由于这是纯函数的输入契约问题（调用方在 task 丢失时应该能传入更精确的信号，而不是简单地传 `null`），且题面要求不修改 `bridge-poll.js`，这里只记录、不动手：如果未来要处理，建议由 `lib/index.js` 调用点区分 HTTP 404 与网络异常，向 `classifyBridgeTask` 传入一个显式的 `{ notFound: true }` 信号，由纯函数增加一个 `lost` 终态分支。

### 4.2 `stallMs=90s` 的余量分析【低优先级，仅记录，建议维持现状】

**现象/根因**：结合本次实测的 content.js 时序链路：
- `background.js` 分发重试：最多 4 次 `sendMessage`，前 3 次失败各等 2000ms → 最坏 ~6s 额外开销（L87-94）。
- `content.js` `handleTask` 自身开销：`setInputValue` 后 400ms 校验 + 发送确认 1500ms（+ 失败重试再 1000ms）≈ 最坏 ~3s（L292、L315、L320）。
- `waitReply(60000, ...)` 硬上限 60s + 兜底 `setTimeout(..., maxMs+5000)` = 65s（`content.js` L172-226）。

**保守合计**：从 bridge 标记 `processing` 到 content script 理论上最迟必须给出终态（无论成功/失败）大约是 `6s + 3s + 65s ≈ 74s`。90s 阈值留了约 16s 余量，基本合理，但余量不算宽裕：

- 如果 `chrome.tabs.update`/`chrome.windows.update`（激活标签页/窗口，`background.js` L84、L90）在系统负载高、窗口被最小化等场景下变慢（这两个 API 调用没有自身超时保护），可能进一步压缩余量；
- 宿主自身的测量误差（`processingSince` 是宿主轮询发现 `processing` 状态时才落笔，比服务端真实 claim 时间晚最多一个轮询间隔 3s + 扩展轮询间隔 1s ≈ 4s）会让宿主认为“流逝时间”略短于真实值，方向上是**偏保守**（不会提前误判 stalled），但也意味着 90s 的名义阈值实际对应的“content 侧真实耗时容忍度”比 90s 略小。

**结论**：不建议现在改 `stallMs`（本次评审的既有实测数据支持 90s 够用，且方向性误差是安全的——不会出现“Gemini 页面正常但回复慢”被误杀的典型场景，因为 `waitReply` 本身硬上限就是 65s，不存在“content 侧还在合理等待、宿主却先超时”的情况）。如果未来观察到误判（例如网络延迟大的机器），建议先做的不是调大 `stallMs`，而是给 `chrome.tabs.update`/`windows.update` 加超时保护——这才是当前余量里最大的不确定项。

---

## Q5：其他发现的问题

### 问题 5.1（扩展侧 bridge token 永不自动刷新，401 后死锁）【中优先级，已在 `out/background.js` 修复】

**现象**：宿主侧 `getBridgeToken()`（`lib/index.js` L864-876）有 1 小时 TTL，会定期重取 token；但扩展侧对称逻辑缺失。

**代码位置**：`background.js` L31-38

```js
async function ensureToken() {
  if (bridgeToken) return bridgeToken
  try {
    const t = await (await fetch(BRIDGE + '/__token')).json()
    bridgeToken = (t && t.token) || ''
  } catch { /* 仍不可达 */ }
  return bridgeToken
}
```

**根因**：`ensureToken()` 只在 `bridgeToken` 为空串时才重新拉取。一旦成功缓存过一次 token，就**永远不会再刷新**——如果 `bridge.token` 文件被删除/bridge 换目录重装导致 token 轮换（`bridge-server.mjs` L31-40 的 `loadToken()` 在文件缺失时会生成新 token），扩展会持续用旧 token 请求，所有业务端点返回 401（`bridge-server.mjs` L78），且没有任何自愈路径，只能人工刷新 Gemini 标签页重载扩展。

**优化方案（中优先级，已采纳进 `out/background.js`）**：`bridgeFetch` 收到 401 响应时，清空缓存并重取一次 token 再重试一次，与宿主侧的自愈能力对齐。这是一个自包含的小改动，不引入新依赖、不改消息协议字段。

### 问题 5.2（内存队列无持久化，进程重启=全量任务丢失）【低优先级，仅记录】

**现象/根因**：`tasks` 纯内存 `Map`（`bridge-server.mjs` L43），配合 `bridge-watchdog.mjs` 的崩溃自愈——每次重启都会清空所有历史任务与进行中任务的状态，且不落盘、不写日志文件，事后无法追溯某个具体任务失败的完整时间线（只能看 `console.log`/`console.warn`，如果没有重定向到文件，连这些也会随进程重启丢失）。

**优化方案（低优先级，超出本次“最小改动集”范围，仅记录）**：如需要长期可观测性，可以在 `submit-answer`/`submit-error` 时 append 一行到本地日志文件（JSON Lines），不改变内存状态机语义，纯旁路记录。

### 问题 5.3（并发任务在 Gemini 侧天然串行，非 bug 但需知悉）【信息记录，无需改动】

**现象**：`lib/index.js` 的 batchStepIds 受控并发审核（默认并发 2，`BATCH_REVIEW_CONCURRENCY`）会让多个 `webGeminiAsk` 并发发起 `create-task`；但 `background.js` 的 `pollOnce` 是单线程 `setTimeout` 自调度循环（`polling` 重入锁，L63-64），同一时刻只处理一个任务——多个并发创建的 bridge 任务会在同一个 Gemini 标签页里排队串行处理（多 Tab 场景下才能真正并行）。

**结论**：这是预期行为（Gemini 网页对话本身就是单线程交互），不是缺陷，只是需要在容量规划时知悉：并发审核数不代表 Gemini 侧真实并行度，真实并行度取决于打开的 Gemini 标签页数量。

---

## 建议的最小改动集

### 必修（P0，已产出对应文件，建议尽快合入）

1. **`background.js` resp 判定收敛**（`out/background.js`）——修复 resp===null / 空 answer 的任务泄漏，这是本次事故（16/16 失败、190s+ 无终态）的直接根因，收益最大、改动面最小（一个 if/else 块）。
2. **`content.js` 两处静默失败改为 throw**（`out/content-fixes.md`）——`!input` 与 `!answer` 两个分支，是问题 1 能够修复彻底的前提（否则 background 端拿到的仍是「resolve 但空」而非「reject 带诊断」，诊断质量差）。

### 可选（P1，建议本迭代或下迭代跟进）

3. **`bridge-server.mjs` 服务端超时兜底 + `/stats` 补 `failed` 计数 + 历史任务清理**（`out/bridge-server-patch.md`）——防御纵深：即使未来 background.js 再引入类似缺口，服务端也能自愈；同时解决内存无界增长和排查可观测性问题。
4. **`background.js` token 401 自动重取**（已内置于 `out/background.js`，与 P0 属同一文件的低风险追加改动）。

### 可选（P2，仅记录，暂不建议动手）

5. `bridge-server.mjs` `/next-task` 注释与实现不一致（stale-processing 重取语义未实现）——建议仅修正注释描述现状，或等 P1 服务端超时兜底上线后观察是否还有必要做“重新入队”；两者功能有重叠，不建议同时做。
6. `bridge-poll.js` 对 `task not found`（bridge 重启丢任务）与“尚未开始”一视同仁——影响面小（只影响诊断速度，不影响正确性），且题面要求不改该文件，留档即可。
7. `stallMs=90s` 维持现状；如未来需要调整，优先给 `chrome.tabs.update`/`windows.update` 加超时保护，而不是直接调大阈值。
