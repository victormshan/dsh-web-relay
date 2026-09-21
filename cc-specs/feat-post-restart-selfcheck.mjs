// 新功能：重启后自检钩子（boot self-check）——宿主起来后自动比对交付漂移 + 可选跑回归，
// 仅在发现问题时唤醒主 agent，使「重启 → 自动发现问题 → 自动叫醒主 agent」闭环，
// 不再依赖人工发现页面异常或主 agent 恰好想起台账。
//
// 事故依据（2026-09-15）：宿主重启后 relay 的 bootResumeScan 合法地报「续跑 0」——
// 它只捞在飞的 expr，已 finalize 的计划永远不在名单里；而 harness 侧 goal 又被重启解除武装，
// 于是三副本里仍留着修复前的 bin/watchdog.mjs（交付漂移），却没有任何机制叫醒主 agent。
export const task = {
  taskId: 'ccfeat-20260915-selfcheck',
  kind: 'implement',
  title: '新增重启后自检钩子：boot 时比对交付漂移 + 可选回归，仅在异常时唤醒主 agent 并在 /health-check 暴露',
  refs: ['lib/index.js', 'lib/selfcheck.mjs', 'lib/cc-stats.mjs'],
  acceptance:
    'boot 路径新增自检（与 bootResumeScan 同批次、异步、绝不阻塞）；默认做两项进程内检查：'
    + '① 交付漂移（REPO_ROOT 源码 vs 本插件实际加载副本，按 package.json files 清单逐文件 sha256）；'
    + '② 路由契约自检（自身已注册路由存在 + /health-check 审计字段齐备）；'
    + '可选经 DSH_RELAY_SELFCHECK_CMD 跑外部命令（异步 spawn，非 execSync）作为重回归；'
    + '仅当发现问题才调用既有 wakeMainAgent 唤醒主 agent（每 boot 一次、不刷屏、无问题绝不打扰）；'
    + '结果落盘并在 /health-check 暴露 selfCheck 字段；全部 fail-open（任何异常只记录不抛出、不影响 boot）；'
    + 'node --check 通过；新增用例 ≥6；排除 test/shadow-gate.test.js 后全量 0 失败；verify-files-coverage 通过；'
    + '改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务新增一个「重启后自检钩子」，让宿主重启后能自动发现交付漂移并叫醒主 agent。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【背景（主 agent 已取证，勿推翻）】
- 2026-09-15 实测：宿主重启后 relay 的 bootResumeScan 打印「重启续跑扫描完成：… 续跑 0（）｜熔断 0（）」——
  这是**正确行为**（它只续跑在飞的 expr，已 finalize 的计划不在名单里），但后果是：三副本里仍留着修复前的
  bin/watchdog.mjs（**交付漂移**），却没有任何机制叫醒主 agent 去同步，直到用户发现异常。
- 另一个背景：harness 侧 goal 会被宿主重启**解除武装**，需要人开口才重新武装；relay 侧唤醒是唯一可自动化的通道。
  因此本钩子要做的事就是：把「重启后该做的检查」变成 relay 自己的 boot 动作，并在**发现问题时**通过既有唤醒通道叫人。

【必须先看懂并复用的既有设施（行号为主 agent 实测，可能因你的改动小幅漂移，按符号名定位为准）】
- 唤醒主 agent：lib/index.js 约 L1780 的 async function wakeMainAgent({ sessionId, handoffText })——
  返回 { agentWoken, reason }，要求 apiProxy 可用且 sessionId 非空。**必须复用它**，不要自己造注入通道。
- boot 扫描挂载点：lib/index.js 约 L1880 的 async function bootResumeScan()（其收尾日志在约 L1898）。
  自检必须挂在它附近/同一 boot 序列，且**不得阻塞它**。
- 交付两端：REPO_ROOT（lib/index.js 约 L1713，取自 env DSH_RELAY_REPO，缺失时由 import.meta.url 上溯）是**源码端**；
  本插件实际加载副本的位置由 import.meta.url 推导，是**运行端**。漂移 = 两端按 package.json 的 files 清单逐文件比对。
- health-check 载荷：lib/index.js 约 L1978（默认值块）与约 L2045（return { bridge, channelStats, restartStats,
  dialogFallbackRatio… }）——新增 selfCheck 字段必须**同时**加进默认值块与返回体，并纳入既有缓存逻辑。
- 已有的 child_process 用法：lib/index.js L18 目前只 import 了 execSync。

【硬性设计约束（违反即视为不合格）】
1) **绝不阻塞事件循环**：外部命令必须用异步 spawn（node:child_process 的 spawn）配合超时与 kill，
   **严禁**用 execSync/execSync 包装跑长任务。理由：宿主探针 4s 超时、连续 6 次失联即触发 watchdog 重启宿主；
   一次 1-2 分钟的同步阻塞会造成「探针连续超时 → watchdog 杀宿主 → 重启风暴」，正是本会话刚修掉的故障。
   本任务的自检自身也必须是异步的，**不得**出现在 boot 的同步路径上。
