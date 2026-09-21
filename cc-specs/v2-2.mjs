// V2-2 步骤契约规格（审计后重划：原「对接 lessons-inject」已实现，改为版间门与突破度联动）
//
// 审计证据（主 agent 已核，实施者需自行复核并贴行号）：
//   - lessons-inject **已接线**：lib/index.js L32 import、L1730-1734 生成 lessonBlock、L1736
//     return base + MAIN_AGENT_ASSEMBLY + lessonBlock（handoff 装配）→ 原 V2-2 无事可做。
//   - 版间门在 L3603-3634（status==='done' 分支）：L3606 条件 `updated.iterations > 1 && (updated.currentIteration||1) < updated.iterations`
//     只判「迭代未满」，**完全不读 incrementalStreak / 突破度**；L3610-3618 生成唤醒主 agent 的 handoffText
//     请外部 AI 评审上版并输出下一版 Step List。
//   - 因此协议条款「每 2 个 Incremental 版本后下一版须含 Structural/Paradigm」在自动迭代中**无人执行**：
//     即使连续 N 版全是微调，系统仍会推进 Vn+1。
//   - 相关既有资产：lib/breakthrough-gate.js 的 versionTypeOf/auditBreakthrough；V1-1 将新增 evaluateBreakthroughPlan
//     （若 V1-1 已落地则**必须复用**，不得再写一套判定）；writeStepState 白名单 L1596-1602 已含 incrementalStreak。
export const task = {
  taskId: 'v2-2-versiongate-breakthrough',
  kind: 'implement',
  title: 'V2-2: 版间门与突破度联动——连续 Incremental 时阻止进入下一版并要求 structural/paradigm',
  refs: ['lib/index.js', 'lib/breakthrough-gate.js', 'test/breakthrough-gate.test.js'],
  acceptance:
    '版间门推进决策被抽成可注入纯函数（含 advance/requiredType/reasons/handoffNote），并在 status=done 分支接入：'
    + 'gatePassed=true 时推进行为与现状完全一致（零变化）；gatePassed=false 时不推进 currentIteration，改为在唤醒文案中要求下一版必须含 structural/paradigm，'
    + '并把判定落盘（审计字段）+ appendTrace 留痕；unknown/null 不触发；达到 iterations 上限的收口行为不变；'
    + 'node --check 通过；测试新增 ≥5 例且既有用例不减；全量测试全绿；verify-files-coverage 通过；改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务让「自动版本演化」遵守突破度条款：连续微调版本不得无障碍地进入下一版。结论必须有 file:line 与命令输出。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【第 0 步（必做）：现状取证】
1. Read lib/index.js 约 L3580-3640，贴出版间门分支的完整判定与唤醒文案（给行号），并明确指出它**没有**读取 incrementalStreak；
2. grep evaluateBreakthroughPlan（V1-1 的产物）与 auditBreakthrough 的命中行；若 evaluateBreakthroughPlan 已存在，**必须复用**，禁止另写判定；
3. Read lib/breakthrough-gate.js，确认 versionTypeOf 对「全 unknown/null」返回 null（不计不重置）的既有语义；
4. Read writeStepState（约 L1577-1621），确认 incrementalStreak 已在写白名单内；
5. Read test/breakthrough-gate.test.js 现有用例数与风格（贴数字）。
把上述结果写进 report.md 的「现状取证」。**已实现的逻辑不要重写**（lesson L-2026-0914-060）。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/lib/breakthrough-gate.js（仅当需要新增纯函数时）
- /mnt/d/dsh-web-relay/test/breakthrough-gate.test.js
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md（补充说明）
其它文件一律不得改动。

【要求】
1) **抽出可测纯函数**（建议放 lib/breakthrough-gate.js，便于单测）：
   evaluateVersionAdvance({ steps, state, max }) →
     { advance: boolean, verdict: 'advance' | 'blocked-needs-breakthrough' | 'final-iteration' | 'single-iteration',
       consecutiveIncremental: number, requiredType: 'structural'|null, reasons: string[], handoffNote: string|null }
   - 复用 evaluateBreakthroughPlan（V1-1）或 versionTypeOf 的既有判定，不得重复实现类型识别；
   - 入参可注入（steps/state/max），**不得**在纯函数内做 IO、读环境变量或调用 Date（可通过入参传入历史 streak）；
   - max 的来源：优先显式入参，其次调用方传入的 env 值（由调用方读取 DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL，默认 3）。
