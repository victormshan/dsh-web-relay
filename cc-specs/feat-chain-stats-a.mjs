// A4a（A4 的第一半，拆分后）：编码通道统计的纯函数 + 有界读取器 + 用例
// 拆分理由：A4 原为 5 文件 + 性能实测要求，实测在 490s 处因配额耗尽中断（产物只到一半、无测试）。
// 按粒度纪律拆成 A4a（本任务：纯逻辑与读取器，可独立验收）与 A4b（接线 /health-check + 文档 + 性能实测）。
export const task = {
  taskId: 'ccfeat-20260916-chainstats-a',
  kind: 'implement',
  title: '编码通道统计（上半）：summarizeChainTasks 纯函数 + 有界结果读取器 + 用例',
  refs: ['lib/cc-stats.mjs', 'lib/cc-channel.js', 'test/cc-stats.test.mjs'],
  anchors: [
    { file: 'lib/cc-stats.mjs', pattern: 'export function classifyCcFailure', note: '既有失败分类（复用，勿另立一套）' },
    { file: 'lib/cc-stats.mjs', pattern: 'export function recordCcOutcome', note: '既有统计累积（结构参考）' },
    { file: 'lib/cc-channel.js', pattern: 'export const CC_TASKS_ROOT_DEFAULT', note: 'cc-tasks 根目录常量（复用）' },
  ],
  acceptance:
    'lib/cc-stats.mjs 新增纯函数 summarizeChainTasks(results, { now, windowMs }) 与有界读取器 loadChainTaskResults({ root, fsImpl, limit, now })；'
    + '分类复用既有 classifyCcFailure；cc-marker-missing **单列不计入 failed**；窗口外与 start 缺失的条目跳过；畸形输入不抛错；'
    + '空输入 total=0 且不出现 NaN；recent ≤10 且按时间倒序；读取器只用最近 N 个任务目录（默认 100）；'
    + 'node --check 通过；新增用例 ≥8 且既有用例不减；排除 test/shadow-gate.test.js 后全量 0 失败；'
    + 'verify-files-coverage 通过；改动文件 LF/无 BOM；**不改 lib/index.js**（接线属 A4b）',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务只做**纯逻辑层**：把「编码通道可靠性统计」的数据结构与聚合逻辑做出来并测好。接线到 /health-check 由后续任务负责，**本任务不要改 lib/index.js**。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【背景（主 agent 已取证）】
目标要求「Claude Code 编码通道稳定可靠……失败分类与降级可审计」。但实测发现：lib/index.js 内
**6 处 recordCcStat 调用全部是 kind:'review'**（relay 自己派发**审核**任务的路径），也就是说
/health-check 的 ccStats **只统计审核任务**；而**编码任务**（链条与主 agent 派发的 v1-1 / v2-1 / 近期 fix/feat 任务）
结果只留在 D:\\cc-tasks\\tasks\\<id>\\result.json，**没有任何聚合**。
实测该目录在本目标窗口内有 18 个任务，分类分布 ok 10 / cc-failed 3 / cc-timeout 1 / cc-quota-exhausted 1 /
cc-marker-missing 1 / 无 errorCode 2。其中 cc-marker-missing 是**产物完好但没写完成标记**（多次经独立验收 ACCEPT），
把它混进 failed 会严重误导。

【必须回源核对的既有契约（不要凭记忆）】
- lib/cc-stats.mjs：classifyCcFailure(reasonText) → { category, detail }，其 FAILURE_RULES 已含
  cc-marker-missing / cc-quota-exhausted / cc-permission-denied / cc-timeout / runner-failed 等桶；
  **复用它，不要另立分类**。recordCcOutcome / summarizeCcStats 可作结构参考（RECENT_LIMIT=10）。
- lib/cc-channel.js：CC_TASKS_ROOT_DEFAULT（'D:\\\\cc-tasks'）与 resolveTasksRoot(env)；
  **复用**，不要另写路径常量。
- result.json 字段：{ status: 'done'|'failed', start?, end?, exit?, errorCode?, reason? }。
- 注意：**status==='failed' 且 errorCode==='cc-marker-missing' 时，产物实际经独立验收为 ACCEPT**
  ——这正是必须单列的原因。

【要求】
1) 纯函数（放 lib/cc-stats.mjs，导出）：
   summarizeChainTasks(results, { now = Date.now(), windowMs = 7*24*3600*1000 } = {}) → {
     total, ok, failed, markerMissing,
     byFailure: { <category>: count }, byStatus: { <status>: count },
     successRate,        // ok/total；total=0 时为 null（**不得出现 NaN**）
     avgElapsedMs,       // 有 end 与 start 的条目才算；无样本为 null
     recent: [ { taskId, status, errorCode, category, elapsedMs, at } ]   // 最近 ≤10，按时间倒序
   }
   - 计入规则：status==='done' → ok；errorCode==='cc-marker-missing' → **markerMissing 单列，不计入 failed**；
     其余 status==='failed' → failed，并用 classifyCcFailure(errorCode || reason || '') 归入 byFailure；
     无法判定 → category='unknown'（仍计入 failed），**不抛错**。
   - 时间与窗口：按 result.json 的 start 过滤（缺失 start 的条目**跳过**，不参与任何计数）；
     边界取舍（start 恰等于 now-windowMs 时算不算）要在注释与用例里写明并锁定。
   - results 非数组 / 元素非对象 / 字段类型异常 → 逐条跳过，不抛错。
