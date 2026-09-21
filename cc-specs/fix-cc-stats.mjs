// 小修规格：把 cc 失败分类接入 cc-stats 统计（补上 hb3 因「写入范围未列 cc-stats.mjs」而未做的部分）
//
// 背景：ccfix-20260914-hb3 的实现者主动指出契约自相矛盾——正文要求改 lib/cc-stats.mjs，
// 但写入范围清单未列该文件，它选择遵守更严格的机器校验范围并留作后续。本任务补这一块（主 agent 认领规格缺陷）。
// 已落地可复用的既有资产（实施前先 Read 确认，勿重写）：
//   - lib/cc-channel.js 已有 classifyCcFailure({result, claudeLogText}) → { kind: 'quota-exhausted'|'permission-denied'|'timeout'|'code-failed'|'unknown', errorCode, resetsAt, raw }
//     以及 parseResetsAt / shouldSkipForKnownQuotaExhaustion；
//   - runner.sh 失败时写入 result.json.errorCode ∈ {cc-quota-exhausted, cc-permission-denied, cc-timeout, cc-failed, v2-validate-failed}
//     （2026-09-14 实测：Edit 未授权 → cc-permission-denied；订阅额度耗尽 → cc-quota-exhausted）。
export const task = {
  taskId: 'ccfix-20260914-stats',
  kind: 'implement',
  title: 'cc-stats 失败分类补齐：cc-quota-exhausted / cc-permission-denied 独立成桶（/health-check 可见）',
  refs: ['lib/cc-stats.mjs', 'lib/cc-channel.js'],
  acceptance:
    'lib/cc-stats.mjs 的失败分类能把 cc-quota-exhausted / cc-permission-denied / cc-timeout / cc-failed 与真实代码失败区分开，'
    + '且具体规则排在通用 timeout 规则之前（避免被吞并）；byFailure 统计互斥可数；'
    + 'node --check 通过；test/cc-stats.test.mjs 新增 ≥3 例全绿且既有用例不减；全量测试全绿；verify-files-coverage 通过；改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务补齐 cc 失败分类在**统计层**的落点，使 /health-check 能直接看出「配额耗尽 N 次」「权限被拒 N 次」。结论必须有 file:line 与命令输出。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【第 0 步（必做）：现状取证】
1. Read lib/cc-stats.mjs，列出 FAILURE_RULES 现有规则与顺序（给行号），指出哪条通用规则会吞并新分类；
2. Read lib/cc-channel.js 中已有的 classifyCcFailure / parseResetsAt / shouldSkipForKnownQuotaExhaustion（给行号与返回结构）；
3. grep lib/index.js 中 recordCcStat 的调用点，确认 reason 字段实际传入的字符串形态（含 ccWatchdogWarning / quota 短路路径）；
4. Read test/cc-stats.test.mjs 现有用例，确认基线用例数与断言风格。
把上述结果写进 report.md 的「现状取证」。**已实现的分类逻辑不要重写，只做统计层接入。**

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/cc-stats.mjs
- /mnt/d/dsh-web-relay/test/cc-stats.test.mjs
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md（仅在需要补一行开关/分类说明时）
其它文件一律不得改动（特别是不要在本次改 lib/cc-channel.js 或 lib/index.js——分类函数已存在）。

【要求】
1) FAILURE_RULES 新增（或确认已存在）以下分类，且**顺序在通用 timeout / unknown 规则之前**：
   - \`cc-quota-exhausted\`：命中 \`session limit\` / \`rate limit\` / \`quota\` / errorCode=cc-quota-exhausted；
   - \`cc-permission-denied\`：命中 \`permissions to write\` / \`haven't granted\` / \`not permitted\` / errorCode=cc-permission-denied；
   - \`cc-timeout\`：errorCode=cc-timeout 或 exit=124 语义；
   - 既有 \`cc-watchdog-stale\`、\`timeout-still-running\`、\`timeout\`、\`failed\` 等规则保持行为不变。
2) 与 lib/cc-channel.js 的 classifyCcFailure 的 kind 命名保持一致（quota-exhausted / permission-denied / timeout / code-failed / unknown），
   必要时在 cc-stats 内做一次显式映射并在报告中说明映射关系；不得复制粘贴两套正则而不说明。
3) byFailure 统计互斥可数：同一 reason 只能落一个桶；给出「同一批混合 reason 输入 → 各桶计数」的实测输出。
4) 测试（test/cc-stats.test.mjs 新增 ≥3 例，纯函数、不碰真实文件）：
   - quota 文本 → cc-quota-exhausted（且不被 timeout/unknown 吞并）；
   - permission 文本 → cc-permission-denied；
   - 混合输入 → 各桶计数正确且总数相等；
   - （加分）errorCode 直传路径与文本路径结果一致。
5) 允许在 docs/CC-HYBRID.md 补一行「失败分类桶清单」，但不得改动其它文档内容。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check lib/cc-stats.mjs 通过；
② node --test --test-reporter=tap test/cc-stats.test.mjs 全绿，贴用例数（既有不得减少，新增 ≥3）；
③ 全量回归：node --test --test-reporter=tap $(ls test/*.test.js test/*.test.mjs) 不得新增失败；
   **不要**用 node --test test/（Node 26 会把目录当单个测试项而报 1 个假失败）。主 agent 侧基线：全量 453 例、*.test.js 子集 318 例全通过；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（node fs.writeFileSync(p, s, 'utf8')；**不要**用 PowerShell 读写文件——lesson L-2026-0914-061）；
⑥ git -C /mnt/d/dsh-web-relay status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ report.md 含：现状取证行号、新增规则与顺序理由、kind 映射关系、混合输入的实测桶计数、未做项。

【交付物】out/report.md + 任务根 done.flag（Bash: touch done.flag）。`,
};
