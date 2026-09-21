// A4b（A4 的第二半，拆分后）：把 A4a 的纯逻辑接线到 /health-check，并纳入自检契约
// 拆分理由：A4 原为 5 文件 + 性能实测要求，实测在 490s 处因配额耗尽中断（产物只到一半、无测试）。
// A4a（纯逻辑层 + 有界读取器 + 47 例用例）已于 2026-09-16 由 v4 链条无人值守完成并提交 40b36a1。
// 本任务只做接线、契约与文档，且必须复用既有 TTL 缓存，不得把无缓存重扫塞进请求路径。
export const task = {
  taskId: 'ccfeat-20260916-chainstats-b',
  kind: 'implement',
  title: '编码通道统计（下半）：接线 /health-check 暴露 ccChainStats + 自检契约 + 文档同步 + 耗时实测',
  refs: ['lib/index.js', 'lib/cc-stats.mjs', 'lib/selfcheck.mjs', 'docs/CC-HYBRID.md'],
  anchors: [
    { file: 'lib/index.js', pattern: 'const HEALTH_CACHE_MS = Number(process.env.DSH_RELAY_HEALTH_CACHE_MS)', note: '既有 TTL 缓存常量——读数必须走同一缓存' },
    { file: 'lib/index.js', pattern: 'ccStats: heavy.ccStats', note: '并列暴露位：新字段紧邻此处加入响应体' },
    { file: 'lib/index.js', pattern: 'const healthHeavyEmpty = () => ({', note: '缓存空态形状——必须同步补 ccChainStats: null' },
    { file: 'lib/index.js', pattern: 'async function readCcStatsSummary(', note: '姊妹读取函数（结构参考，勿改动其语义）' },
    { file: 'lib/cc-stats.mjs', pattern: 'export function summarizeChainTasks', note: 'A4a 已交付的聚合纯函数（直接复用，勿重写）' },
    { file: 'lib/cc-stats.mjs', pattern: 'export async function loadChainTaskResults', note: 'A4a 已交付的有界读取器（直接复用）' },
    { file: 'lib/selfcheck.mjs', pattern: 'export const SELFCHECK_REQUIRED_HEALTH_FIELDS', note: '字段契约清单——增列 ccChainStats' },
    { file: 'docs/CC-HYBRID.md', pattern: 'ccWatchdogWarning', note: '文档中同类审计字段的记述处（在其附近补新字段说明）' },
  ],
  acceptance:
    '/health-check 响应新增 ccChainStats 字段（与 ccStats 并列），取值来自既有的 heavyHealth TTL 缓存聚合，'
    + '**不得在请求路径内做无缓存重扫**（watchdog 以超时探针判活，超时会误判宿主挂掉）；'
    + '缓存空态函数同步补 ccChainStats: null（形状与命中缓存时一致）；'
    + '复用 lib/cc-stats.mjs 的 loadChainTaskResults 与 summarizeChainTasks，不得另立聚合或分类；'
    + '读取异常一律 fail-open（ccChainStats=null，health-check 仍 200）；'
    + 'SELFCHECK_REQUIRED_HEALTH_FIELDS 增列 ccChainStats，使其随既有重启自检自动校验；'
    + '不得改动既有 ccStats（审核通道）语义与任何 recordCcStat 调用点；'
    + '报告须给出加入该字段前后 /health-check 的**实测耗时数字**并证明未接近探针超时；'
    + 'node --check 通过；新增用例 ≥4 且既有用例不减；排除 test/shadow-gate.test.js 后全量 0 失败；'
    + 'verify-files-coverage / verify-capabilities / sync-engine-docs --check 均通过；'
    + '改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务只做**接线与契约**：把已经做好的纯逻辑挂到 /health-check 上，并让它进入自检契约。纯逻辑本身**不要重写**。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【背景（主 agent 已取证，勿推翻）】
- 目标要求「Claude Code 编码通道稳定可靠……失败分类与降级可审计」。lib/index.js 里既有 6 处 recordCcStat 全部 kind:'review'，即 /health-check 的 ccStats **只统计审核任务**，链条派发的**编码**任务完全不可观测。
- A4a 已落地（提交 40b36a1，主 agent 独立验收 ACCEPT）：lib/cc-stats.mjs 新增
  summarizeChainTasks(results, { now, windowMs }) 与 loadChainTaskResults({ root, fsImpl, limit, now })，
  分类复用既有 classifyCcFailure，cc-marker-missing 单列不计入 failed，读取器只扫最近 100 个任务目录、单目录异常不整体失败。
  **本任务直接 import 复用这两个函数**，不得复制实现、不得另立分类或聚合。
- 上一轮 A4 之所以失败，是因为把「纯逻辑 + 接线 + 文档 + 性能实测」打包成一个任务（490s 处配额耗尽中断）。本任务刻意收窄到接线侧。

【必须回源核对的既有契约（不要凭记忆，先读源码）】
- lib/index.js 的 heavyHealth()（约 L2291）：TTL 缓存 + 后台刷新，**命中缓存即刻返回、过期回旧值并在后台刷新**，
  这正是「探针绝不被扫描阻塞」的机制。collectHeavyHealth()（约 L2284）返回
  { bridge, channelStats, restartStats, dialogFallbackRate, ccStats, selfCheck }，新字段要**加在这个返回体里**。
- healthHeavyEmpty()（约 L2217 附近）：缓存空态形状，其中已有 ccStats: null —— 必须同步补 ccChainStats: null，
  否则「重启后首探」与「命中缓存」两种情形返回体形状不一致。
- healthCheckHandler（约 L2304）：响应体里 ccStats: heavy.ccStats（约 L2329）——新字段紧邻它暴露。
- readCcStatsSummary（约 L3526）：姊妹读取函数，**只作结构参考，不要改动它的行为**。
- lib/selfcheck.mjs 的 SELFCHECK_REQUIRED_HEALTH_FIELDS（约 L191）：契约自检用源码切片断言
  /health-check handler 内是否含预期审计字段。注意其切片策略：从处理函数定义锚点切到下一个 handler 锚点
  （见 sliceHandlerSource），因此 ccChainStats **必须出现在 healthCheckHandler 函数体内**，
  只在 collectHeavyHealth 里出现是不够的。
- 既有实测（写在 lib/index.js 约 L2205 的注释里）：/health-check 稳定耗时约 1520ms，watchdog 探针超时 2000ms（另一处注释写 4000ms）。
  这是硬约束来源：**绝不能把无界扫描塞进请求路径**。

【要求】
1) collectHeavyHealth() 内新增 ccChainStats：调用 loadChainTaskResults({}) 取结果，再用 summarizeChainTasks(结果) 聚合；
   整体包 try/catch，任何异常置为 null（fail-open），绝不让 health-check 因此 500。
