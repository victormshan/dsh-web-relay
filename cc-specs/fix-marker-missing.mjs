// 修复任务：新增 cc-marker-missing 失败分类的仓库侧消费（cc-channel.js / cc-stats.mjs）
// 背景：runner.sh 已新增 cc-marker-missing（claude exit=0 + 未写 done.flag + 确有产出）。
//       实测 2/2 该情形产物完好且独立验收 ACCEPT（v1-2 c4b3125、ccfix-20260915-swarmparse 947fd3e），
//       即此前一律记成 cc-failed → 「真写坏代码」与「只是没写完成标记」不可区分，审计上假阴性率 100%。
export const task = {
  taskId: 'ccfix-20260915-markermissing',
  kind: 'implement',
  title: '新增 cc-marker-missing 分类的仓库侧消费：cc-channel.classifyCcFailure 与 cc-stats.FAILURE_RULES',
  refs: ['lib/cc-channel.js', 'lib/cc-stats.mjs'],
  acceptance:
    'lib/cc-channel.js classifyCcFailure 对 errorCode=cc-marker-missing 返回 kind=marker-missing，且该判定必须排在 '
    + 'result.status===\'failed\' 的 code-failed 兜底**之前**；lib/cc-stats.mjs FAILURE_RULES 新增 cc-marker-missing 规则并排在 '
    + 'runner-failed（其正则含 done.flag missing）**之前**；两处 JSDoc/头注释的取值清单同步补齐；'
    + 'node --check 通过；新增用例 ≥5（含「无 errorCode 但 status=failed 仍为 code-failed」的反向回归）；'
    + '全量测试在排除 test/shadow-gate.test.js 后 0 失败且既有用例不减；verify-files-coverage 通过；'
    + '改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务给一个**新的失败分类**补上仓库侧消费，使无人值守链条能区分「代码写坏了」与「只是没写完成标记」。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【背景（主 agent 已取证，勿推翻）】
- cc 通道的 runner.sh 新增了失败分类 cc-marker-missing，判据：claude 退出码为 0、未写完成标记 done.flag，
  **但确有产出**（任务产物目录 out/ 非空，或目标仓库工作树有改动）。
- 为什么需要它：实测 2 次该情形（v1-2 提交 c4b3125、ccfix-20260915-swarmparse 提交 947fd3e）产物均完好、
  独立验收均 ACCEPT（7/7），却都被记成 cc-failed。也就是说在 cc-failed 这个分类下，假阴性率目前 100%。
  两类动作完全不同：真失败 → 重试/降级；标记缺失 → **人工核验产物**（不得直接重跑，否则浪费稀缺 cc 额度）。
- 你**只负责仓库侧的两个消费点**（runner.sh 侧主 agent 已改完，不要动 /mnt/d/cc-tasks 下任何文件）。

【必须遵守的两处顺序要求（这是本任务的核心风险点）】
1) lib/cc-channel.js 的 classifyCcFailure（约 L581-627）：现有 isCodeFailed 分支的判据是
     errorCode === 'cc-failed' || errorCode === 'v2-validate-failed' || (result && result.status === 'failed')
   注意最后那个 **result.status === 'failed'**：marker-missing 的 result.json 里 status 恰好也是 "failed"，
   所以如果你把新判定放在它后面，永远命中不了 code-failed 之前的顺序会把它吞掉。**必须把
   errorCode === 'cc-marker-missing' 的判定放在 isCodeFailed 之前**，返回 kind: 'marker-missing'
   （resetsAt 为 null，raw 照旧）。
2) lib/cc-stats.mjs 的 FAILURE_RULES（约 L35-49）：现有 runner-failed 规则的正则里含
     done\\.flag\\s*(missing|不存在|缺失)
   而 marker-missing 的 reason 文本恰好是 "claude exit=0; done.flag=missing" —— 同样会被先匹配走。
   **必须把 ['cc-marker-missing', /cc-marker-missing/i] 放在 runner-failed 之前**。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/cc-channel.js
- /mnt/d/dsh-web-relay/lib/cc-stats.mjs
- /mnt/d/dsh-web-relay/test/cc-channel.test.js（扩充）
- /mnt/d/dsh-web-relay/test/cc-stats.test.mjs（扩充）
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md（补充说明）
其它文件一律不得改动（含 package.json、docs/OPS-CC-CHAIN.md——后者主 agent 已更新）。

【要求】
1) lib/cc-channel.js：
   - 新增 kind 'marker-missing'（判定位置见上）；
   - JSDoc 的 @returns 联合类型补齐 'marker-missing'，函数头注释里列出的 errorCode 取值清单也补上 cc-marker-missing。
2) lib/cc-stats.mjs：
   - FAILURE_RULES 新增 cc-marker-missing（位置见上）；
   - 文件头注释里列举 errorCode 取值的那段（约 L25-33）同步补上 cc-marker-missing，保持两处清单一致。
3) **不得改变既有分类行为**：无 errorCode 的普通失败、配额/权限/超时/contract-reject/artifact-missing/
   timeout-still-running/cc-watchdog-stale 的既有归类必须一律不变。
4) 测试（≥5 例，纯函数、不碰网络）：
   - cc-channel：errorCode=cc-marker-missing 且 status='failed' → kind === 'marker-missing'（**不是** code-failed）；
   - cc-channel：claudeLogText 含 done.flag=missing 且带该 errorCode → 仍为 marker-missing；
   - cc-channel（反向回归）：无 errorCode 但 status='failed' → 仍为 'code-failed'（证明新分支没有吞掉旧行为）；
   - cc-stats：reason 'cc-marker-missing' → category === 'cc-marker-missing'（**不是** runner-failed）；
   - cc-stats（反向回归）：reason 'claude exit≠0，done.flag missing'（无该 errorCode 字面量）→ 仍为 'runner-failed'。
   既有用例不得减少。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check lib/cc-channel.js && node --check lib/cc-stats.mjs 通过；
② node --test --test-reporter=tap test/cc-channel.test.js test/cc-stats.test.mjs 全绿（贴用例数与清单）；
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单，不要用目录式调用）。
   重要：你在 WSL 下跑测试时，test/shadow-gate.test.js 的 TC-Green / TC-GC / getGitHead **三项会失败**，
   这是**已知的 WSL 环境差异**（同一提交在 Windows 侧全绿，590+ 例 0 失败），**不是你引入的**：
   不要为此做 git stash 自证，也不要试图"修"它们——直接排除该文件并如实说明即可（主 agent 会在 Windows 侧做全量验收）。
   其余用例必须 0 失败；若排除后仍有失败，那才是真问题，必须查清并在报告中给出归因。
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：两处「顺序要求」的改动点 file:line 与为何必须前置的证据、新增用例清单、
   排除 shadow-gate 后的全量结果、未做项与残余风险。`,
};