2) **接入版间门**（lib/index.js status==='done' 分支）：
   - advance=true（含 final-iteration / single-iteration）→ 现有行为**零变化**（含原有 handoffText 与 currentIteration 推进逻辑）；
   - advance=false → **不推进** currentIteration（保持原值），改为：
     a) handoffText 使用 handoffNote（须明确写出：本版为第 N 个连续 Incremental 版本，下一版必须包含 structural 或 paradigm 突破项，并给出 reasons）；
     b) 落盘审计字段（例如 breakthroughBlocked: { at, consecutiveIncremental, requiredType, reasons }），走 writeStepState
        （该字段**必须加入写白名单**，保持既有字段语义不变）；
        **白名单是本仓库的高危点，而且是「读 + 写」两处**（主 agent 已取证）：
        - 写白名单 lib/index.js L1604 附近——注释原话「v3.8 Step3-fix：基线/回滚字段纳入写白名单（v3.7.1 曾漏 iterationBaseCommit → 写盘即丢）」；
        - 读白名单 lib/index.js L1562 附近——注释原话「v3.8 Step3-fix：回滚/基线相关字段纳入读白名单（v3.7.1 曾漏 iterationBaseCommit → 面板回滚恒 400「缺基线」）」。
        新字段**只加写、漏加读**会让字段落盘却读不回来（反之则写盘即丢）——因此：
        报告必须给出**两处白名单的 diff file:line 证据**，并**用断言证明字段真的可写可读**（构造 advance=false 场景后断言
        写盘 payload 与读取结果中都存在 breakthroughBlocked 且 currentIteration 未变），不得只改调用点就宣称完成；
     c) appendTrace(role='mainagent') 记录阻止原因；
   - **不得**把 expr 置为 paused 或 rejected（那是熔断/打回语义，本任务只阻止进入下一版并要求补突破项）。
3) **幂等与可恢复**：同一 expr 重复触发不得改变 currentIteration；主 agent 通过 restructure 提交含突破项的新版后，advance 应恢复为 true（因为 versionTypeOf 会对 breakthrough 归零 streak）。
4) **测试**（test/breakthrough-gate.test.js 新增 ≥5 例，纯函数、无 IO/无网络）：阈值触发（连续 N 达上限 → advance=false 且 requiredType=structural 且 handoffNote 含关键词）；
   未触发（含 structural → advance=true 且 streak 归零）；历史为空；全 unknown/null 不触发；达到 iterations 上限 → verdict='final-iteration' 且 advance=true；
   reasons 含可读依据。并保留全部既有用例（含 warn 语义用例）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check lib/index.js && node --check lib/breakthrough-gate.js 通过；
② node --test --test-reporter=tap test/breakthrough-gate.test.js 全绿，贴用例数（原基数 + 新增 ≥5）；
③ 全量回归：node --test --test-reporter=tap $(ls test/*.test.js test/*.test.mjs) 不得新增失败；
   **不要**用 node --test test/（Node 26 会把目录当单个测试项而报 1 个假失败）。主 agent 侧基线：全量 458 例、*.test.js 子集 318 例全通过；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（node fs.writeFileSync(p, s, 'utf8')；**不要**用 PowerShell 读写文件——lesson L-2026-0914-061）；
⑥ git -C /mnt/d/dsh-web-relay status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ report.md 含：现状取证行号、新函数签名、接入点 file:line、advance=false 时的 handoffNote 样例、审计字段样例、未做项与残余风险。

【交付物】out/report.md + 任务根 done.flag（Bash: touch done.flag）。**建议先 touch done.flag 再写报告**（此前有任务在收尾写报告阶段撞额度耗尽，导致完整交付被记成失败——lesson L-2026-0914-063）。`,
};
