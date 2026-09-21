// 修复：cc 失败分类的「reason 回退路径」失效——导致 unknown 盲区与同一失败模式分桶分裂
// 依据（主 agent 实测取证，2026-09-16）：对 D:\cc-tasks\tasks 全量 result.json 取证，errorCode 为空的行
// 的 reason 只有三种形态，而现有正则一条都匹配不上（见下），于是全部落进 unknown。
export const task = {
  taskId: 'ccfix-20260916-fallback-classify',
  kind: 'implement',
  title: '修复失败分类回退路径：识别 runner 真实 reason 形态（exit=0/1/124 + done.flag=missing），消除 unknown 盲区与 timeout 分桶分裂',
  refs: ['lib/cc-stats.mjs', 'test/cc-stats.test.mjs'],
  anchors: [
    { file: 'lib/cc-stats.mjs', pattern: 'const FAILURE_RULES = [', note: '规则表：本次要修的等号形态与分桶顺序都在这里' },
    { file: 'lib/cc-stats.mjs', pattern: "['cc-timeout',", note: '分桶分裂的收口点：exit=124 应归此桶' },
    { file: 'lib/cc-stats.mjs', pattern: "['timeout',", note: '泛化 timeout 桶：不再吞掉 exit=124' },
    { file: 'lib/cc-stats.mjs', pattern: "'cc-marker-missing',", note: '必须排在 runner-failed 之前（既有纪律）' },
    { file: 'lib/cc-stats.mjs', pattern: 'export function classifyCcFailure(reasonText)', note: '被两个通道共用的分类器' },
    { file: 'lib/cc-stats.mjs', pattern: 'const isMarkerMissing = ', note: '编码通道侧的 marker 判定点' },
    { file: 'lib/cc-stats.mjs', pattern: 'category = classifyCcFailure(reasonText).category;', note: '编码通道调用点（只喂 errorCode || reason）' },
    { file: 'lib/cc-stats.mjs', pattern: 'category = classifyCcFailure(o.reason).category;', note: '审核通道调用点（同样只喂单一文本）' },
  ],
  acceptance:
    'lib/cc-stats.mjs 的 FAILURE_RULES 支持 runner 真实写出的**等号形态**：done.flag=missing（当前正则要求空格分隔，恒不命中）'
    + '与 exit=1 / exit=2 …（当前正则只认 exit≠0 / exit!=0，恒不命中）；exit=124 归入 cc-timeout 桶'
    + '（当前被泛化 timeout 桶吞掉，导致同一失败模式分裂两桶）；exit=0 且 done.flag=missing 归入 cc-marker-missing'
    + '（claude 自身成功、仅缺完成标记，**不得**算作 runner-failed）；两个调用点必须把 reason 文本一并纳入判定'
    + '（当前 errorCode 非空时 reason 完全不被查看）；既有顺序纪律不变（marker-missing 先于 runner-failed，'
    + 'quota/permission 先于 timeout）；确实无法归类时仍兜底 unknown 且不抛错；'
    + 'node --check 通过；新增用例 ≥8 且既有用例不减；排除 test/shadow-gate.test.js 后全量 0 失败；'
    + 'verify-files-coverage 通过；改动文件 LF/无 BOM；仅改 lib/cc-stats.mjs 与 test/cc-stats.test.mjs',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务修一个**审计盲区**：失败分类器对 runner 真实写出的 reason 文本一条都匹配不上。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【主 agent 已取证的事实（勿推翻，可直接采信）】
对 D:\\cc-tasks\\tasks\\*\\result.json 全量取证，**errorCode 为空**的行的 reason 只有三种形态：

    claude exit=0; done.flag=missing      （8 条，其中多条实际产出了提交）
    claude exit=1; done.flag=missing      （4 条）
    claude exit=124; done.flag=missing    （2 条，124 = 被 timeout 900s 杀掉）

而 lib/cc-stats.mjs 的 FAILURE_RULES 现状是：
- 第 67 行 runner-failed 规则里的子模式是 done\\.flag\\s*(missing|不存在|缺失) —— 要求 done.flag 后**紧跟空白**，
  而真实文本是 done.flag**=**missing（**带等号**），故该子模式**恒不命中**；
- 同规则的 exit 分支只认 claude\\s*exit\\s*(≠|!=)\\s*0 与 exit\\s*(≠|!=)\\s*0，而真实文本是 exit**=**1，故**恒不命中**；
- 结果：errorCode 为空的行全部落进 unknown（7 天窗口内实测 3 条）。
- 另一处分裂：exit=124 被第 62 行泛化 timeout 规则（含 exit\\s*=\\s*124）吃掉 → 归 timeout 桶；
  而 runner 给了 errorCode=cc-timeout 的同类失败归 cc-timeout 桶。**同一失败模式两个桶**，
  使「超时几次」无法用单一数字回答。

【还有一个更隐蔽的缺陷（本次一并修）】
两个调用点只把**单一文本**喂给分类器（锚点已给出两处调用点的代码原文，按符号定位不要按行号）：
- summarizeChainTasks 内：classifyCcFailure(errorCode || reason)
- recordCcOutcome 内：classifyCcFailure(o.reason)
即 **errorCode 非空时 reason 完全不参与判定**。于是 errorCode=cc-failed 且 reason='claude exit=0; done.flag=missing'
的 3 条，被判成 runner-failed（「代码写坏了」），而真实语义是「claude 自身 exit=0，只是没写完成标记」——
这 3 条经主 agent 取证**都产出了落在 main 上的提交**（c4b3125 / 947fd3e / 517b0fc），即统计把成功算成了失败。

【要求】
1) 修 FAILURE_RULES 的等号形态：
   - done.flag 同时支持 'done.flag=missing' 与 'done.flag missing'（等号可选）；
   - exit 支持 'exit=1' / 'exit=2' … 这类**非零**值（注意：不得把 exit=0 也匹配成失败）；
   - 保留既有 ≠ / != 形态，不要删。
