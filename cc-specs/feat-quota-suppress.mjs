// A3：配额感知抑制——避免 unclaimed-pending 在「配额停摆」期间误报
// 依据：_PLAN-low-risk-two.md 中「新发现：A1 有一个可预期的误报场景」
// 依赖 A1(9acfaee)/A2(e376b56) 已落地：信号已能报、台账已能记（本任务复用台账记录「为何没唤醒」）。
export const task = {
  taskId: 'ccfeat-20260916-quotasuppress',
  kind: 'implement',
  title: '配额感知抑制：仅当 pending 只有 unclaimed-pending 且配额已知耗尽时跳过唤醒，并记入台账',
  refs: ['lib/index.js', 'lib/heartbeat-scan.js', 'lib/cc-channel.js'],
  // 2026-09-16 起规格应声明 anchors：check-spec 会校验其真实存在与唯一性（见 docs/CC-HYBRID.md §19）
  anchors: [
    { file: 'lib/heartbeat-scan.js', pattern: 'export function scanExprSignals', note: '信号判定纯函数（本任务加抑制判定纯函数）' },
    { file: 'lib/heartbeat-scan.js', pattern: 'export function evaluateWakeOutcomes', note: 'A2 的核对纯函数（本任务需让 suppressed 条目跳过核对）' },
    { file: 'lib/cc-channel.js', pattern: 'export function shouldSkipForKnownQuotaExhaustion', note: '既有配额判定（直接复用，勿重写）' },
    { file: 'lib/index.js', pattern: 'async function readCcQuotaState', note: '既有配额状态读取（直接复用）' },
  ],
  acceptance:
    'lib/heartbeat-scan.js 新增纯函数 shouldSuppressWake({ pending, quotaWaiting })：仅当 quotaWaiting 为真、pending 非空、'
    + '且 pending 中**每一项**的 signals 都只含 unclaimed-pending 时返回 true；'
    + 'lib/index.js 的 heartbeatTick 在注入前用 readCcQuotaState + shouldSkipForKnownQuotaExhaustion 判定，'
    + '命中则**跳过注入**并向台账记一条 suppressed 记录（含 quotaResetsAt），不得静默吞掉；'
    + 'settleWakeLedger 必须跳过 suppressed 条目（它们没发过唤醒，不该被核对待响应）；'
    + '配额状态未知/已过期/含其它信号时一律照常唤醒（fail-open 偏向叫醒）；'
    + '既有 6 个信号语义、注入间隔、台账既有字段不得改变；'
    + 'node --check 通过；新增用例 ≥8；排除 test/shadow-gate.test.js 后全量 0 失败；verify-files-coverage 通过；'
    + '改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务修掉一个**可预期的误报**，让心跳唤醒更准。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【背景：为什么需要抑制（主 agent 已取证，勿推翻）】
- 前一任务（已提交 9acfaee）新增了第 ⑥ 信号 unclaimed-pending：expr 未收口、有步骤处于
  「status==='pending' 且依赖全部 approved」的可执行状态、且 expr 自上次写入已超过 30 分钟 → 报该信号，
  目的是避免「可执行但没人认领的步骤」让管线静默数小时（真实事故：Step 7 静默 9 小时 57 分）。
- **但它有可预期的误报场景**：lib/cc-chain.mjs 顶部明确「绝不代替协议审核——链条不调 /steps/update」，
  也就是说**链条派发 cc 期间步骤状态仍是 pending**；而 cc 额度耗尽时链条会停摆等待（实测单段最长 993 分钟），
  远超任何合理阈值。此时下一个待做步骤处于「可执行 + 无人认领 + updatedAt 超龄」→ unclaimed-pending **必然误报**。
  而配额停摆正是实测中占比最大的空闲类型。此时管线不是「无人认领」，而是「在等额度」——叫醒主 agent 无事可做。
- 本任务只做**配额感知的一层抑制**（不改变 unclaimed-pending 的判据本身），且抑制必须**可审计**。

【必须回源核对的既有契约（不要凭记忆，先读源码）】
- lib/cc-channel.js 的 shouldSkipForKnownQuotaExhaustion({ quotaState, now } = {})：
  仅当 quotaState.kind === 'quota-exhausted' 且 resetsAt 可解析且 now < resetsAt 时返回 true，否则 false。
  **直接复用，不要重写配额判定逻辑。**
- lib/index.js 已有 async function readCcQuotaState()（约 L3537）读取持久化配额状态；既有调用点约 L3575。
- lib/index.js 的 heartbeatTick（实测 L4822；A2 之后行号已变，**以符号名定位为准**）：现有流程为
  收集 all → scanPendingSignals → 结算台账（A2 新增，**在两道 early return 之前**）→
  if (pending.length === 0) return → if (距上次注入 < HEARTBEAT_MIN_GAP_MS) return →
  取 sessionId → wakeMainAgent → 成功则 lastHeartbeatInjection = Date.now() 并 push 台账（A2）。
- lib/heartbeat-scan.js 的 exprFingerprint / evaluateWakeOutcomes（A2 新增）；
  lib/index.js 内 settleWakeLedger（A2 新增）现有逻辑为：跳过 outcomes 非空的条目，其余用当前状态回填。
- 台账条目结构：{ at, exprs:[{exprId,fingerprint}], signals, sessionId, agentWoken, reason, outcomes:{} }。

【要求】
1) 新增纯函数（放 lib/heartbeat-scan.js，便于单测）：
   shouldSuppressWake({ pending, quotaWaiting }) → boolean
   - 仅当 quotaWaiting === true **且** pending 是非空数组 **且** pending 中**每一项**的 signals 数组
     **只包含** 'unclaimed-pending'（长度≥1 且全部等于它）时返回 true；
   - 其余一切情况返回 false（含：pending 为空、quotaWaiting 假、任一项含其它信号、signals 缺失/非数组）。
   - 注释写明**为何必须如此严格**：只要还有 review-pending / rejected-pending / finalize-pending /
     executing-stale / resume-circuit-paused 中任意一个，就必须照常唤醒——那些是不能等配额的。