2) **默认轻量**：不设 DSH_RELAY_SELFCHECK_CMD 时，只做纯进程内检查（漂移 + 路由契约），耗时应在亚秒级。
   外部重回归（例如主 agent 的 regression-post-restart.mjs）严格**opt-in**，由 DSH_RELAY_SELFCHECK_CMD 指定。
3) **每 boot 只跑一次**：以 bootId 为幂等键，落盘后重复调用直接跳过（防 boot 重入/多次扫描重复唤醒）。
4) **无问题绝不打扰**：只有检出漂移或检查失败才唤醒主 agent；一切正常时只落盘 + 暴露字段，**不发**任何唤醒。
5) **全程 fail-open**：REPO_ROOT 缺失/不可读、清单缺失、外部命令不存在或超时、spawn 失败、sessionId 缺失——
   一律只记录原因并继续，**不得**抛出、不得影响 boot、不得让 /health-check 500。
6) **必须可审计**：结果落盘到 workspace 下 web-relay/selfcheck/<bootId>.json，并在 /health-check 暴露
   selfCheck: { at, bootId, ran, drift: {checked, differing: [...]}, contract: {ok, failed: [...]},
   external: {ran, ok, reason, tail} | null, notified: bool, wakeReason }。

【要求】
1) 新增 lib/selfcheck.mjs，把可测逻辑做成**纯函数**（不碰 IO），至少包含：
   - 清单展开与比对：给定源码端与运行端根目录 + files 清单 + 读文件/哈希注入函数 → 返回差异清单（相对路径）；
   - 判定是否需通知：给定 drift 与 contract 结果 → 是否需要唤醒（纯布尔）；
   - 外部命令结果映射：exitCode/超时/信号 → { ok, reason }（非 0 与超时要能区分）；
   - 幂等判定：给定上次记录的 bootId 与本 bootId → 是否跳过。
2) lib/index.js：在 boot 序列里挂异步自检（不阻塞），结果写盘 + 写 health-check 字段；仅异常时调用
   wakeMainAgent（sessionId 取 process.env.DSH_SESSION_ID，缺失则回退到最近一个 expr 的 sessionId；
   两者皆无则只落盘并记 wakeReason，不报错）。
   handoffText 要具体可执行：写明「重启后自检发现 N 项异常」，逐条列出差异文件或失败检查，
   并提示主 agent 用交付工具同步三副本、跑回归脚本。
3) **不得**改动既有 bootResumeScan 的行为与日志格式；不得改动既有 /health-check 字段语义。
4) 文档：docs/CC-HYBRID.md 增加一节（背景、开关、字段、失败模式）；
   docs/OPS-CC-CHAIN.md 的「重启后核验」处补一句：自检结果看 /health-check 的 selfCheck 字段。
5) 测试 ≥6 例（纯函数，不碰网络、不 spawn 真进程）：
   - 两端一致 → drift 为空；单文件不同 → 精确定位到该相对路径；
   - 运行端缺文件 / 源码端缺文件 → 分别归类（不得混为一谈）；
   - 判定：仅 drift 或仅 contract 失败时均需通知；两者皆无则不通知；
   - 外部结果映射：exit 0 → ok；exit≠0 → fail 且带 tail；超时 → fail 且 reason 含 timeout（与 exit≠0 可区分）；
   - 幂等：同 bootId → skip，不同 bootId → run；
   - 源码契约：断言 lib/index.js **未**用 execSync 跑自检外部命令（防止后人图省事退回阻塞实现）。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/selfcheck.mjs（新建）
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/test/selfcheck.test.js（新建）
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md
- /mnt/d/dsh-web-relay/docs/OPS-CC-CHAIN.md
其它文件一律不得改动（含 package.json；lib 目录已在 files 清单内，无需改清单）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check lib/selfcheck.mjs && node --check lib/index.js 通过；
② node --test --test-reporter=tap test/selfcheck.test.js 全绿（贴用例数与清单）；
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单，不要用目录式调用）。
   重要：你在 WSL 下跑测试时 test/shadow-gate.test.js 的 TC-Green / TC-GC / getGitHead **三项会失败**，
   这是**已知的 WSL 环境差异**（同一提交在 Windows 侧全绿，538 例 0 失败），**不是你引入的**：
   不要做 git stash 自证，也不要试图「修」它们——直接排除该文件并如实说明即可（Windows 侧全量验收由主 agent 做）。
④ node scripts/verify-files-coverage.mjs 通过（新模块必须被 package files 覆盖）；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：设计要点与「为何必须异步、绝不 execSync」的说明、开关与字段清单、
   boot 挂载点 file:line、新增用例清单、未做项与残余风险（尤其：外部命令默认不跑，需要 env 才启用的理由）。`,
};
