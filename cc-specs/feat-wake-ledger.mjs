// A2（低风险项 1 的第二步）：把 unclaimed-pending 接线到心跳，并补「唤醒台账 + 状态变化核对」
// 设计依据：D:\dsh relay test\_PLAN-low-risk-two.md（项目 1 的 B、C 两项）
// A1（ccfeat-20260915-unclaimed，提交 9acfaee）已完成纯函数层；本任务只做接线 + 台账 + 暴露 + 文档。
export const task = {
  taskId: 'ccfeat-20260915-wakeledger',
  kind: 'implement',
  title: '心跳接线 unclaimed-pending + 唤醒台账与状态变化核对：区分「没唤醒」与「唤醒了没人动」',
  refs: ['lib/index.js', 'lib/heartbeat-scan.js', 'test/heartbeat-scan.test.js'],
  acceptance:
    'lib/index.js 的 heartbeatTick 把 DSH_RELAY_UNCLAIMED_MS（默认 1800000）传入 scanPendingSignals；'
    + '新增唤醒台账（每次注入记 exprs+指纹+signals+sessionId+agentWoken+reason）并在**下一轮心跳**核对该 expr 状态是否变化；'
    + '核对逻辑必须位于「pending 为空即 return」与「最小注入间隔即 return」两道 early return **之前**（否则无新待办时永不结算）；'
    + '台账与核对全程 fail-open：任何异常不得阻断既有唤醒路径；/health-check 暴露 wakeLedger；'
    + '既有 5 个信号语义、注入间隔与唤醒行为不得改变；'
    + 'node --check 通过；新增用例 ≥8；排除 test/shadow-gate.test.js 后全量 0 失败；verify-files-coverage 通过；'
    + '改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务把上一轮新增的心跳信号接上线，并补一块当前缺失的审计能力。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【背景：为什么需要「唤醒台账」（主 agent 已取证）】
- 真实事故：某计划 Step 7 可执行但无人认领，管线静默 9 小时 57 分（详见上一任务的背景）。
- 排查时发现一个**审计盲点**：lib/index.js 的 lastHeartbeatState.injected 只表示「注入调用成功」，
  **不代表主 agent 真的行动了**。心跳每隔一段时间注入一次 handoff，但如果注入落进一个没人消费的会话，
  injected 仍为 true 而实际什么都没发生。本次事故中「到底是没唤醒，还是唤醒了没人动」，因宿主日志被重启截断
  **已无法判定**——这正是本任务要消灭的盲区。
- 上一任务（已提交 9acfaee）已在 lib/heartbeat-scan.js 新增第 ⑥ 信号 unclaimed-pending（可执行但无人认领）
  与新 opt unclaimedMs。**本任务不修改该信号的判据**，只做接线、台账与暴露。

【必须回源核对的既有契约（不要凭记忆，先读源码再动手）】
- lib/index.js 约 L4794 async function heartbeatTick()：其现有流程为
  「遍历 resumeScanBases() 收集 all → scanPendingSignals(all, { staleMs, maxAgeMs }) → 写 lastHeartbeatState →
   if (pending.length === 0) return → if (距上次成功注入 < HEARTBEAT_MIN_GAP_MS) return →
   取 sessionId（env DSH_SESSION_ID 优先，否则取待办 expr 的 sessionId）→ wakeMainAgent({sessionId, handoffText}) →
   记 lastHeartbeatState.injected / lastHeartbeatInjection」。
- lib/index.js 约 L4800 的 scanPendingSignals 调用点（本任务要在此传入 unclaimedMs）。
- lib/index.js 约 L4781 heartbeatHandoff(pending)（唤醒文案构造函数，含 5 种信号的处置说明——
  新增第 ⑥ 信号后，**文案里也要补一句 unclaimed-pending 的处置指引**，否则收到唤醒的主 agent 不知道该怎么办）。
- heartbeat 周期注册在约 L4854（setInterval，HEARTBEAT_MS 默认 15min）。
- lib/heartbeat-scan.js 的 scanExprSignals / scanPendingSignals（A1 已加第 ⑥ 信号，勿改其判据）。

【要求】
1) 接线：heartbeatTick 调用 scanPendingSignals 时传入 unclaimedMs（取自 env DSH_RELAY_UNCLAIMED_MS，
   非法/缺失回退 1800000），与既有 staleMs/maxAgeMs 同级。