2) heartbeatTick 接线：
   - 在**决定是否注入之前**（即取 sessionId 之前或之后均可，但必须在 wakeMainAgent 调用之前）计算：
     quotaState = await readCcQuotaState().catch(() => null)；
     quotaWaiting = shouldSkipForKnownQuotaExhaustion({ quotaState, now: Date.now() })；
   - 若 shouldSuppressWake({ pending, quotaWaiting }) 为真：**不调用 wakeMainAgent**，
     改为向 wakeLedger 追加一条**抑制记录**：
     { at, exprs: pending.map(p => ({ exprId: p.exprId, fingerprint: 对应 expr 的 exprFingerprint })),
       signals: 汇总的信号名列表, sessionId: null, agentWoken: false, reason: 'suppressed:quota-wait',
       suppressed: 'quota-wait', quotaResetsAt: quotaState && quotaState.resetsAt || null, outcomes: {} }
     并 console.warn 一行说明「因配额耗尽（预计 resetsAt 恢复）跳过唤醒」。
     **必须记台账**——静默跳过是审计问题（本项目明确反对静默丢失）。容量上限仍为 20。
   - 抑制路径**不得**更新 lastHeartbeatInjection（没真发唤醒，不应触发防频）。
   - 任何异常（读配额状态失败、纯函数抛错）一律**放行唤醒**（fail-open 偏向叫醒），并只 console.warn。
3) settleWakeLedger：**跳过带 suppressed 字段的条目**（它们没发过唤醒，谈不上「有没有响应」）。
   在不变量注释里写明这一点。
4) 不改动：既有 6 个信号判据、HEARTBEAT_MIN_GAP_MS、lastHeartbeatState 字段、正常唤醒路径的行为。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/lib/heartbeat-scan.js
- /mnt/d/dsh-web-relay/test/heartbeat-scan.test.js
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md
其它文件一律不得改动（含 package.json、lib/cc-channel.js —— 后者只读复用）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check lib/index.js && node --check lib/heartbeat-scan.js 通过；
② node --test --test-reporter=tap test/heartbeat-scan.test.js 全绿，新增用例 ≥8，至少覆盖：
   - quotaWaiting=true + 仅 unclaimed-pending → true；
   - quotaWaiting=true + 混入 review-pending（或任一其它信号）→ **false**（必须照常唤醒）；
   - quotaWaiting=true + 多项但其中一项含额外信号 → false；
   - quotaWaiting=false → false；pending 为空 → false；signals 缺失/非数组 → false（不抛错）；
   - 台账抑制记录的结构（含 suppressed 与 quotaResetsAt，且 agentWoken=false）；
   - settleWakeLedger 跳过 suppressed 条目（outcomes 保持为空、不被回填）；
   - 既有用例全部保持通过（不得为本次改动改其断言）。
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单，不要用目录式调用）。
   重要：你在 WSL 下跑测试时 test/shadow-gate.test.js 的 TC-Green / TC-GC / getGitHead **三项会失败**，
   这是**已知的 WSL 环境差异**（同一 commit 在 Windows 侧全绿，581 例 0 失败），**不是你引入的**：
   不要做 git stash 自证，也不要试图「修」它们——直接排除该文件并如实说明。
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：shouldSkipForKnownQuotaExhaustion 与 readCcQuotaState 的行号取证、抑制判定的插入位置 file:line、
   「为何只有单一 unclaimed-pending 才抑制」的说明、fail-open 实现、用例清单、未做项与残余风险
   （尤其：配额状态文件缺失或过期时不会抑制，故仍有少量误报可能——如实说明）。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
