// 修复（三处同款漏判的最后一处）：插件侧额度失败分类必须覆盖本机真实文案 "weekly limit"。
//
// 背景（2026-09-19 实测，主 agent 已取证）：
//   本机 cc 返回的限额文案是 **"You've hit your weekly limit · resets 2am (Asia/Shanghai)"**，
//   而同一判断在仓库/工具链里共有**四处**实现，全都只写 `session limit|rate limit|quota`：
//     ① 链条（cc-chain.mjs）：判为"未耗尽"→ 不解析、不落盘恢复时刻 → 每 20 分钟白跑一次 90s 探针（实测累计 57 次暂停）；
//        **已修**（classifyQuotaProbe + 按类型分短路上限 周 24h/会话 6h + 链条也写共享配额状态）。
//     ② runner（runner.sh）：失败被误分类 → 失败归因错、不写 cc-quota-state.json；**已修**。
//     ③ 插件 lib/cc-channel.js：classifyCcFailure 的 isQuotaExhausted 漏判 →
//        "已知耗尽不盲等"短路（index.js L3712/L5003）与派发失败的 error 文案都不准。
//     ④ 插件 lib/cc-stats.mjs：FAILURE_RULES 的 cc-quota-exhausted 规则漏判 →
//        **summarizeChainTasks 的 byFailure 归因**把配额耗尽记成 `unknown`（这正是主 agent 在报告里引用的指标）。
//       ⇒ ③④ 由本任务一并修（同一个判断，不该有两套判据）。
//
// 外部验收探针：probes/quota-classify-accept.mjs（仓库侧、双平台可跑、当场可判）。
// 实测基线：**5/10 FAIL**（cc-channel 的 weekly 未判与静态覆盖、cc-stats 的 weekly 未判与静态覆盖）。
export const task = {
  taskId: 'ccfix-20260919-quotaclass',
  kind: 'implement',
  title: '插件侧额度分类覆盖 weekly limit 文案（cc-channel + cc-stats，与 runner/链条四处判据对齐）',
  refs: ['lib/cc-channel.js', 'lib/cc-stats.mjs', 'test/cc-channel.test.js', 'test/cc-stats.test.mjs'],
  acceptanceScript: 'probes/quota-classify-accept.mjs',
  anchors: [
    { file: 'lib/cc-channel.js', pattern: 'const isQuotaExhausted', note: '要改的判据本体（只覆盖 session/rate/quota）' },
    { file: 'lib/cc-channel.js', pattern: 'export function classifyCcFailure', note: '失败分类入口（保持其余 kind 的分支顺序不变）' },
    { file: 'lib/cc-stats.mjs', pattern: "['cc-quota-exhausted'", note: 'FAILURE_RULES 的配额规则（第四处副本）' },
    { file: 'lib/cc-stats.mjs', pattern: 'export function summarizeChainTasks', note: 'byFailure 归因的调用方（报告指标来源）' },
  ],
  acceptance:
    '① **两处**判据都要放宽，覆盖本机真实文案与同类措辞：`weekly limit`、`usage limit`、`hit your ... limit`（大小写不敏感）：'
    + '（a）lib/cc-channel.js 的 isQuotaExhausted（保留 errorCode === "cc-quota-exhausted" 优先消费）；'
    + '（b）lib/cc-stats.mjs FAILURE_RULES 里的 cc-quota-exhausted 规则（保留既有 session/rate/quota 分支）；'
    + '② weekly 文案命中后，cc-channel 返回的 resetsAt 必须能被既有 parseResetsAt 解析（文案形态 "resets 2am (Asia/Shanghai)"）；'
    + '③ **不得**改变其它失败类型的判定与分支顺序（尤其：cc-marker-missing 仍必须排在 isCodeFailed/runner-failed 之前；'
    + 'FAILURE_RULES 的规则顺序不得调整）；'
    + '④ 两处各新增用例 ≥3、合计 ≥6：weekly → 配额；session/quota 关键词不回归；普通代码失败 → 不得判成配额；'
    + '并且 cc-stats 侧要有一条**经由 summarizeChainTasks** 的用例，断言 byFailure 里出现 cc-quota-exhausted 而非 unknown；'
    + '⑤ node --check 通过；排除 test/shadow-gate.test.js 的 WSL 已知差异后全量 0 失败；verify-files-coverage 通过；'
    + '改动文件 LF/无 BOM；仅改 lib/cc-channel.js、lib/cc-stats.mjs、test/cc-channel.test.js、test/cc-stats.test.mjs',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务是"同一判断、三处实现"漏判问题的最后一处。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【问题（主 agent 已取证）】
本机 cc 的限额文案是：You've hit your weekly limit · resets 2am (Asia/Shanghai)
而 lib/cc-channel.js 里 classifyCcFailure 的判据是：
  const isQuotaExhausted = errorCode === 'cc-quota-exhausted' || /session\\s*limit|rate\\s*limit|\\bquota\\b/i.test(combined)
→ weekly limit 既不匹配 session limit 也不匹配 rate limit、且不含 quota 字样 → **漏判**。
后果：配额耗尽被归成别的失败类型 → 失败统计与"已知耗尽不盲等"短路都不准；
（另两处同类漏判已由主 agent 分别修好：runner.sh 的 grep 判据、链条侧新增的 classifyQuotaProbe。）

【硬性要求】
① 放宽判据：覆盖 weekly limit / usage limit / hit your ... limit（大小写不敏感），
   同时保留既有 session limit / rate limit / quota 与 errorCode 优先消费；
   建议排他性写法（不要写成会误伤的过宽正则，例如不要只匹配 "limit" 一个词）。
② weekly 文案命中后 resetsAt 必须能解析（复用既有 parseResetsAt；文案是 "resets 2am (Asia/Shanghai)" 形态）。
③ **不得**改动其它失败类型的判定与分支顺序（cc-marker-missing 必须仍在 isCodeFailed 之前）。
④ 新增用例 ≥4（见下），既有用例不减。
⑤ 报告里请附上"三处判据对齐"的说明（引用上面那两处已修的证据）。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/cc-channel.js
- /mnt/d/dsh-web-relay/test/cc-channel.test.js（已存在，扩充）
- /mnt/d/dsh-web-relay/lib/cc-stats.mjs
- /mnt/d/dsh-web-relay/test/cc-stats.test.mjs（已存在，扩充）
其它文件一律不得改动。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 全部改动文件通过；
② 新增用例 ≥4：
   · "You've hit your weekly limit · resets 2am (Asia/Shanghai)" → kind=quota-exhausted 且 resetsAt 为未来时刻；
   · "You've hit your session limit · resets 7am (Asia/Shanghai)" → 仍 quota-exhausted（不回归）；
   · "API error: quota exceeded" → 仍 quota-exhausted（不回归）；
   · 普通代码失败日志（如 cannot find module）→ 仍**不得**判成 quota-exhausted。
③ 全量回归：**排除 test/shadow-gate.test.js 的 WSL 已知差异**后 0 失败（显式文件清单，并说明如何排除）；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；不要用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：判据改动前后（贴代码）、resetsAt 解析路径、分支顺序未变的证据、用例清单、未做项与残余风险。
⑧ 冒烟自证（必须做）：运行 node /mnt/d/dsh-web-relay/probes/quota-classify-accept.mjs 并贴完整输出
   （该探针真 import 你的模块断言 weekly/session/quota/普通失败四类，当场可判、不需要重启宿主）。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
