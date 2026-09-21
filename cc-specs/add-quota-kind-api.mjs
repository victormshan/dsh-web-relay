// 补 API：唯一模块需要把"消费方各自拼 kind/resetsAt"这件事也收敛掉（收敛只做了一半）。
//
// 背景（2026-09-19 收敛 phase 2 实测）：把判据收敛到 lib/quota-parser.mjs 后，
// 消费方（链条 cc-chain.mjs、无空格 shim quota-classify-cli.mjs）都需要 **kind**（决定短路上限 24h/6h）
// 与 **resetsAt**，而模块只导出 classifyQuotaProbe(text)→'available'|'exhausted'。
// 结果：两个消费方各自写了 `/weekly/i.test(text) ? 'weekly' : 'session'` 这样的兜底 ——
// 这就是"同一判断多处实现"的缩小版，只是这次漂移的是 **kind** 而不是 limited。
// ⇒ 把 kind/resetsAt 也收敛进模块：新增 quotaKindOf(text) 与 classifyQuotaProbeDetail(text)，
//   消费方之后直接调 detail，删掉各自的兜底（主 agent 侧 phase 3）。
//
// 外部验收探针：probes/quota-classify-accept.mjs（已扩两条 API 断言）。基线 **19/21 FAIL**。
export const task = {
  taskId: 'ccfeat-20260919-quotakind',
  kind: 'implement',
  title: 'quota-parser 补细节 API：quotaKindOf(text) + classifyQuotaProbeDetail(text)',
  refs: ['lib/quota-parser.mjs', 'test/quota-parser.test.mjs'],
  acceptanceScript: 'probes/quota-classify-accept.mjs',
  anchors: [
    { file: 'lib/quota-parser.mjs', pattern: 'export function classifyQuotaProbe', note: '既有探针语义（返回 available|exhausted）——保持不变' },
    { file: 'lib/quota-parser.mjs', pattern: 'export function shortcutCapMs', note: 'kind 的消费方（周 24h / 其余 6h）' },
    { file: 'lib/quota-parser.mjs', pattern: 'export function parseResetsAt', note: 'detail 要复用它算 resetsAt' },
  ],
  acceptance:
    '① 新增导出 `quotaKindOf(text)` → "weekly" | "rate" | "usage" | "session" | "unknown"：'
    + '按文案判定配额种类（大小写不敏感；含 weekly → weekly；含 rate → rate；含 usage → usage；'
    + '其余限额措辞 → session；**不含任何限额措辞 → unknown**，不得默认成 session 而谎报种类）。'
    + '② 新增导出 `classifyQuotaProbeDetail(text)` → { available, kind, resetsAt }：'
    + 'available 与既有 classifyQuotaProbe 同义（输出含独立 OK → true，否则 false）；'
    + 'kind = quotaKindOf(text)（available 时可以是 unknown）；resetsAt = parseResetsAt(text)（解析不出为 null）。'
    + '③ **既有导出与语义一律不变**：classifyQuotaProbe 仍返回字符串 available|exhausted、'
    + 'isQuotaFailureText / parseResetsAt / LIMIT_WORDING / shortcutCapMs 行为不变。'
    + '④ 新增用例 ≥5（quotaKindOf 的 weekly/rate/usage/session/unknown 五类 + detail 两态：限额文案与 OK），既有用例不减。'
    + '⑤ node --check 通过；排除 test/shadow-gate.test.js 的 WSL 已知差异后全量 0 失败；verify-files-coverage 通过；'
    + '改动文件 LF/无 BOM；仅改 lib/quota-parser.mjs、test/quota-parser.test.mjs',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务给"配额唯一模块"补齐细节 API。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【背景（主 agent 已实测）】
判据已收敛到 lib/quota-parser.mjs。但两个消费方都需要 **kind**（决定短路窗口：weekly 24h / 其余 6h）与 **resetsAt**，
而模块只导出 classifyQuotaProbe(text) → 'available' | 'exhausted'。
于是消费方各自写了类似的兜底（/weekly/i ? 'weekly' : 'session'）——**这正是"同一判断多处实现"的缩小版**：
这次会漂移的是 kind。请把 kind 与 resetsAt 也收敛进模块。

【硬性要求 1：quotaKindOf(text)】
返回 'weekly' | 'rate' | 'usage' | 'session' | 'unknown'（大小写不敏感）：
· 含 weekly → 'weekly'；含 rate → 'rate'；含 usage → 'usage'；
· 其余**限额措辞**（session limit / hit your … limit / quota 等，即 LIMIT_WORDING 命中）→ 'session'；
· **完全不含限额措辞 → 'unknown'**（不得默认成 'session' —— 那会让"无限额信息"被当成会话限额，谎报种类）。
优先级：weekly > rate > usage > session > unknown。

【硬性要求 2：classifyQuotaProbeDetail(text)】
返回 { available, kind, resetsAt }：
· available ← 与既有 classifyQuotaProbe 同义（输出含独立 OK → true，否则 false）；
· kind ← quotaKindOf(text)（available 时可以是 'unknown'）；
· resetsAt ← parseResetsAt(text)（解析不出为 null）。
**既有导出与语义一律不变**：classifyQuotaProbe 仍返回字符串 'available'|'exhausted'；
isQuotaFailureText / parseResetsAt / LIMIT_WORDING / shortcutCapMs 行为不变。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/quota-parser.mjs
- /mnt/d/dsh-web-relay/test/quota-parser.test.mjs（已存在，扩充）
其它文件一律不得改动。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 全部改动文件通过；
② 新增用例 ≥5（quotaKindOf 五类 + detail 两态），既有用例不减（贴出用例计数变化）；
③ 全量回归：**排除 test/shadow-gate.test.js 的 WSL 已知差异**后 0 失败（显式文件清单 + 说明如何排除）；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；不要用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：两个新导出的实现与优先级说明、为什么 unknown 不能默认成 session、既有导出未变的证据、用例清单、残余风险。
⑧ 冒烟自证（必须做）：运行 node /mnt/d/dsh-web-relay/probes/quota-classify-accept.mjs 并贴完整输出
   （该探针会断言两个新 API 的行为与既有收敛性，当场可判、不需要重启宿主）。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
