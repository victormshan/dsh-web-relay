// 收敛：把配额判断收敛到**唯一模块** lib/quota-parser.mjs，并让两处消费者依赖它（而不是各留一份正则）。
//
// 采纳的原则（外部 AI 指出、主 agent 实测印证）：
//   ① 从"组件枚举"转向"**调用点穷举**"——同一判断在本系统曾有**五处**实现（链条/runner/插件 cc-channel/
//      插件 cc-stats/deferred-dispatch.ps1），按组件想只会找到三处；
//   ② 从"多处实现"转向"**唯一收敛原语**"——只把 5 处都改成新版正则，下次文案再变仍会同时失效；
//      正确做法是收敛成一个模块，所有消费者依赖它。
// 实施进度：主 agent 侧已完成（工作区唯一模块 + 链条再导出 + runner 桥接 + 第五处桥接 + 穷举门禁；
//   `verify-quota-single-source.mjs` 报"未收敛命中 0"）。**本任务补仓库侧这一半**。
//
// 外部验收探针：probes/quota-classify-accept.mjs（仓库侧、双平台可跑）。基线 **5/15 FAIL**
//   （weekly 未判、cc-stats 规则未覆盖、唯一模块不存在、两处消费者未依赖它、两处仍自带限额正则）。
export const task = {
  taskId: 'ccfix-20260919-quotaclass',
  kind: 'implement',
  title: '配额判断收敛到唯一模块 lib/quota-parser.mjs（cc-channel + cc-stats 改为依赖它）',
  refs: ['lib/cc-channel.js', 'lib/cc-stats.mjs', 'test/cc-channel.test.js', 'test/cc-stats.test.mjs'],
  acceptanceScript: 'probes/quota-classify-accept.mjs',
  anchors: [
    { file: 'lib/cc-channel.js', pattern: 'export function parseResetsAt', note: '要把实现迁出到唯一模块（保留再导出以兼容调用方）' },
    { file: 'lib/cc-channel.js', pattern: 'const isQuotaExhausted', note: '要改为调用唯一模块（不再自带正则）' },
    { file: 'lib/cc-stats.mjs', pattern: "['cc-quota-exhausted'", note: '规则要从唯一模块的措辞构造，不再另写一份正则' },
    { file: 'lib/cc-stats.mjs', pattern: 'export function summarizeChainTasks', note: 'byFailure 归因调用方（补一条端到端用例）' },
  ],
  acceptance:
    '① 新建**唯一收敛模块** lib/quota-parser.mjs（纯函数、无 IO），导出：'
    + 'LIMIT_WORDING（限额措辞的单一正则常量）、parseResetsAt(text, { now })、isQuotaFailureText(text)'
    + '（**分类语义**：只认措辞，不看有无 OK）、classifyQuotaProbe(text)（**探针语义**：可用时打印 OK，没 OK 也算不可用）、'
    + 'shortcutCapMs(kind)（周 24h / 会话 6h）。措辞必须覆盖 session/rate/**weekly**/usage limit 与 hit your … limit。'
    + '② lib/cc-channel.js：删除自带的 parseResetsAt 实现与 isQuotaExhausted 正则，改为从唯一模块导入；'
    + '为兼容既有调用方，**继续再导出** parseResetsAt（签名不变，含 { now } 注入口）；classifyCcFailure 的 kind 与分支顺序不变。'
    + '③ lib/cc-stats.mjs：FAILURE_RULES 的 cc-quota-exhausted 规则改为**由唯一模块的措辞构造**（例如 import LIMIT_WORDING 后组合），'
    + '**不得**再出现独立写死的 (session|rate|weekly|usage)…limit 正则字面量；规则顺序不变。'
    + '④ 新增/迁移用例 ≥6：唯一模块自身的两侧自测（措辞命中 + 普通文本不命中 + 两种语义的区别）；'
    + 'cc-channel 的 weekly/session/quota/普通失败四类；cc-stats 一条**经由 summarizeChainTasks** 的端到端用例'
    + '（断言 byFailure 出现 cc-quota-exhausted 而非 unknown）。既有用例不得减少（含既有 parseResetsAt 用例，靠再导出保持）。'
    + '⑤ node --check 通过；排除 test/shadow-gate.test.js 的 WSL 已知差异后全量 0 失败；verify-files-coverage 通过；'
    + '改动文件 LF/无 BOM；仅改 lib/quota-parser.mjs（新增）、lib/cc-channel.js、lib/cc-stats.mjs、'
    + 'test/quota-parser.test.mjs（新增）、test/cc-channel.test.js、test/cc-stats.test.mjs',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务把"配额判断"收敛成**唯一模块**，根治"同一判断多处实现"。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【问题（主 agent 已实测）】
本机 cc 的限额文案是 "You've hit your weekly limit · resets 2am (Asia/Shanghai)"，而同一判断在本系统里有五处实现
（链条、runner.sh、lib/cc-channel.js、lib/cc-stats.mjs、一个休眠的 PowerShell 脚本），全都只认 session/rate/quota：
  · 链条：判为"未耗尽"→ 不落盘恢复时刻 → 每 20 分钟白跑 90s 探针（实测 57 次暂停）；
  · runner：失败被误分类；
  · 插件 lib/cc-channel.js：派发前"已知耗尽不盲等"短路与失败 error 文案不准；
  · 插件 lib/cc-stats.mjs：**byFailure 归因**把配额记成 unknown（报告引用的就是它）。
主 agent 已在自己那侧收敛完毕（唯一模块 + 再导出 + runner/PS 桥接 + 穷举门禁报 0 未收敛）。
**本任务补仓库侧**：新建唯一模块，并让两个插件文件依赖它——不是把两处正则各改一遍。

【硬性要求 1：新建 lib/quota-parser.mjs（纯函数、无 IO、无副作用）】
导出：
  · LIMIT_WORDING —— 限额措辞的**单一**正则常量（覆盖 session / rate / **weekly** / usage limit、hit your … limit、quota、resets 时间）
  · parseResetsAt(text, { now }) —— 尽力解析 "resets 2am (Asia/Shanghai)"（分钟可省略）为未来 ISO 时刻，解析不出返回 null
  · isQuotaFailureText(text) —— **分类语义**：这段失败日志是否由配额导致（只认措辞，不看有无 OK）
  · classifyQuotaProbe(text) —— **探针语义**：额度探针输出判定（探针契约是"可用时打印 OK"，故没 OK 也算不可用）
  · shortcutCapMs(kind) —— 短路上限（周 24h / 其余 6h）
注意两种语义必须**分开**：实测把探针语义用于分类会把任意不含 OK 的日志判成配额耗尽。

【硬性要求 2：两处消费者改为依赖唯一模块】
  · lib/cc-channel.js：删掉自带 parseResetsAt 实现与 isQuotaExhausted 正则，改为 import；
    为兼容既有调用方（含 test/cc-channel.test.js 与 lib/index.js），**继续再导出 parseResetsAt**（签名不变，保留 { now } 注入）；
    classifyCcFailure 的返回形状 { kind, errorCode, resetsAt, raw } 与分支顺序**不得**改变。
  · lib/cc-stats.mjs：FAILURE_RULES 里的 cc-quota-exhausted 规则改为**由 LIMIT_WORDING 组合而成**
    （不再出现独立写死的 (session|rate|weekly|usage)…limit 字面量）；规则顺序不变。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/quota-parser.mjs（新增）
- /mnt/d/dsh-web-relay/lib/cc-channel.js
- /mnt/d/dsh-web-relay/lib/cc-stats.mjs
- /mnt/d/dsh-web-relay/test/quota-parser.test.mjs（新增）
- /mnt/d/dsh-web-relay/test/cc-channel.test.js（扩充）
- /mnt/d/dsh-web-relay/test/cc-stats.test.mjs（扩充）
其它文件一律不得改动。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 全部改动文件通过；
② 新增/迁移用例 ≥6，且**既有用例不减**（parseResetsAt 的既有用例应因再导出而继续通过——请贴出该文件的用例计数变化）；
③ 全量回归：**排除 test/shadow-gate.test.js 的 WSL 已知差异**后 0 失败（显式文件清单 + 说明如何排除）；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；不要用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：唯一模块的导出清单与两种语义的区别、两处消费者改动前后（贴代码）、cc-stats 规则如何"由常量构造"、
   用例清单、未做项与残余风险。
⑧ 冒烟自证（必须做）：运行 node /mnt/d/dsh-web-relay/probes/quota-classify-accept.mjs 并贴完整输出
   （该探针真 import 两个模块 + 唯一模块，断言 weekly/session/quota/普通失败 + 收敛性，当场可判、不需要重启宿主）。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