2) 有界读取器（同文件导出）：
   loadChainTaskResults({ root = CC_TASKS_ROOT_DEFAULT, fsImpl, limit = 100, now = Date.now() } = {}) → Promise<{ results, scanned, skipped, reason }>
   - 只取 tasks/ 下最近 limit 个目录（按目录 mtime 倒序），避免目录无界增长（实测已 46 个子目录且持续增长）；
   - 逐目录读 result.json：文件不存在/JSON 损坏 → 计入 skipped 并继续，**不抛**；
   - tasks/ 或 root 不可访问 → 返回 { results: [], scanned: 0, skipped: 0, reason: '...' }，**不抛**；
   - fsImpl 需可注入（测试用内存 fake）；未注入时用 node:fs/promises 默认实现。
   - **不要在此读 claude.log**（避免无界 IO）；本任务只读 result.json。
3) 不得改动既有 ccStats（审核通道）的任何语义；不得改动 lib/index.js。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/cc-stats.mjs
- /mnt/d/dsh-web-relay/test/cc-stats.test.mjs（扩充）
其它文件一律不得改动（含 lib/index.js、package.json、docs/）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check lib/cc-stats.mjs 通过；
② node --test --test-reporter=tap test/cc-stats.test.mjs 全绿，新增用例 ≥8（既有用例不得减少、不得改其断言），至少覆盖：
   - done → ok；failed 无 errorCode → failed + unknown 桶；failed + cc-failed → 归入 runner-failed 类桶；
   - **cc-marker-missing → markerMissing 单列且不计入 failed**（本任务核心）；
   - cc-quota-exhausted / cc-timeout 各自归桶（与审核通道同桶名）；
   - windowMs 过滤（窗口外不计入）；**start 缺失的条目被跳过**；
   - 畸形输入（null / 非数组 / errorCode 为数字 / status 缺失）不抛错；
   - 空数组 → total=0、successRate 为 null（**断言不是 NaN**）；
   - recent ≤10 且倒序；avgElapsedMs 无样本为 null；
   - 读取器：目录不存在 → 不抛且返回空；单条 result.json 损坏 → skipped 计数 + 其余正常。
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单，不要用目录式调用）。
   重要：你在 WSL 下跑测试时 test/shadow-gate.test.js 的 TC-Green / TC-GC / getGitHead **三项会失败**，
   这是**已知的 WSL 环境差异**（同一 commit 在 Windows 侧全绿，594 例 0 失败），**不是你引入的**：
   不要做 git stash 自证，也不要试图「修」它们——直接排除该文件并如实说明。
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：6 处 recordCcStat 均 kind:'review' 的取证行号（只读核对，不要改）、classifyCcFailure 复用点、
   桶定义与窗口边界取舍、读取器的有界策略、用例清单、未做项（接线与性能实测属后续任务）。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