2) healthHeavyEmpty() 同步补 ccChainStats: null。
3) healthCheckHandler 响应体在 ccStats 旁新增 ccChainStats: heavy.ccChainStats。
4) lib/selfcheck.mjs 的 SELFCHECK_REQUIRED_HEALTH_FIELDS 增列 'ccChainStats'（放在 ccStats 之后，保持可读）。
5) docs/CC-HYBRID.md 新增一小节说明该字段：语义（链条派发的编码任务聚合）、与 ccStats 的分工
   （审核通道 vs 编码通道）、cc-marker-missing 单列的含义（产物完好但没写完成标记，**不得混入 failed**）、
   有界读取（最近 100 个任务目录）与 TTL 缓存（见 DSH_RELAY_HEALTH_CACHE_MS）。
6) 不得改动 ccStats 的字段与语义；不得改动任何 recordCcStat 调用点；不得改动 lib/cc-stats.mjs 的既有导出行为。
7) 性能实测（写进报告，给**数字**）：在加入该字段前、后各测 /health-check 的耗时（至少各 5 次取中位数与最大值），
   并给出结论：最大值是否仍显著低于探针超时。若本机无法起宿主实测，则如实说明并给出替代证据
   （例如直接对 loadChainTaskResults + summarizeChainTasks 计时，说明其在缓存内只每 TTL 执行一次）。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/lib/selfcheck.mjs
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md
- /mnt/d/dsh-web-relay/test/selfcheck.test.js（**已存在**，扩充即可；其 L261 一带已有「读真实 lib/index.js 源码 + 断言契约清单字段齐备」的端到端用例）
其它文件一律不得改动（含 package.json、lib/cc-stats.mjs、lib/cc-channel.js —— 后两者只读复用）。
若你判断还必须有别的测试文件，先确认它已存在或属于 test/ 目录，并在报告里说明理由。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 全部改动文件通过；
② 新增用例 ≥4，至少覆盖：契约清单含 ccChainStats；healthCheckHandler 源码切片含 ccChainStats；
   healthHeavyEmpty 含 ccChainStats: null；读取异常时 fail-open 为 null（可用源码级或注入式断言，说明所用方式）；
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单，不要用目录式调用）。
   重要：WSL 下该文件的 TC-Green / TC-GC / getGitHead **三项会失败**，这是**已知的 WSL 环境差异**
   （同一 commit 在 Windows 侧全绿），**不是你引入的**：不要 git stash 自证，也不要试图「修」它们，直接排除并如实说明；
④ node scripts/verify-files-coverage.mjs、node scripts/verify-capabilities.mjs、
   node scripts/sync-engine-docs.mjs --check 三者均通过（你改了 /health-check 字段与文档，--check 不得报漂移）；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：heavyHealth TTL 复用点与行号、空态形状补齐处、自检契约增列处、
   **/health-check 耗时前后实测数字（中位数/最大值）**、用例清单、未做项与残余风险。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
