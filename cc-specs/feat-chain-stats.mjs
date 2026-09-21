// A4：把「链条派发的编码任务」纳入 cc 通道可靠性统计（补上目标第 (1) 项的审计缺口）
// 动机（主 agent 已取证）：lib/index.js 里 6 处 recordCcStat 全部 kind:'review'，
// 即 /health-check 的 ccStats 只统计 relay 自己派发的**审核**任务，完全不覆盖链条派发的**编码**任务。
export const task = {
  taskId: 'ccfeat-20260916-chainstats',
  kind: 'implement',
  title: '新增 cc 编码通道统计：聚合 cc-tasks 链条任务结果并在 /health-check 暴露（含 marker-missing 单列）',
  refs: ['lib/index.js', 'lib/cc-stats.mjs', 'lib/cc-channel.js'],
  anchors: [
    { file: 'lib/cc-channel.js', pattern: 'export const CC_TASKS_ROOT_DEFAULT', note: 'cc-tasks 根目录常量（复用，勿另写路径）' },
    { file: 'lib/cc-stats.mjs', pattern: 'export function classifyCcFailure', note: '既有失败分类（复用，保证与审核通道同桶）' },
    { file: 'lib/cc-stats.mjs', pattern: 'export function recordCcOutcome', note: '既有统计累积（参考其结构）' },
    { file: 'lib/index.js', pattern: 'async function readCcStatsSummary', note: '既有统计读取（新增读取的姊妹函数）' },
  ],
  acceptance:
    '新增纯函数 summarizeChainTasks(results, {now, windowMs}) 与结果读取器，聚合 cc-tasks/tasks/*/result.json 为'
    + '{ total, ok, failed, markerMissing, byFailure, byStatus, successRate, recent[] }，失败分类复用既有 classifyCcFailure（同桶）；'
    + '/health-check 暴露 ccChainStats 字段（与 ccStats 并列）；'
    + '读取必须有界（只取最近 N 个任务、结果带 TTL 缓存复用），**不得让探针超时**（实测影响需给出数字）；'
    + 'cc-marker-missing 必须单列计数，不得混入 failed；目录缺失/单个 result.json 损坏一律 fail-open；'
    + 'node --check 通过；新增用例 ≥8；排除 test/shadow-gate.test.js 后全量 0 失败；verify-files-coverage 通过；'
    + '改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务补上一个**审计缺口**：编码通道的可靠性数据目前完全看不到。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【背景与证据（主 agent 已取证，勿推翻）】
- 目标要求「Claude Code 编码通道稳定可靠……失败分类与降级可审计」。
- 现状：lib/index.js 内 **6 处 recordCcStat 调用全部是 kind:'review'**（位于 relay 自己派发 cc 做**审核**的路径），
  也就是说 /health-check 的 ccStats **只统计审核任务**。
- 而**编码任务**（链条与主 agent 派发的 v1-1 / v1-2 / v2-1 … 以及近期的 fix/feat 任务）结果只留在
  D:\\cc-tasks\\tasks\\<id>\\result.json，**没有任何聚合**。实测该目录在本目标窗口内有 18 个任务，分类分布为
  ok 10 / cc-failed 3 / cc-timeout 1 / cc-quota-exhausted 1 / cc-marker-missing 1 / 无 errorCode 2。
  其中 cc-marker-missing 是**产物完好但没写完成标记**（独立验收 ACCEPT 过多次），把它混进 failed 会严重误导。
- 结论：编码通道（也就是目标真正关心的那条通道）的可靠性目前**不可从 /health-check 观测**。

【必须回源核对的既有契约（不要凭记忆，先读源码）】
- lib/cc-channel.js 的 CC_TASKS_ROOT_DEFAULT（= 'D:\\\\cc-tasks'）与相关路径解析辅助——**复用它**，不要另写路径常量。
- lib/cc-stats.mjs：classifyCcFailure(reasonText) 返回 { category, detail }，其 FAILURE_RULES 已含
  cc-marker-missing / cc-quota-exhausted / cc-permission-denied / cc-timeout / runner-failed 等桶；
  recordCcOutcome / summarizeCcStats 的结构可作参考。**复用 classifyCcFailure，不要另立一套分类。**
- lib/index.js：readCcStatsSummary（约 L3525）、recordCcStat（约 L3518）、/health-check handler（其中已有
  ccStats 字段与 healthCache TTL 缓存机制，约 L2204 附近注释说明该端点稳定耗时 ~1520ms 而 watchdog 探针超时 4000ms）。
- result.json 的字段：{ status: 'done'|'failed', start, end, exit, errorCode?, reason? }。
  注意：**status==='failed' 且 errorCode==='cc-marker-missing' 时，产物实际经独立验收为 ACCEPT**
  ——这正是要单列的原因。

【要求】
1) 新增纯函数（可放 lib/cc-stats.mjs，或新建 lib/cc-chain-stats.mjs 并在 package files 覆盖范围内——lib 目录整体已覆盖）：
   summarizeChainTasks(results, { now = Date.now(), windowMs = 7*24*3600*1000 } = {}) → {
     total, ok, failed, markerMissing, byFailure: {category: count}, byStatus: {status: count},
     successRate, avgElapsedMs, recent: [{ taskId, status, errorCode, category, elapsedMs, at }]  // 最近 ≤10
   }
   - 分类：status==='done' → ok；errorCode==='cc-marker-missing' → 计入 **markerMissing 单列**（**不计入 failed**）；
     其余 status==='failed' → 计入 failed 并按 classifyCcFailure(errorCode || reason) 归桶；
     无法判定/字段缺失 → 归 'unknown' 桶，不抛错。
   - windowMs 按 result.json 的 start（缺失则跳过该条）过滤；边界值（start 恰在窗口边缘）行为要写进注释与用例。
   - 纯函数：不读盘、不抛错（畸形输入 fail-open）。
