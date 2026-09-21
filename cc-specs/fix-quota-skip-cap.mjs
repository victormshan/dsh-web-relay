// 补策略：**"已知耗尽 → 跳过派发"必须与链条用同一套 cap**，不能让同一个策略在两个消费方有不同保护级别。
//
// 背景（2026-09-19 主 agent 复核 v17 时发现，用户质疑"是不是还没做完"后被证实）：
//   v15/v17 收敛的是**判据**（措辞正则、resetsAt 解析、kind），但**策略**没有收敛：
//     · 链条侧：只在「剩余等待 ≤ shortcutCapMs(kind)」时才短路（周 24h / 会话 6h）——对"resetsAt 被误解析"的保护
//       （解析器会把已过去的时刻**滚到明天** → 最长 ~24h；文件陈旧/被写坏同理）；
//     · 插件侧 lib/cc-channel.js 的 shouldSkipForKnownQuotaExhaustion：`now < resetsAt` 就跳过，**无 cap**。
//   ⇒ 同一份数据，链条有保护、插件没有：一个错误/陈旧的时间戳可以让插件**静默停掉 cc 派发一整个窗口**。
//   并且唯一模块导出的 shortcutCapMs **在仓库里没有任何消费者**（死代码）——"策略未落地"的机器签名。
//   另：插件持久化配额状态时不写 quotaKind，因此即使想按种类取 cap 也取不到。
//
// 外部验收探针：probes/quota-skip-policy-accept.mjs（仓库侧、双平台）。基线 **5/10 FAIL**
//   （session 档 20h 仍跳过、weekly 档 20 天仍跳过、无 quotaKind、shortcutCapMs 无消费者）。
export const task = {
  taskId: 'ccfix-20260919-quotacap',
  kind: 'implement',
  title: '插件"已知耗尽跳过派发"补 cap（复用唯一模块 shortcutCapMs）+ 持久化 quotaKind',
  refs: ['lib/cc-channel.js', 'lib/index.js', 'test/cc-channel.test.js'],
  acceptanceScript: 'probes/quota-skip-policy-accept.mjs',
  anchors: [
    { file: 'lib/cc-channel.js', pattern: 'export function shouldSkipForKnownQuotaExhaustion', note: '要补 cap 的策略函数（当前只判 now < resetsAt）' },
    { file: 'lib/cc-channel.js', pattern: "import { parseResetsAt, isQuotaFailureText } from './quota-parser.mjs'", note: '同一处 import 补 shortcutCapMs / quotaKindOf' },
    { file: 'lib/quota-parser.mjs', pattern: 'export function shortcutCapMs', note: '要复用的 cap（周 24h / 其余 6h）——它是唯一来源，不得在本任务里另写常量' },
    { file: 'lib/index.js', pattern: "await writeCcQuotaState({ kind: 'quota-exhausted'", note: '持久化配额状态的调用点：需要带上 quotaKind' },
  ],
  acceptance:
    '① `shouldSkipForKnownQuotaExhaustion({ quotaState, now })` 补 cap，语义明确为：'
    + '仅当 `quotaState.kind === "quota-exhausted"`、`resetsAt` 可解析、且 `0 < resetsAt - now <= shortcutCapMs(quotaState.quotaKind ?? "session")` 时返回 true；'
    + '其余一律 false（**fail-open 到"照常派发"**——宁可多派一次由 runner 归类，也不长时间静默停摆）。'
    + '② cap 必须**复用** lib/quota-parser.mjs 的 `shortcutCapMs`（从同一处 import），'
    + '**不得**在本文件里另写 6h/24h 常量（那正是本任务要消除的"策略重复实现"）。'
    + '③ 插件持久化配额状态时带上 `quotaKind`：在配额失败分类路径里用唯一模块的 `quotaKindOf(claudeLogText)` 取值并写入；'
    + '**读取旧状态文件（无 quotaKind）时按 "session" 处理**（保守：取 6h 上限），不得因缺字段抛错。'
    + '④ 既有行为不变：函数签名与返回类型（boolean）不变；`kind !== "quota-exhausted"` / `resetsAt` 缺失或不可解析 → false。'
    + '⑤ 新增用例 ≥6：cap 内 → true；超 cap → false；weekly 与 session 的差异真实生效（同一时间戳两种 kind 结果不同）；'
    + 'resetsAt 缺失 → false；不可解析 → false；非 quota-exhausted → false；（若 index.js 侧可测）quotaKind 已写入。'
    + '既有用例不得减少。node --check 通过；排除 test/shadow-gate.test.js 的 WSL 已知差异后全量 0 失败；'
    + 'verify-files-coverage 通过；改动文件 LF/无 BOM；仅改 lib/cc-channel.js、lib/index.js、test/cc-channel.test.js',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务把**一条策略**收敛到"唯一来源"，而不是让它在两个消费方有不同强度。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【背景（主 agent 已取证）】
判据（限额措辞、resetsAt 解析、配额种类）已收敛到 lib/quota-parser.mjs。但**"已知耗尽 → 跳过派发"这条策略没有**：
· 主 agent 的链条只在「剩余等待 ≤ shortcutCapMs(kind)」（周 24h / 会话 6h）时才短路 —— 这是对
  "resetsAt 被误解析"的保护（解析器会把已过去的时刻滚到明天 → 最长 ~24h；状态文件陈旧/写坏同理）；
· 而 lib/cc-channel.js 的 shouldSkipForKnownQuotaExhaustion 只判 \`now < resetsAt\`，**没有 cap**。
⇒ 同一份数据，一个有保护、一个没有：一个错误时间戳能让插件**静默停掉 cc 派发一整个窗口**。
另外：唯一模块导出的 shortcutCapMs 在仓库里**没有任何消费者**（死代码）；插件写 cc-quota-state.json 时也不带 quotaKind。

【硬性要求 1：策略补 cap（复用唯一模块，不另写常量）】
shouldSkipForKnownQuotaExhaustion({ quotaState, now }) 改为：
  仅当 quotaState.kind === 'quota-exhausted' && resetsAt 可解析 && 0 < resetsAt - now <= shortcutCapMs(quotaState.quotaKind ?? 'session')
  时返回 true；其余 false。
· shortcutCapMs 必须从 './quota-parser.mjs' import（与 parseResetsAt / isQuotaFailureText 同一处），
  **不得**在本文件里写 6h/24h 常量。
· 失败方向：超出 cap → 返回 false（照常派发）。理由：多派一次由 runner 归类为 cc-quota-exhausted 只是浪费一次尝试；
  而错误地跳过会让通道长时间静默停摆（严重）。
· 旧状态文件没有 quotaKind 时按 'session'（6h，保守），不得抛错。

【硬性要求 2：持久化 quotaKind】
lib/index.js 里写配额状态的那处（\`await writeCcQuotaState({ kind: 'quota-exhausted', resetsAt: …, at: … })\`）
补上 \`quotaKind: quotaKindOf(<claude.log 文本>)\`（从 './quota-parser.mjs' import quotaKindOf）；
其它字段与调用时机不变。

【硬性要求 3：不变的东西】
函数签名、返回类型（boolean）不变；kind !== 'quota-exhausted'、resetsAt 缺失/不可解析 → false（保持既有语义）。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/cc-channel.js
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/test/cc-channel.test.js（已存在，扩充）
其它文件一律不得改动。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 全部改动文件通过；
② 新增用例 ≥6（cap 内/超 cap/weekly 与 session 差异/缺失/不可解析/非 quota-exhausted），既有用例不减（贴计数变化）；
③ 全量回归：**排除 test/shadow-gate.test.js 的 WSL 已知差异**后 0 失败（显式文件清单 + 说明如何排除）；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；不要用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：策略改动前后（贴代码）、cap 来源（唯一模块）与"为何超 cap 必须照常派发"、quotaKind 写入点、用例清单、残余风险。
⑧ 冒烟自证（必须做）：运行 node /mnt/d/dsh-web-relay/probes/quota-skip-policy-accept.mjs 并贴完整输出
   （该探针断言 cap 行为、weekly/session 差异、缺失/不可解析、以及"cap 不再是死代码"，当场可判、不需要重启宿主）。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
