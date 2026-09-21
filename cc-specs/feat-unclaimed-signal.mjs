// A1（低风险项 1 的第一步）：heartbeat-scan 新增「无人认领的可执行步骤」信号
// 设计依据见 D:\dsh relay test\_PLAN-low-risk-two.md（项目 1）
// 只做纯函数 + 单测，不碰 lib/index.js 接线与唤醒台账（那是 A2，独立派发）。
export const task = {
  taskId: 'ccfeat-20260915-unclaimed',
  kind: 'implement',
  title: 'heartbeat-scan 新增 unclaimed-pending 信号：可执行但无人认领的待办步骤要能被心跳检出',
  refs: ['lib/heartbeat-scan.js', 'test/heartbeat-scan.test.js', 'lib/index.js'],
  acceptance:
    'lib/heartbeat-scan.js 的 scanExprSignals 新增第 ⑥ 个信号 unclaimed-pending，判据为「存在 status===pending 且其 depends_on 全部已 approved 的步骤，'
    + '且该 expr 自上次写入已超过 unclaimedMs（新 opt，默认 1800000ms=30min）」；不得与既有 5 个信号语义重叠或互相吞并；'
    + '新 opt 可通过参数注入（便于单测与 env 调节）；node --check 通过；test/heartbeat-scan.test.js 新增用例 ≥6 且既有用例不减；'
    + '排除 test/shadow-gate.test.js 后全量 0 失败；verify-files-coverage 通过；改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务给「心跳自查」的信号体系补上缺失的一种状态。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【背景：一个真实事故（主 agent 已取证，勿推翻）】
- 事实：某计划的 Step 7 处于「pending 且依赖（step 6）已 approved」的可执行状态，但**链条的 items 只覆盖 planStepId 1/2/4/5/6，根本不包含 step 7**；于是跑完 V3-1 后整条管线静默结束。
- 后果：轨迹在 2026-09-15T01:50:26Z → 11:47:42Z 之间**零条目**，白等 9 小时 57 分，最后靠人发现才继续。
- 根因：lib/heartbeat-scan.js 现有 5 个信号（resume-circuit-paused / review-pending / rejected-pending / executing-stale / finalize-pending）**没有一个能匹配「可执行但没人认领」这一状态** —— 心跳每轮扫描都「无待办可报」，属合法静默。
- 本任务只补这一个信号（纯函数层）。接线到心跳循环、唤醒台账、/health-check 暴露由后续任务（A2）负责，**本任务不要改 lib/index.js**。

【必须回源核对的既有契约（不要凭记忆写）】
- lib/heartbeat-scan.js 第 15 行 export function scanExprSignals(st, { staleMs = 1200000, maxAgeMs = 0, now = Date.now() } = {})，
  返回 { exprId, signals: string[], detail: string[] }；signals 为空数组表示无需 agent 介入。
- 现有信号实现在第 32-66 行（注释里编号 ①」⑤），新信号请延续同一风格放在 ⑤ 之后（编号 ⑥）。
- 第 20-30 行的两个前置守卫必须保持生效且顺序不变：archived（已归档/已收口不产生任何信号）、maxAgeMs（陈旧过滤）。
- 第 77 行 export function scanPendingSignals(states, opts) 是批量包装，无需改动（它会自动带上新信号）。
- 依赖判定语义请**读 lib/index.js 里的 depsSatisfied 函数**并与之保持一致（approved 视为满足）；
  不要自己另发明一套依赖语义。若你发现 depsSatisfied 的语义与本规格描述不一致，**按源码为准并在报告中说明**。

【要求】
1) 新增信号名固定为 unclaimed-pending（字符串，勿改名，A2 与文档会引用它）。
2) 判据（全部满足才 push）：
   a. 该 expr 已通过 archived 与 maxAgeMs 两道前置守卫（即仍属活跃）；
   b. 存在步骤 s：s.status === 'pending' 且 s.depends_on 中每一项对应的步骤都是 'approved'（depends_on 缺失/空数组视为无依赖，即天然满足）；
   c. 该 expr 的 st.updatedAt 距 now 已超过 unclaimedMs（新 opt）。
3) 新 opt：unclaimedMs，默认 1800000（30 分钟），可经 opts 注入覆盖（与 staleMs 同级风格）。
   **不要复用 staleMs** —— 它是 executing 停滞的语义，混用会让「可执行没人做」与「执行中卡住」互相干扰（这是本规格的明确设计决定）。
4) 计时基准用 st.updatedAt，并在代码注释里写明其取舍：任何 expr 写入都会重置计时器，故该判据**偏向少报**（宁可晚叫不可误叫）；
   注释里同时点明后续可改进方向（改用「最后一个依赖被批准的时刻」，需读 steps[].notes）。
5) detail 文案：列出被判定为无人认领的步骤（id + title），并说明**这一步通常意味着没人会去做它**：
   链条可能未覆盖该步骤、链条可能已结束/挂起，或调度窗口已过期；请主 agent 判断应自行执行还是派发给 cc。
6) **不得改变既有 5 个信号的行为与顺序**；不得让新信号吞并或替代它们
   （例如全部步骤已 approved 时应仍只报 finalize-pending；有 review 步骤时应仍报 review-pending）。
   若同一 expr 同时命中多个信号，允许并列（signal 数组本就支持多个），但每个信号的触发条件必须独立成立。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/heartbeat-scan.js
- /mnt/d/dsh-web-relay/test/heartbeat-scan.test.js（扩充）
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md（补一小节说明该信号）
其它文件一律不得改动（含 lib/index.js、package.json）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check lib/heartbeat-scan.js 通过；
② node --test --test-reporter=tap test/heartbeat-scan.test.js 全绿，且新增用例 ≥6，至少覆盖：
   - pending + 依赖已 approved + updatedAt 超阈值 → 报 unclaimed-pending（含步骤 id 出现在 detail 中）；
   - 同上但 updatedAt 未超阈值 → 不报；
   - pending 但某依赖尚未 approved → 不报；
   - 已 finalized / 已归档 → 不报（前置守卫仍生效）；
   - 依赖已满足但步骤是 executing 或 review → **不报** unclaimed-pending（应分别由既有信号负责）；
   - unclaimedMs 可经 opts 注入覆盖（如传 1000 时立即触发），且默认值为 1800000；
   - 既有 5 个信号的用例全部保持通过（不得为了新信号改动它们）。
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单，不要用目录式调用）。
   重要：你在 WSL 下跑测试时 test/shadow-gate.test.js 的 TC-Green / TC-GC / getGitHead **三项会失败**，
   这是**已知的 WSL 环境差异**（同一提交在 Windows 侧全绿，562 例 0 失败），**不是你引入的**：
   不要做 git stash 自证，也不要试图「修」它们——直接排除该文件并如实说明。
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：现有 5 个信号与既有守卫的行号取证、新增信号改动点 file:line、与 depsSatisfied 语义一致性核对结论、
   用例清单、以及「为何不复用 staleMs」的说明。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