2) 台账（新增，内存态即可，与 lastHeartbeatState 同为进程内状态）：
   - 每次**成功调用 wakeMainAgent** 时追加一条记录：
     { at, exprs: [{ exprId, fingerprint }], signals: [...], sessionId, agentWoken, reason, outcomes: {} }
     其中 fingerprint 是注入时刻该 expr 的状态指纹（见下）；若一次注入覆盖多个 expr，则逐个记录指纹。
   - 台账容量上限 20 条（超出丢弃最旧），避免无界增长。
3) **状态变化核对**（本任务的核心）：
   - 新增纯函数（放在 lib/heartbeat-scan.js，便于单测）：
     a) exprFingerprint(st)：由 expr 的关键状态派生稳定字符串——至少包含 expr 级 status/finalized，
        以及每个 step 的 id、status、reviewedBy、notes.length、最后一条 note 的 at。
        **必须能区分**：步骤状态变化、新增 note、收口。给出实现并在注释里说明为何选这些字段。
     b) evaluateWakeOutcomes(entry, currentStates)：给定一条台账记录与当前状态列表 →
        为 entry.outcomes 中每个 exprId 填 'changed' 或 'unchanged'（找不到该 expr 记为 'gone'）。
   - heartbeatTick 中在**每轮**心跳（含没有新待办的那些轮）先结算历史记录：
     对 outcomes 仍为空的记录，用当前状态计算并填入，然后（可选）console.warn 一行汇总
     形如「[心跳台账] 上次注入后 N 个 expr 状态有变化、M 个无变化」。
   - **顺序要求（硬性）**：结算必须发生在两道 early return **之前**——即
     「if (pending.length === 0) return」与「if (距今 < HEARTBEAT_MIN_GAP_MS) return」都要在其后。
     理由：若放在 early return 之后，恰恰是「没有新待办」的那些轮次（也就是「唤醒了但没人动」的典型场景）
     永远不会去结算，台账就失去意义。请在代码注释中写明这一点。
4) fail-open：台账与结算的任何异常都必须被捕获并只记录 warn，**绝不允许**阻断既有唤醒路径
   （即：台账代码出错时，原有的 scanPendingSignals → wakeMainAgent 流程必须照常工作）。
5) /health-check：暴露 wakeLedger（最近 N 条，含 outcomes），与既有 heartbeat 字段并列；
   默认值块与返回体都要加（本项目历史教训：只加返回体、漏加默认值块会导致字段缺失）。
   同时把 heartbeatHandoff 的文案补上 unclaimed-pending 的处置指引。
6) **不得改变**既有 5 个信号语义、HEARTBEAT_MIN_GAP_MS 注入间隔、lastHeartbeatState 既有字段与唤醒行为。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/lib/heartbeat-scan.js（仅新增纯函数，勿改 A1 的信号判据）
- /mnt/d/dsh-web-relay/test/heartbeat-scan.test.js（扩充）
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md
- /mnt/d/dsh-web-relay/docs/OPS-CC-CHAIN.md
其它文件一律不得改动（含 package.json）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check lib/index.js && node --check lib/heartbeat-scan.js 通过；
② node --test --test-reporter=tap test/heartbeat-scan.test.js 全绿，新增用例 ≥8，至少覆盖：
   - exprFingerprint：状态变化 / 新增 note / 收口 三种情形指纹均不同；同一状态两次调用指纹相同（稳定）；
   - evaluateWakeOutcomes：状态变了→'changed'；状态没变→'unchanged'；expr 已不存在→'gone'；
   - 台账上限 20 条（第 21 条挤掉最旧）；
   - fail-open：evaluateWakeOutcomes 收到畸形 entry（缺 exprs / 非法字段）不抛错；
   - 源码契约（顺序守卫）：在 lib/index.js 的 heartbeatTick 函数体内，结算调用的位置必须早于
     「if (pending.length === 0) return」——用源码字符串 index 比较断言，防止后人重构时把它挪到 early return 之后。
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单，不要用目录式调用）。
   重要：你在 WSL 下跑测试时 test/shadow-gate.test.js 的 TC-Green / TC-GC / getGitHead **三项会失败**，
   这是**已知的 WSL 环境差异**（同一 commit 在 Windows 侧全绿，570 例 0 失败），**不是你引入的**：
   不要做 git stash 自证，也不要试图「修」它们——直接排除该文件并如实说明。
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：heartbeatTick 现有流程的 file:line 取证、结算插入点的**前后行号对比**（证明它在 early return 之前）、
   exprFingerprint 字段选择理由、台账容量与 fail-open 实现、用例清单、未做项与残余风险
   （尤其说明：台账是进程内状态，宿主重启会清空——本任务的定位是让「同一宿主生命周期内」的唤醒可审计）。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