2) 结果读取器：扫描 cc-tasks 根下 tasks/*/result.json，**必须有界**：
   - 只取最近 N=100 个任务目录（按目录 mtime 倒序），避免 tasks 目录无界增长拖慢；
   - 单个文件损坏/不可读 → 跳过并计数，不抛；
   - 目录不存在 → 返回空统计 + 原因，不抛（fail-open）。
3) /health-check 暴露：新增 ccChainStats 字段（与 ccStats 并列）。
   **性能硬要求**：该端点被 watchdog 以 4s 超时探测，超时会导致误判宿主挂掉 → 触发重启。
   因此读取结果**必须复用既有 TTL 缓存机制**（与 ccStats 同款，不要把无缓存的重扫塞进请求路径）；
   并在报告中给出**实测**：加入该字段前后的 health-check 耗时对比（毫秒），证明未接近超时。
4) 不得改动既有 ccStats（审核通道）的语义与字段；不得改动 recordCcStat 既有调用点。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/lib/cc-stats.mjs（或新建 lib/cc-chain-stats.mjs，二者择一，不要都改）
- /mnt/d/dsh-web-relay/test/cc-stats.test.mjs（已存在则扩充；若新建了模块则同时新建对应测试文件）
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md
其它文件一律不得改动（含 package.json、lib/cc-channel.js —— 后者只读复用）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 全部改动文件通过；
② node --test --test-reporter=tap <你的测试文件> 全绿，新增用例 ≥8，至少覆盖：
   - done → ok；failed + 无 errorCode → failed + unknown 桶；failed + cc-failed → failed + runner-failed 类桶；
   - **cc-marker-missing → markerMissing 单列且不计入 failed**（本次核心）；
   - cc-quota-exhausted / cc-timeout 各自归桶（与审核通道同桶名）；
   - windowMs 过滤（窗口外任务不计入）；start 缺失的条目被跳过；
   - 畸形输入（null / 缺字段 / errorCode 为数字）不抛错；
   - 空数组 → total=0 且 successRate 为 null（或文档化的中性值），不出现 NaN；
   - recent 上限 10 且按时间倒序。
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单，不要用目录式调用）。
   重要：你在 WSL 下跑测试时 test/shadow-gate.test.js 的 TC-Green / TC-GC / getGitHead **三项会失败**，
   这是**已知的 WSL 环境差异**（同一 commit 在 Windows 侧全绿，581 例 0 失败），**不是你引入的**：
   不要做 git stash 自证，也不要试图「修」它们——直接排除该文件并如实说明。
④ node scripts/verify-files-coverage.mjs 通过；node scripts/verify-capabilities.mjs 与
   node scripts/sync-engine-docs.mjs --check 仍须通过（若你新增/改动路由或环境开关，必须同步文档，
   否则 --check 会报漂移）；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：6 处 recordCcStat 均 kind:'review' 的取证行号、CC_TASKS_ROOT_DEFAULT 复用点、
   summarizeChainTasks 的桶定义与边界取舍、**health-check 耗时前后实测数字**、用例清单、未做项与残余风险。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
