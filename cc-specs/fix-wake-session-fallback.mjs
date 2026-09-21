// 修复：唤醒目标解析必须带上"最近落盘 expr 的 sessionId"回退 —— 否则能力只能记录、不能唤醒。
//
// 背景（2026-09-18 实测，主 agent 已取证）：
//   · 宿主启动器 dsh-web-watchdog.cmd 只注入 DSH_WEB_ARGS / DSH_RELAY_WORKSPACE / DSH_RELAY_REPO / DSH_WEB_LOG，
//     **没有 DSH_SESSION_ID**；而 v12 的 pending-human 路径只读 env → 判定成立却永远没有唤醒目标。
//   · 这不是推断：插件自己的心跳日志长期在打
//       [dsh-web-relay] 心跳自查：有待办但无 sessionId（expr 未落盘且宿主 env 无 DSH_SESSION_ID），仅记录留痕
//     —— 也就是说"唤醒主 agent"这条能力在本机**一直是空转的**，只是没人注意。
//   · 仓库里**早就有**回退实现：mostRecentExprSessionId()（取最近 updatedAt 的落盘 expr 的 sessionId）。
//     v12 没用它 —— 因为主 agent 写规格时只写了"sessionId 取 process.env.DSH_SESSION_ID"（规格写窄了，本任务纠正它）。
//
// 外部验收探针：probes/pending-human-repo-accept.mjs（同步扩展：新增 3 条"唤醒目标解析"断言与 2 条接线断言）。
// 实测基线：**修复前 21/24 FAIL**（3 条失败全在唤醒目标解析；两个平台判定一致）。
export const task = {
  taskId: 'ccfix-20260918-wakesession',
  kind: 'implement',
  title: '唤醒目标解析补回退：env(DSH_SESSION_ID) → 最近落盘 expr 的 sessionId（否则本机永远无法唤醒）',
  refs: ['lib/pending-human.mjs', 'lib/index.js', 'test/pending-human.test.js'],
  acceptanceScript: 'probes/pending-human-repo-accept.mjs',
  anchors: [
    { file: 'lib/pending-human.mjs', pattern: 'export function pendingHandoffText', note: '同模块新增纯函数 resolveWakeSessionId（便于注入测试）' },
    { file: 'lib/index.js', pattern: 'const sessionId = process.env.DSH_SESSION_ID || null', note: '要改的那一行：只读 env，缺回退' },
    { file: 'lib/index.js', pattern: 'async function mostRecentExprSessionId', note: '**复用**这个既有回退（不要新造一套扫描）' },
    { file: 'lib/index.js', pattern: 'let lastPendingHuman = null', note: 'pendingHuman 的状态载体（唯一锚点；原用 pendingHuman 会命中 5 次，check-spec 已告警）' },
  ],
  acceptance:
    '① 在 lib/pending-human.mjs 新增**纯函数** resolveWakeSessionId({ env, recentExprSessionId }) → { sessionId, source }，'
    + '规则：env 有值 → { sessionId: env, source: "env" }；env 空但 recentExprSessionId 有值 → { sessionId: recentExprSessionId, source: "recent-expr" }；'
    + '两者都空 → { sessionId: null, source: "none" }。**不得**在有值时返回 null，也**不得**凭空造目标。'
    + '② lib/index.js 的 pending-human 唤醒路径改为使用该函数：env 取 process.env.DSH_SESSION_ID，'
    + '回退值取**既有** mostRecentExprSessionId()（await，已有函数，勿重复实现扫描）。'
    + '③ /health-check 的 pendingHuman 增列 sessionIdSource（"env" | "recent-expr" | "none"），'
    + '并在两者皆空时把 error 写成可排查的说明（含"无 DSH_SESSION_ID 且无落盘 expr sessionId"字样）。'
    + '④ 行为边界不变：dryRun 仍不得真唤醒；无 target 时不调用 wakeMainAgent；一切失败 fail-open。'
    + '⑤ 新增用例 ≥4（env 有值；env 空+recent 有值；两者皆空；source 取值正确），既有用例不减；'
    + 'node --check 通过；排除 test/shadow-gate.test.js 后全量 0 失败；verify-files-coverage 通过；改动文件 LF/无 BOM；'
    + '仅改 lib/pending-human.mjs、lib/index.js、test/pending-human.test.js',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务修一个"能力形同虚设"的缺口。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【问题（主 agent 已取证，报告里请引用这两条实测证据）】
1. 宿主启动器 C:\\Users\\Administrator\\dsh-web-watchdog.cmd 只注入
   DSH_WEB_ARGS / DSH_RELAY_WORKSPACE / DSH_RELAY_REPO / DSH_WEB_LOG —— **没有 DSH_SESSION_ID**。
2. 插件心跳日志长期打印：
   [dsh-web-relay] 心跳自查：有待办但无 sessionId（expr 未落盘且宿主 env 无 DSH_SESSION_ID），仅记录留痕
   即"唤醒主 agent"这条能力在本机**一直是空转的**：判定成立，却没有唤醒目标。
3. 上一轮（v12）新增的 pending-human 唤醒路径同样只读了 env（见 lib/index.js 里
   'const sessionId = process.env.DSH_SESSION_ID || null' 这一行），因此"链条停下等人 → 自动叫醒主 agent"
   在这台机器上只会记录、不会真的叫醒。
4. 仓库里**早就有**回退：大多数场景用的是 mostRecentExprSessionId()（取最近 updatedAt 的落盘 expr 的 sessionId）。
   本任务把它接到 pending-human 路径上。

【硬性要求 1：新增纯函数（便于注入测试，不要在里面读 process.env）】
在 lib/pending-human.mjs 导出：
  resolveWakeSessionId({ env, recentExprSessionId }) → { sessionId, source }
  · env 有值                → { sessionId: env, source: 'env' }
  · env 空、recent 有值      → { sessionId: recentExprSessionId, source: 'recent-expr' }
  · 两者都空                → { sessionId: null, source: 'none' }
  不许在有值时返回 null；不许凭空造目标；不要抛异常。

【硬性要求 2：接线（复用既有实现，别新造扫描）】
lib/index.js 中 pending-human 的唤醒分支改为：
  const resolved = resolveWakeSessionId({ env: process.env.DSH_SESSION_ID || null, recentExprSessionId: await mostRecentExprSessionId() })
  然后按 resolved.sessionId 决定是否调用既有 wakeMainAgent({ sessionId, handoffText: pendingHandoffText(entry) })。
  · mostRecentExprSessionId 是**已存在**的函数（同文件内，async），直接 await 调用即可，**不要**另写一份扫描。
  · 注意：boot 路径与心跳路径都走这段逻辑，解析失败必须 fail-open（不得让启动/心跳抛异常）。

【硬性要求 3：可观测】
/health-check 的 pendingHuman 增列 sessionIdSource（'env' | 'recent-expr' | 'none'）。
当 sessionId 为 null 时，error 必须包含"无 DSH_SESSION_ID 且无落盘 expr sessionId"这类可排查字样（不要只说"缺失"）。

【行为边界（别扩大）】
· dryRun 条目仍**不得**真的唤醒（保持上一轮语义）；resolution 为 none 时**不得**调用 wakeMainAgent。
· 不要改启动器（.cmd/.vbs）、不要改链条侧文件、不要新增端点、不要动既有续跑语义。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/pending-human.mjs
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/test/pending-human.test.js
其它文件一律不得改动。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 全部改动文件通过；
② 新增用例 ≥4（env 有值 / env 空+recent 有值 / 两者皆空 / source 取值正确），既有用例不减；
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式文件清单；该文件的 WSL 环境差异是已知问题，不要"修"）；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：resolveWakeSessionId 的实现与规则表、接线处的改动前后行、sessionIdSource 的取值、
   以及"为什么这条回退是把『能记录』变成『能唤醒』的关键"（引用上面两条实测证据）。
⑧ 冒烟自证（必须做）：运行 node /mnt/d/dsh-web-relay/probes/pending-human-repo-accept.mjs 并贴完整输出
   （该探针真 import 你的模块调纯函数并校验接线，当场可判；**不需要**重启宿主）。
   若本任务落地后仍有失败项，请如实贴出，不要伪造。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
