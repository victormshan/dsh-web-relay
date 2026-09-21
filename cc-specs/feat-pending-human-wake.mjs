// 功能：把「链条停下等人」变成**能叫醒主 agent** 的信号通路（补齐人工缺席下的自动演化缺口）。
//
// 背景（2026-09-18 实测缺口，主 agent 已取证）：
//   · cc 链条在护栏触发时 `已连续失败 3 次（上限 3）→ 停止链条并等人处理`，之后**没有任何机制**去叫醒主 agent；
//     主 agent 之所以回来复核，是因为人问了一句。护栏防住了 25 次重派，代价是"必须有人来看"。
//   · 插件现有两条续跑机制（bootResumeScan 事件驱动 + 心跳 15 分钟）都只续
//     web-relay/experiments/*.steps.json 里"忙"的计划步（isExprInterrupted = busy && crossBoot），
//     表达不了"链条停下等人"——它不是计划步。
//   · 链条侧已完成：cc-chain.mjs 会在三种"真需要人"的情形写
//     D:\cc-tasks\chain-needs-human.json（reason ∈ too-many-attempts / instrument-error / review-needed），
//     并且**不会**为"额度耗尽"这类设计内行为写信号（防止每次配额暂停都吵醒主 agent）。
// 本任务补插件侧的**读 + 唤醒 + 可观测**。
//
// 外部验收探针（仓库侧，链条用它）：probes/pending-human-repo-accept.mjs
//   真 import lib/pending-human.mjs 调纯函数 + 校验接线与契约，**当场可判、无需交付重启**。
// 实测基线：修复前 **1/7 FAIL**（模块与接线都不存在）。
// 另有实机探针 probes/pending-human-accept.mjs（打 /admin/heartbeat-check + /health-check，基线 6/10 FAIL），
//   它读的是**运行中的宿主**，必须交付+重启后才有意义 —— 由主 agent 在交付后运行，故**不**作为本任务的 acceptanceScript
//   （否则会因"验收发生在交付之前"这一顺序问题把正确实现判失败）。
export const task = {
  taskId: 'ccfeat-20260918-pendinghuman',
  kind: 'implement',
  title: '插件侧：读取「需要人介入」信号并在 boot/心跳时唤醒主 agent（/health-check 暴露 pendingHuman）',
  refs: ['lib/index.js', 'lib/selfcheck.mjs'],
  acceptanceScript: 'probes/pending-human-repo-accept.mjs',
  anchors: [
    { file: 'lib/index.js', pattern: 'function resumeScanBases', note: 'boot 扫描所在区域（boot 路径需在同一批次里读该信号）' },
    { file: 'lib/index.js', pattern: 'const adminHeartbeatHandler', note: '心跳入口 handler（/admin/heartbeat-check）——周期路径需在此触发判定' },
    { file: 'lib/index.js', pattern: 'async function wakeMainAgent', note: '唤醒通路（复用，不要新造唤醒机制）' },
    { file: 'lib/index.js', pattern: 'const CC_TASKS_ROOT = resolveTasksRoot(process.env)', note: 'cc-tasks 根：信号文件路径必须由它派生（不要硬编码 D:\\cc-tasks）' },
    { file: 'lib/selfcheck.mjs', pattern: 'export const SELFCHECK_REQUIRED_HEALTH_FIELDS', note: '字段契约清单——增列 pendingHuman' },
  ],
  acceptance:
    '新增 lib/pending-human.mjs（**纯函数**，便于两侧自检）：'
    + '① parsePendingHuman(rawText) → { ok, entry|null, error }，容错 BOM/坏 JSON/缺 id|chainId|reason，**绝不抛**；'
    + '② decidePendingHuman(entry, { notifiedIds }) → { decision: "wake"|"would-wake"|"none", reason }，规则：'
    + 'entry 无效或 acknowledgedAt 非空 → none；id 已在 notifiedIds 里 → none（去重）；entry.dryRun===true → would-wake；否则 wake；'
    + '③ pendingHandoffText(entry) → 唤醒用的交接文本（含 chainId、reason、taskId、detail 与"下一步建议"）。'
    + 'lib/index.js 接线：'
    + '④ 信号路径由既有 CC_TASKS_ROOT 派生（CC_TASKS_ROOT/chain-needs-human.json），**不得硬编码 D:\\cc-tasks**；'
    + '⑤ **boot 路径**（与 bootResumeScan 同批次、异步、不阻断路由注册、try/catch 全包）读一次并判定；'
    + '⑥ **心跳路径**：heartbeatTick() 内同样判定一次（周期 15 分钟）；'
    + '⑦ 进程内按 entry.id 去重（同一 id 只唤醒一次）；跨重启允许重新唤醒一次（boot 扫描语义）；'
    + '⑧ 唤醒复用既有 wakeMainAgent({ sessionId, handoffText })；sessionId 取 process.env.DSH_SESSION_ID（无则**不唤醒**、只记录）；'
    + '⑨ /health-check 暴露 **pendingHuman** 字段（无信号时为 null），形状必须精确为：'
    + '{ id, chainId, reason, decision, notifiedAt, actuallyWoken, duplicateSuppressed, error }；'
    + '   · decision ∈ "wake" | "would-wake" | "none"；actuallyWoken 为布尔；同一条目第二次判定必须 duplicateSuppressed:true；'
    + '   · 该字段**必须始终存在**（哪怕 null）——探针与自检都读它；'
    + '⑩ /admin/heartbeat-check 的响应体也带上 pendingHuman（便于探针在一次请求里拿到判定）；'
    + '⑪ lib/selfcheck.mjs 的 SELFCHECK_REQUIRED_HEALTH_FIELDS 增列 pendingHuman；'
    + '⑫ 新增用例 ≥6（纯函数：无效条目/已销账/去重/dryRun/正常四类 + handoff 文本非空）；'
    + 'node --check 通过；排除 test/shadow-gate.test.js 后全量 0 失败；verify-files-coverage 通过；改动文件 LF/无 BOM；'
    + '仅改 lib/index.js、lib/selfcheck.mjs（新增 lib/pending-human.mjs）',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务补一条**唤醒通路**，让"链条停下等人"能自动叫醒主 agent。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【要解决的问题（主 agent 已取证）】
cc 链条在护栏触发时（单项连续失败达上限 / 验收器自身出错 / 跑完待收口）会停下等人，并且**链条侧已经**写好信号文件：
  D:\\cc-tasks\\chain-needs-human.json
形状（链条侧已实现，勿改）：
  { id, chainId, reason, taskId, detail, lastVerdict, attempts, at, acknowledgedAt, ackNote, dryRun? }
  reason ∈ 'too-many-attempts' | 'instrument-error' | 'review-needed'
但**插件侧从不读它**：现有两条续跑机制（bootResumeScan + 心跳）只续 web-relay/experiments/*.steps.json 里"忙"的计划步，
所以链条停住后没有任何东西叫醒主 agent（实测：停住后一直静默，直到人问了一句）。

【硬性要求 1：新增 lib/pending-human.mjs —— 纯函数（便于两侧自检，不要在里面做 IO/唤醒）】
① parsePendingHuman(rawText) → { ok, entry|null, error }
   · 容错：BOM、坏 JSON、缺 id/chainId/reason → { ok:false, ... }；**绝不抛异常**（boot 路径必须 fail-open）。
② decidePendingHuman(entry, { notifiedIds }) → { decision, reason }
   · decision ∈ 'wake' | 'would-wake' | 'none'
   · entry 为空/无效 → none；entry.acknowledgedAt 非空 → none（已销账）；
   · entry.id 已在 notifiedIds（Set 或数组）里 → none（去重，reason 说明是重复）；
   · entry.dryRun === true → 'would-wake'（**判定为需要唤醒但不真的唤醒**——验收探针用它空跑，避免顺手打断主 agent）；
   · 其余 → 'wake'。
③ pendingHandoffText(entry) → string：给主 agent 的交接文本，至少含 chainId、reason、taskId、detail，
   并说明"这是链条停下等你的信号，请复核后处理并销账（acknowledgeHumanSignal）"。

【硬性要求 2：lib/index.js 接线】
④ 信号路径**由既有 CC_TASKS_ROOT 派生**（path.join(CC_TASKS_ROOT, 'chain-needs-human.json')），**不要硬编码** D:\\cc-tasks。
⑤ **boot 路径**：与 bootResumeScan 同一批次（宿主启动时、异步、不阻断路由注册、整体 try/catch）读一次并判定。
⑥ **心跳路径**：在 heartbeatTick() 里也判定一次（心跳周期既有 15 分钟）。
⑦ 进程内按 entry.id 去重：同一 id 只唤醒一次；宿主重启后允许重新唤醒一次（与 boot 扫描语义一致）。
⑧ 唤醒**复用既有** wakeMainAgent({ sessionId, handoffText })；sessionId 取 process.env.DSH_SESSION_ID；
   **没有 sessionId 时不唤醒**，只记录（actuallyWoken=false，error/reason 说明原因）。
   dryRun 条目：decision='would-wake' 且**不得**调用 wakeMainAgent。

【硬性要求 3：可观测（探针与自检都读这些，形状必须精确）】
⑨ /health-check 暴露 pendingHuman 字段，**始终存在**（无信号时为 null）。有信号时形状精确为：
   { id, chainId, reason, decision, notifiedAt, actuallyWoken, duplicateSuppressed, error }
   · decision ∈ 'wake' | 'would-wake' | 'none'
   · actuallyWoken：本次是否真的调用了唤醒（dryRun / 无 sessionId → false）
   · duplicateSuppressed：若本次因"同 id 已通知过"而抑制 → true，否则 false
   · error：解析/唤醒失败原因，否则 null
⑩ /admin/heartbeat-check 的响应体也带上 pendingHuman（探针在一次请求里就能拿到判定）。
⑪ lib/selfcheck.mjs 的 SELFCHECK_REQUIRED_HEALTH_FIELDS 增列 'pendingHuman'（装一半会被重启自检抓出）。

【行为边界（别扩大）】
- **不要**为"额度耗尽"之类的设计内行为唤醒；不要新增端点；不要改链条侧文件；不要动既有续跑语义（resumeAction 等）。
- 一切"读到坏文件/唤醒失败"都必须 fail-open：不得让启动或心跳抛异常、不得影响 /health-check 既有字段。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/lib/selfcheck.mjs
- /mnt/d/dsh-web-relay/lib/pending-human.mjs（新增）
- /mnt/d/dsh-web-relay/test/pending-human.test.js（新增）
其它文件一律不得改动。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 全部改动文件通过；
② 新增用例 ≥6（覆盖：无效条目 / 已销账 / 同 id 去重 / dryRun → would-wake / 正常 → wake / handoff 文本非空且含 chainId）；
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单；该文件在 WSL 下有 3 项已知环境差异，不要"修"它）；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：纯函数签名与规则表、boot/心跳两处接线位置（贴出关键行）、pendingHuman 的完整形状、
   去重与 dryRun 的处理、以及"为什么不会吵醒主 agent"的边界说明（哪些情形刻意不唤醒）。
⑧ 冒烟自证（**必须做**）：仓库侧已有验收探针 probes/pending-human-repo-accept.mjs，请运行
   ⁠node /mnt/d/dsh-web-relay/probes/pending-human-repo-accept.mjs⁠，把完整输出贴进报告。
   它真 import 你的 lib/pending-human.mjs 调纯函数，并校验接线/契约，**当场就能判定、不需要重启宿主**。
   另有实机探针 probes/pending-human-accept.mjs（打 /admin/heartbeat-check 与 /health-check），
   它读的是**运行中的宿主**、必须交付+重启后才有意义，因此**不要求**你运行它；若你运行了并看到
   "未接线/未交付重启"字样，请如实贴出并说明这是顺序原因，**不要**据此伪造结论。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
