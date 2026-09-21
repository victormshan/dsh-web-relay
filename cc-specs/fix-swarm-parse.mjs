// 修复任务：Swarm 空打回根因（parseRoleReview 静默默认 rejected）+ autoIterDeclAudit 残留
// 实证：V2-1 两次、V3-2 两次出现「单角色打回（Refactoring-Architect ✗）但两角色 findings=[] suggestion=""」，
//       同样输入第三次即双角色通过 → 假打回，原因是从角色输出解析失败时静默默认 rejected。
export const task = {
  taskId: 'ccfix-20260915-swarmparse',
  kind: 'implement',
  title: '修复 Swarm 空打回：parseRoleReview 区分「无法解析/unknown」与「显式 rejected」，unknown 走重问或降级而非静默打回',
  refs: ['lib/swarm-prompts.js', 'lib/index.js'],
  acceptance:
    'parseRoleReview 不再对无法解析的角色输出静默返回 rejected；新增 unknown 语义并在 consensus 中按「重问一次或降级标准链」处理，'
    + '/steps/auto-review 对 unknown 的裁决可在响应与 notes 中看到原因；把角色原始输出（截断）带入裁决，使打回可执行；'
    + 'node --check 通过；新增用例 ≥5（合法 JSON / 宽松匹配 / 完全不可解析 → unknown / unknown 的 consensus 处置 / 原始输出保留）；'
    + '全量测试全绿且既有用例不减；verify-files-coverage 通过；改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务修复一个**会造成随机假打回、直接影响无人值守可靠性**的缺陷。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【缺陷实证（主 agent 已取证，勿推翻）】
- 现象：同一份交付、同样输入，审核出现「单角色打回（Refactoring-Architect ✗），双 Approve 才通过」，
  但两角色的 findings 均为 []、suggestion 均为 ""（**空打回，没有可执行意见**）；再提交一次即双角色通过。
  实测命中：step 4（V2-1）2/3 次、step 7（V3-2）2/2 次。
- 根因（读码）：lib/swarm-prompts.js 的 parseRoleReview（约 L48-62）在 JSON.parse 失败时走 catch 分支：
      const v = /"verdict"\\s*:\\s*"(approved|rejected)"/.exec(src)
      return { verdict: v ? v[1] : 'rejected', findings: [], suggestion: '' }
  即**无法解析时静默默认 rejected**，且不带任何原始信息 → 表现为「rejected + 全空」签名。
- 影响：Swarm 共识（swarmConsensus，约 L34-45）要求双 Approve，任一角色被误判 rejected 即整步打回；
  而打回又无意见可整改 → 只能靠人工重提碰运气（本会话靠主 agent 重提 3 次才通过）。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/swarm-prompts.js
- /mnt/d/dsh-web-relay/lib/index.js（仅在需要接线 unknown 处置时）
- /mnt/d/dsh-web-relay/test/swarm-prompts.test.js（已存在则扩充；不存在则新建）
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md（补充说明）
其它文件一律不得改动（含 package.json）。

【要求】
1) **parseRoleReview 语义修正**（保持既有导出名与调用方兼容）：
   - 合法 JSON：verdict 仅接受 'approved'/'rejected'；其它值视为 unknown（不再默认 rejected）；
   - JSON 解析失败但能宽松匹配到 \"verdict\":\"approved|rejected\"：按匹配值返回，并保留原始文本片段；
   - 完全无法判定：返回 verdict: 'unknown'，**并带上 raw（原始输出截断，建议 ≤500 字）**，findings/suggestion 尽力从原文提取（提取不到就留空但要保留 raw）。
   - 返回值新增 raw 字段（不破坏既有字段 verdict/findings/suggestion）。
2) **consensus 处置 unknown**（swarmConsensus 或调用处）：
   - 任一角色 unknown 时**不得直接判整步 rejected**；处置顺序：① 对 unknown 的角色**重问一次**（新会话/新请求）；
     ② 重问仍 unknown → **降级到标准独立审核链**（external → web-gemini → dialog，即 enableSwarm:false 的等价路径），
     并在 fallbackReason/notes 中明确写出「Swarm 角色 X 无法裁决（unknown），已降级标准链」；
   - 双角色都 rejected（显式）时维持现状（打回），但必须把两角色的 findings/suggestion/raw 写进 notes，使打回可执行。
3) **审计可见**：unknown 与降级必须在 \`/steps/auto-review\` 的响应字段与步骤 notes 中可见（沿用既有 fallbackReason/swarm 字段风格）。
4) **测试**（≥5 例，纯函数、不碰网络）：
   - 合法 JSON approved/rejected → 原样；
   - 非法 verdict 值（如 \"verdict\":\"LGTM\"）→ unknown 且保留 raw；
   - 完全不可解析文本 → unknown 且 raw 非空；
   - consensus：一角色 unknown + 一角色 approved → **不判 rejected**（走重问/降级路径，返回可区分的结果）；
   - 双显式 rejected → rejected 且意见随行（findings/suggestion 至少 raw 可见）。
   既有用例（若有）不得减少。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check lib/swarm-prompts.js && node --check lib/index.js 通过；
② node --test --test-reporter=tap test/swarm-prompts.test.js 全绿（贴用例数与清单）；
③ 全量回归：node --test --test-reporter=tap（**显式测试文件清单**，不要用目录式调用）0 失败；
   基线：Windows 侧全量 517 例、*.test.js 子集 377 例（**必须在 Windows 语义下成立**：夹具用 path.join/os.tmpdir()，不硬编码 /tmp）；
   若出现 shadow-gate 等路径相关失败，必须用 git stash 证明改动前同样失败；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：现状取证行号、改动点 file:line、unknown 处置流程图（文字即可）、新增用例清单、未做项与残余风险。`,
};
