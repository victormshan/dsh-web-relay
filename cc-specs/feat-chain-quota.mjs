// A5：配额感知抑制的**实效性修复**——A3 读的配额文件在链条停摆时不存在，导致抑制在该场景恒不生效
// 依据：_PLAN-low-risk-two.md 「A3 落地后的实效性缺陷」一节（含逐条实测证据）
export const task = {
  taskId: 'ccfeat-20260916-chainquota',
  kind: 'implement',
  title: '配额判定补链条来源：relay 同时读 chain-state.json 的 quotaResetsAt，使链条停摆时抑制真正生效',
  refs: ['lib/index.js', 'lib/heartbeat-scan.js', 'lib/cc-channel.js'],
  anchors: [
    { file: 'lib/index.js', pattern: 'const CC_TASKS_ROOT = resolveTasksRoot', note: 'cc-tasks 根目录（chain-state.json 与之同根）' },
    { file: 'lib/index.js', pattern: 'const CC_QUOTA_STATE_PATH', note: 'relay 侧配额状态路径（只有审核路径会写它）' },
    { file: 'lib/heartbeat-scan.js', pattern: 'export function shouldSuppressWake', note: 'A3 的严格抑制判定（不改其判据）' },
    { file: 'lib/cc-channel.js', pattern: 'export function shouldSkipForKnownQuotaExhaustion', note: 'relay 侧配额语义的权威实现——新纯函数必须与其一致（仅测试中 import 比对）' },
  ],
  acceptance:
    'lib/heartbeat-scan.js 新增纯函数 isQuotaWaiting({ relayQuotaState, chainState, now })：'
    + 'relay 侧（kind==="quota-exhausted" 且 resetsAt 可解析且 now < resetsAt）**或** 链条侧（chainState.quotaResetsAt 可解析且 now < resetsAt）任一成立即 true；'
    + '畸形/缺失一律 false 且不抛错；heartbeatTick 改为用该函数计算 quotaWaiting（同时读 relay 配额状态与 cc-tasks/chain-state.json），'
    + '从而让 A3 的抑制在**链条配额停摆**这一主场景下真正生效；'
    + '必须有一条测试断言新纯函数与既有 shouldSkipForKnownQuotaExhaustion 在 relay 侧语义上一致（防两处语义漂移）；'
    + '既有 A3 抑制路径、11 个 shouldSuppressWake 用例、注入间隔与信号语义不得改变；'
    + 'node --check 通过；新增用例 ≥6；排除 test/shadow-gate.test.js 后全量 0 失败；verify-files-coverage 通过；'
    + '改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务修一个「功能写了但主场景不生效」的问题。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【背景与实测证据（主 agent 已取证，勿推翻）】
上一任务（已提交 ba941c7）新增了「配额感知抑制」：当心跳本轮待办**全部只含 unclaimed-pending**、
且已知配额耗尽未恢复时，跳过唤醒并记一条 suppressed 台账。其意图是消除一个必然误报——
链条派发 cc 期间步骤仍是 pending（lib/cc-chain.mjs 明确不调 /steps/update），而配额停摆可达数小时，
远超 unclaimedMs 阈值，此时叫醒主 agent 无事可做。

**但实测发现该抑制在主场景下恒不生效**，证据链：
- relay 读的配额文件是 path.join(CC_TASKS_ROOT, 'cc-quota-state.json')（lib/index.js 约 L3537）；
- **该文件当前不存在**（实测 Test-Path = False）；
- 因为它**只有一处写入点**：relay 自己派发**审核**任务失败时（writeCcQuotaState 仅约 L3619 调用）；
- 而**链条**用的是另一份状态：D:\\\\cc-tasks\\\\chain-state.json（cc-chain.mjs 约 L27 定义 STATE，含 quotaResetsAt 字段），
  该文件**实际存在**（当前 quotaResetsAt: null）。
- 后果：链条配额停摆时 relay 侧配额状态为空 → quotaWaiting=false → **不抑制 → 误报依旧**。
  只有当 relay 自己的审核任务恰好也撞上配额，那个文件才会被写。

【必须回源核对的既有契约（不要凭记忆，先读源码）】
- lib/index.js 约 L559 const CC_TASKS_ROOT = resolveTasksRoot(process.env)；
  约 L3537 CC_QUOTA_STATE_PATH；约 L3538 async function readCcQuotaState()（读失败返回 null，不抛）。
- lib/index.js 的 heartbeatTick（A3 之后，**以符号名定位**）：其中一段为
  「let quotaState = null; let quotaWaiting = false; try { quotaState = await readCcQuotaState().catch(() => null);
   quotaWaiting = shouldSkipForKnownQuotaExhaustion({ quotaState, now: Date.now() }) } catch { … }」
  随后 quotaSuppressed = shouldSuppressWake({ pending, quotaWaiting })。**本任务只改 quotaWaiting 的来源。**
- lib/cc-channel.js 约 L650 export function shouldSkipForKnownQuotaExhaustion({ quotaState, now })：
  仅当 quotaState.kind === 'quota-exhausted' 且 resetsAt 可解析且 now < resetsAt 时 true，否则 false。
- lib/heartbeat-scan.js 约 L196 shouldSuppressWake（A3 新增，**判据不得改动**）。
- chain-state.json 的真实结构（主 agent 实测）：{ chainId, index, items: {...}, startedAt, quotaResetsAt, completedAt }。
  其中 quotaResetsAt 为 null 或 ISO 时间字符串。**只读它，不要写入、不要依赖 items 结构。**

【要求】
1) lib/heartbeat-scan.js 新增纯函数：
   isQuotaWaiting({ relayQuotaState, chainState, now = Date.now() } = {}) → boolean
   - relay 侧成立：relayQuotaState && relayQuotaState.kind === 'quota-exhausted' && resetsAt 可解析 && now < resetsAt；
   - 链条侧成立：chainState && chainState.quotaResetsAt 可解析 && now < chainState.quotaResetsAt；
   - 任一成立 → true；否则 false。畸形（对象非对象、字段缺失、时间不可解析）一律 false，**不抛错**。
   - 注释必须写明：relay 侧条件**镜像** lib/cc-channel.js 的 shouldSkipForKnownQuotaExhaustion；
     之所以不复用同一实现，是因为 heartbeat-scan.js 是**零依赖纯模块**（不 import 带 IO 的模块），
     因此用测试来锁死两者语义一致（见要求 4）。
