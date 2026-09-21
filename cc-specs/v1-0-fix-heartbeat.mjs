// cc 修复任务规格：watchdog liveness 探针误判（fail-open 修正 + 真实心跳信号）
// 背景：ccrel-20260913173446 已实现 ccWatchdogAlive，但把「watchdog.log mtime 新鲜度」当作阻塞判据。
//      实测 D:\cc-tasks\watchdog.log 是事件驱动日志（仅 start/dispatch/reject 时写），
//      在 watchdog 进程健康存活（PID 6572）且 12 分钟前刚成功派发任务的情况下，
//      探针仍返回 { ok:false, reason:'cc-watchdog-stale:762697' }。
//      → 若按此实现上线，生产环境每次 review 派发都会被瞬间短路，cc 通道整体失效。
// 本任务：把「心跳不新鲜」从阻塞判据降级为告警信号（fail-open），结构缺失仍阻塞；
//        并让心跳信号变成真的（watchdog 每轮 touch 心跳文件）。
export const task = {
  taskId: 'ccfix-20260914-hb3',
  kind: 'implement',
  title: '修正 cc 通道 watchdog 探针误判：心跳不新鲜 fail-open（不阻塞派发）+ 补真实心跳文件',
  refs: [
    'lib/cc-channel.js',
    'lib/index.js',
    'test/cc-channel.test.js',
    'docs/CC-HYBRID.md',
  ],
  acceptance:
    '真实 D:\\cc-tasks 目录下 ccWatchdogAlive 返回 ok:true（心跳陈旧但结构完好，不得误判为不可用）；'
    + 'queue/tasks 结构缺失仍然 ok:false 阻塞派发；DSH_CC_WATCHDOG_STRICT=1 时陈旧恢复为阻塞；'
    + 'cc-watchdog.sh.new 每轮 touch 心跳文件且不改动运行中的 cc-watchdog.sh；'
    + '配额耗尽可分类为 cc-quota-exhausted 并尽力解析 resetsAt，与真实代码失败可区分；'
    + 'node --check 通过；全量 node --test 全绿且新增用例≥4；改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务修复上一任务（ccrel-20260913173446）引入的一个**会打断 Claude Code 通道**的集成缺陷。结论必须附命令输出作为证据。

仓库根：/mnt/d/dsh-web-relay（当前权威源码）

【关键事实（主 agent 已实测，不要推翻，只需据此修正）】
1. \`D:\\cc-tasks\\watchdog.log\` 是**事件驱动**日志：cc-watchdog.sh 只在 startup/start/dispatch/REJECT 时 echo，轮询循环内不写日志。
   实测：watchdog 进程 /bin/bash /mnt/d/cc-tasks/cc-watchdog.sh（PID 6572）健康存活、12 分钟前刚成功派发任务，
   但 watchdog.log 的 mtime 距今 762697ms。
2. 因此现有 \`ccWatchdogAlive\` 在真实目录下的实测结果是：
   \`{"ok":false,"reason":"cc-watchdog-stale:762697.7897949219","details":{"logAgeMs":762697.7,"queueDepth":1,"tasksCount":27}}\`
   —— 结构完好（queue/tasks 可读）却被判不可用。
3. \`cc-stats.json\` 更旧（距今约 2.9 天），同样不能当心跳。
4. 后果（必须修掉）：\`lib/index.js\` 在 \`runCcReviewTask\` 派发前用该结果做阻塞门，\`ok:false\` 直接 return，
   于是生产环境**每一次** cc 审核派发都会被瞬间短路，cc 通道等于整体失效，而这正是本插件三方协议最依赖的编码通道。

【设计原则（必须遵守）】
失败方向必须选对：探针的错误代价不对称。把「其实活着」误判为「死了」＝通道整体丢失（严重）；
把「其实死了」误判为「活着」＝只是多等一次既有的轮询超时（可接受）。所以**默认 fail-open**：
只有**结构性**不可用才阻塞派发；心跳陈旧只作为告警信号透出，不阻塞。

【写入范围（严格）】只允许改动/新建以下文件，其他一律不得改动：
- /mnt/d/dsh-web-relay/lib/cc-channel.js
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/test/cc-channel.test.js（可新增用例）
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md（补充说明）
- /mnt/d/cc-tasks/cc-watchdog.sh.new（**新建**，见下；绝对不要修改正在运行中的 /mnt/d/cc-tasks/cc-watchdog.sh，
  因为 bash 是边读边执行脚本文件，就地修改会导致运行中的循环行为错乱/报错）

【修改 1：ccWatchdogAlive 语义修正（lib/cc-channel.js）】
- 心跳文件候选顺序改为：优先专用心跳文件 \`watchdog.heartbeat\`，其次 \`watchdog.log\`（保留 \`cc-stats.json\` 作为最后兜底或移除，随你判断，但要在报告里说明）。
- 返回结构扩展为：\`{ ok, reason, stale, details:{ logAgeMs, queueDepth, tasksCount, heartbeatFile } }\`，
  其中 \`stale:true\` 表示心跳陈旧（告警），\`ok\` 的取值规则如下：
  * 结构缺失（root 不可访问 / queue 目录缺失 / tasks 目录缺失）→ \`ok:false\`（**仍阻塞**），reason 保持 root-unavailable / queue-dir-missing / tasks-dir-missing。
  * 结构完好但心跳缺失或超阈值：
      - 默认（非严格）→ \`ok:true, stale:true, reason:'alive-unverified:<ageMs 或 missing>'\`（**不阻塞**，只告警）
      - \`env.DSH_CC_WATCHDOG_STRICT === '1'\` → \`ok:false, stale:true, reason:'cc-watchdog-stale:<ageMs>'\`（严格模式才阻塞）
  * 结构完好且心跳新鲜 → \`ok:true, stale:false, reason:'alive'\`
- 阈值仍支持 \`DSH_CC_WATCHDOG_STALE_MS\` 覆盖，默认 120000ms。
- **不得**在心跳文件缺失时把它当作 root 不可用；不得 change 既有 \`ccChannelAvailable\` 的行为与签名。

【修改 2：lib/index.js 接线】
- 派发前的探针结果只在 \`!watchdog.ok\` 时短路（即只对结构性失败短路）。
- \`watchdog.stale === true\` 时**必须继续派发**，但要：
  * 用 \`console.warn\` 打一条形如 \`[dsh-web-relay] cc 通道心跳告警: <reason>\` 的日志；
  * 把该告警以非阻塞方式记录（例如 recordCcStat 的 reason 或返回对象上附带 \`watchdogWarning\` 字段），
    使 /health-check 侧可见，但**不能**把本次审核记成失败。
- 保留上一任务已实现且正确的部分，不要回退：按 kind 的超时分档（review 150000 / implement、understand ≥900000）、
  \`resolveTimeoutMs\` 优先级（显式 > env > kind 默认）、超时 \`reason:'timeout-still-running'\` 与真失败 \`reason:'failed'\` 的区分。

【修改 3：/mnt/d/cc-tasks/cc-watchdog.sh.new（新建，不覆盖运行中的脚本）】
- 以现有 /mnt/d/cc-tasks/cc-watchdog.sh 为基础**完整复制**，只在轮询循环内加一行心跳：
  \`touch /mnt/d/cc-tasks/watchdog.heartbeat\`（放在每轮 sleep 之前，确保即使队列为空也每轮刷新）。
- 不得改变原有 queue 扫描、v2 校验、dispatch、sleep 5 等逻辑与顺序；加一行即可。
- 在报告里给出 \`diff -u cc-watchdog.sh cc-watchdog.sh.new\` 的输出，证明只多了心跳这一处。
- 不要启动/停止/重启任何 watchdog 进程（换入与重启由主 agent 受控执行）。

【修改 4：配额/限流耗尽必须可审计分类（新增实测证据）】
- 实测：本任务上一次派发（ccfix-20260914-hb 第一次运行）runner 侧 2 分钟后失败，claude.log 只有一行
  \`You've hit your session limit · resets 5:10am (Asia/Shanghai)\`，而 result.json 只记
  \`{"status":"failed","exit":1,"reason":"claude exit=1; done.flag=missing"}\`。
  即：**配额耗尽与真实代码失败在审计上不可区分**，且失败信息里没有「何时可恢复」。
- 要求：
  1) 在 lib/cc-channel.js 增加可注入的纯函数（建议名 \`classifyCcFailure({ result, claudeLogText })\`），
     识别 claude.log / result.json 文本中的配额耗尽特征（至少覆盖 \`session limit\`、
     \`rate limit\`、\`quota\`、\`resets <时间>\`，大小写不敏感），**并直接消费 runner 写入的
     \`result.json.errorCode\`**（runner 现已产出：\`cc-quota-exhausted\`、\`cc-permission-denied\`、
     \`cc-timeout\`、\`cc-failed\`、\`v2-validate-failed\`；实测证据：2026-09-14 ccfix-hb2 因
     Edit 工具未授权被拒 → errorCode=cc-permission-denied），返回
     \`{ kind: 'quota-exhausted' | 'permission-denied' | 'timeout' | 'code-failed' | 'unknown', errorCode: string|null, resetsAt: string|null, raw: string }\`；
     其中 \`permission-denied\` 对应 claude.log 出现 \`permissions to write\`/\`haven't granted\` 或 errorCode=cc-permission-denied；
     \`resetsAt\` 从 \`resets 5:10am (Asia/Shanghai)\` 一类文本中尽力解析（解析不出返回 null，不得抛错）。
  2) \`lib/cc-stats.mjs\` 的失败分类新增 \`cc-quota-exhausted\` 类别（与 \`cc-watchdog-stale\`、
     \`timeout-still-running\` 同级互斥），使 /health-check 的 byFailure 能单列配额耗尽次数。
  3) 派发前若已知配额耗尽（例如最近一次失败是 quota-exhausted 且当前时间早于 resetsAt），
     应直接降级并记 reason=\`cc-quota-exhausted\`（沿用既有降级链），**不要**盲等整个轮询超时再失败。
     该判断必须是可注入 now() 的纯逻辑，便于测试。
  4) 测试新增用例 ≥3：识别 session limit 文本 → quota-exhausted 且解析出 resetsAt；普通退出码/无日志 → code-failed； 
     cc-stats 归类把 cc-quota-exhausted 与 timeout/真失败分开计数。

【测试要求（test/cc-channel.test.js，新增用例≥4，全部用注入的 fake fsImpl，不得读写真实 D:\\cc-tasks）】
1) 心跳新鲜（heartbeat 文件 mtime 接近 now）→ ok:true, stale:false, reason:'alive'，details 含 heartbeatFile。
2) 心跳陈旧且非严格模式 → **ok:true**, stale:true，reason 以 'alive-unverified' 开头（这是本次修复的核心断言，必须有）。
3) 心跳陈旧且 DSH_CC_WATCHDOG_STRICT='1' → ok:false, stale:true, reason 以 'cc-watchdog-stale' 开头。
4) queue 目录缺失 → ok:false, reason:'queue-dir-missing'（结构性问题仍然阻塞）。
5) 专用心跳文件缺失但 watchdog.log 新鲜 → 仍判新鲜（回退链正确）。
（新增后原有关于 ccWatchdogAlive 的用例若断言了旧的阻塞语义，需要一并按新语义修正，并在报告中列出被修正的用例名。）

【硬性验收（逐条自证，贴命令与输出）】
① \`node --check lib/cc-channel.js lib/index.js\` 通过。
② **真实目录回归证据（最关键）**：在仓库内执行下面这条命令，输出必须显示 \`ok:true\`（心跳陈旧但结构完好，不再误判）：
   \`node -e "import('./lib/cc-channel.js').then(async m=>{const r=await m.ccWatchdogAlive({fsImpl:m.nodeFsImpl,root:'D:\\\\\\\\cc-tasks',env:process.env});console.log(JSON.stringify(r))})"\`
   （在 WSL 下把 root 换成 '/mnt/d/cc-tasks' 亦可；必须给出真实输出，不得只给单测结果。）
③ \`node --test --test-reporter=tap test/cc-channel.test.js test/cc-stats.test.mjs\` 全绿（当前基线 55 例，只增不减）。
④ 全量回归：\`node --test --test-reporter=tap $(ls test/*.test.js test/*.test.mjs)\`（WSL 写法）不得新增失败；
   注意：**不要**用 \`node --test test/\`（Node 26 会把目录当单个测试项而报 1 个假失败）。
   主 agent 在 Windows 侧实测基线为 441 例全通过（其中 *.test.js 子集 306 例）。
⑤ \`node scripts/verify-files-coverage.mjs\` 通过。
⑥ 改动/新建文件均为 LF、无 BOM、2 空格缩进。
⑦ \`git -C /mnt/d/dsh-web-relay status --porcelain\` 只出现允许清单内的文件。

【报告要求】out/report.md 必须包含：改动点清单（file:line）、真实目录回归命令与输出、新增/修正的用例名、
未做项与残余风险（尤其是：心跳文件在新脚本换入并重启 watchdog 之前尚不存在，因此默认路径仍是
『心跳缺失→alive-unverified 告警但不阻塞』，这是刻意的 fail-open 设计，请明确写清而不是含糊带过）。`,
};