2) 把 exit=124 从泛化 timeout 桶移到 **cc-timeout** 桶（同一失败模式必须同桶）；泛化 timeout 桶保留其它超时语义
   （如中文「超时」、timeout-still-running 已更早匹配）。
3) exit=0 且 done.flag=missing → 归 **cc-marker-missing**（不是 runner-failed）。
   顺序纪律不变：cc-marker-missing 必须排在 runner-failed **之前**（这是既有铁律，见源码注释）。
4) 两个调用点都要把 **errorCode 与 reason 一并**纳入判定（例如合成一个文本再分类），
   使 'cc-failed' + 'claude exit=0; done.flag=missing' 正确落到 cc-marker-missing。
   注意不要因此破坏既有正确分桶：cc-quota-exhausted / cc-permission-denied / cc-timeout / cc-marker-missing
   这些由 errorCode 直接命中的桶必须**保持原结果**（quota/permission 规则本就在 marker 之前）。
5) 无法归类时仍兜底 unknown，**不抛错**（畸形输入 fail-open）。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/cc-stats.mjs
- /mnt/d/dsh-web-relay/test/cc-stats.test.mjs（已存在，扩充）
其它文件一律不得改动（含 lib/index.js、lib/cc-channel.js —— 注意 lib/cc-channel.js 里另有一个**同名但不同签名**的
classifyCcFailure({result, claudeLogText, now})，那是另一个实现，本次**不要动**）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 通过；
② 新增用例 ≥8，**必须**覆盖以下真实字符串（逐条断言所落桶名）：
   - 'claude exit=0; done.flag=missing' → cc-marker-missing（不得是 runner-failed）
   - 'claude exit=1; done.flag=missing' → runner-failed
   - 'claude exit=124; done.flag=missing' → cc-timeout（不得是 timeout）
   - 'cc-failed claude exit=0; done.flag=missing'（errorCode 与 reason 合并后）→ cc-marker-missing
   - 'cc-timeout claude exit=124; done.flag=missing' → cc-timeout
   - 'cc-quota-exhausted claude exit=1; done.flag=missing' → cc-quota-exhausted（保持原结果）
   - 'done.flag missing'（空格形态，回归保护）→ 仍能被识别
   - 负例：'claude exit=0; 正常完成' → **不得**落进任何失败桶（应为 unknown 或根本不被调用）
   - 负例：exit=0 但无 done.flag 字样 → 不得落进 cc-marker-missing
③ **真实数据回放（关键验收）**：写一个只读的回放（可在测试里，也可作为报告里的脚本输出）：
   对 D:\\cc-tasks\\tasks\\*\\result.json 按修复后的规则重新分桶，给出 before/after 对比。
   主 agent 已推演出的**预期结果**（7 天窗口、36 条）：
     before: failed=10 markerMissing=1 byFailure={unknown:3, timeout:1, cc-quota-exhausted:2, runner-failed:3, cc-timeout:1}
     after : failed=6 markerMissing=5 byFailure={runner-failed:2, cc-timeout:2, cc-quota-exhausted:2}，**unknown 归零、timeout 桶归零**
   若你跑出的数字与上述不一致，**不要改数字去迁就**——如实写出你的实际分桶与逐条明细，并说明差异原因
   （窗口是滚动 7 天，条数可能随任务老化而变；以"unknown 归零、timeout 与 cc-timeout 合并且计数相等"为主要判据）。
④ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单，不要用目录式调用）。
   WSL 下该文件的 TC-Green / TC-GC / getGitHead 三项会失败，是**已知的 WSL 环境差异**（同一 commit 在 Windows 侧全绿），
   不是你引入的：不要 git stash 自证，也不要试图"修"它们，直接排除并如实说明。
⑤ node scripts/verify-files-coverage.mjs 通过；
⑥ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑦ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑧ 报告含：修前的两条恒不命中正则的**原文引用**、修后的规则表（逐条）、真实数据回放的 before/after 桶计数与逐条明细、
   对 recordCcOutcome（审核通道）行为变化的说明（规则是共用分类器，改规则会同时改变审核通道的**未来**分桶）、
   未做项与残余风险。

【特别注意】recordCcOutcome 的累积统计里已有历史样本，改规则**不会**回填历史（这是预期的，不要试图回填）。
但请在报告里明确指出：修复后审核通道的新增样本会按新规则分桶，因此跨修复点的长期趋势线存在一次口径跳变。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