2) lib/index.js：
   - 新增（或内联）一个 best-effort 读取器读取 path.join(CC_TASKS_ROOT, 'chain-state.json')：
     读失败/JSON 损坏 → null，**不抛**（与 readCcQuotaState 同款风格）。
   - heartbeatTick 中改用 isQuotaWaiting({ relayQuotaState: quotaState, chainState, now: Date.now() }) 计算 quotaWaiting；
     仍保留 readCcQuotaState。**整段仍须 fail-open**：任何异常一律 quotaWaiting=false（即照常唤醒，偏向叫醒）。
   - 其余一切不变：shouldSuppressWake 的调用、抑制台账记录、return 位置、不更新 lastHeartbeatInjection。
3) **不得**改动 shouldSuppressWake 的判据、A3 的抑制路径结构、既有 6 个信号、注入间隔、台账字段。
4) 测试 ≥6（node:test，纯函数优先），至少覆盖：
   - 仅 relay 侧成立 → true；仅链条侧成立 → true；两侧皆成立 → true；两侧皆不成立 → false；
   - resetsAt 已过期（now 晚于它）→ false（两侧各测一次）；
   - chainState 为 null / 非对象 / quotaResetsAt 非法字符串 → false 且不抛错；
   - **一致性守卫**：对一组 relay 侧 fixture，断言 isQuotaWaiting 的 relay 判定与
     lib/cc-channel.js 的 shouldSkipForKnownQuotaExhaustion **完全一致**（在测试里 import 后者，两个模块都 import 是允许的）。
     这条是防止两处语义漂移的关键，必须有。
5) 文档：docs/CC-HYBRID.md 记录「配额等待的两个来源（relay 审核路径 / 链条状态文件）」及为何需要两者。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/lib/heartbeat-scan.js
- /mnt/d/dsh-web-relay/test/heartbeat-scan.test.js
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md
其它文件一律不得改动（含 lib/cc-channel.js —— 只读复用/测试中 import）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check lib/index.js && node --check lib/heartbeat-scan.js 通过；
② node --test --test-reporter=tap test/heartbeat-scan.test.js 全绿，既有 44 条全部保持通过（不得改其断言），新增 ≥6；
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单，不要用目录式调用）。
   重要：你在 WSL 下跑测试时 test/shadow-gate.test.js 的 TC-Green / TC-GC / getGitHead **三项会失败**，
   这是**已知的 WSL 环境差异**（同一 commit 在 Windows 侧全绿，592 例 0 失败），**不是你引入的**：
   不要做 git stash 自证，也不要试图「修」它们——直接排除该文件并如实说明。
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告必须含**因果说明**：改动前在「链条 quotaResetsAt 为未来时间」场景下 quotaWaiting 为 false（故不抑制）、
   改动后为 true（故抑制）——用你的一致性/纯函数用例把这条因果展示出来；并给出 chain-state.json 读取器的行号。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
