// V2 实施规格（外部 AI web-Gemini 规划 6 步 → 一次串行派发）
//   步 8  P0-A 影子门禁仓库根解析（structural）
//   步 9  P0-B /ask 对 body 冲突声明显式拒绝
//   步 10 P1-A 协议版本口径自洽断言 J7/J8
//   步 11 P1-B audit-all 层清单版本化 + ⑩ 全等断言
//   步 12 P1-C artifacts 可解析判据（统一 resolveArtifactPath）
//   步 13 版本号 4.11.0 + 兼容矩阵 + 版本锚点测试（tag 由主 agent 打）
// 主 agent 已核实并订正外部 AI 的三处不准确引用（见 acceptance 与 prompt）：
//   · test/verify-iteration.test.js 不存在 → 版本锚点实际在 test/timeout-fix.test.js；
//   · 端口 18789 错 → 实际 3080；
//   · test/version-anchor.test.js 不存在 → 同上。
export const task = {
  taskId: 'ccfeat-20260922-v2-versionconsistency',
  kind: 'implement',
  title: 'V2：影子门禁仓库根解析修复 + /ask 声明显式拒绝 + 版本口径/审计层清单/artifacts 三判据 + 版本 4.11.0',
  refs: ['lib/shadow-gate.js', 'lib/index.js', 'lib/autoiter-decl.js', 'test/shadow-gate.test.js', 'test/autoiter-decl.test.js', 'test/timeout-fix.test.js', 'test/compat-metadata.test.js', 'docs/COMPATIBILITY.md', 'package.json'],
  acceptanceScript: 'probes/protocol-version-grounding-accept.mjs',
  anchors: [
    { file: 'lib/shadow-gate.js', pattern: 'export function shadowRepoCandidates', note: '候选顺序 [base,payload.repoPath,env…,moduleDir]；base 只要求是 git 根 → 工作区自身是 git 仓库时短路，moduleDir 永不触达（本任务要修）' },
    { file: 'lib/shadow-gate.js', pattern: 'export function resolveRepoPath', note: '要在此加"必须含 package.json 且 name=dsh-web-relay"的仓库特征校验' },
    { file: 'lib/index.js', pattern: 'const ai = extractAutoIterDecl(`${prompt}\\n${answer}`)', note: '/ask 的声明提取点：要在此对 body 显式声明做冲突拒绝' },
    { file: 'lib/index.js', pattern: "path: '/dsh-web-relay/protocol/versions'", note: 'V1 新增的只读端点；J7 要把它与 /context 的版本集合对齐' },
    { file: 'test/timeout-fix.test.js', pattern: '4.10.0', note: '版本锚点测试（外部 AI 误写为 test/version-anchor.test.js）' },
  ],
  acceptance:
    '① 步8：`resolveRepoPath` 增加仓库特征校验——候选目录必须是 git 根**且**含 package.json 且 name==="dsh-web-relay"；'
    + '不存在的/不含特征的候选继续试下一个（不得直接返回 null 短路后续候选）。'
    + '验收含反向夹具：在"候选 base 是 git 仓库但不含 dsh-web-relay package.json"的场景下，修前解析到 base（错），修后解析到真正的插件仓库根。'
    + '② 步9：POST /dsh-web-relay/ask 的 body 里若显式传入 iterations / finalAcceptance / autoDecision 任一，'
    + '且与 prompt+answer 文本解析出的声明不一致（含"文本未声明"即默认值情形）→ 返回 400 + 说明性错误，**禁止静默忽略、禁止合并**；'
    + 'body 不带这些字段时行为完全不变（向后兼容）。'
    + '③ 步10：`verify-iteration-state.mjs`（工作区 D:\\dsh relay test）新增 J7/J8：'
    + 'J7 = PROTOCOL_VERSIONS_META 版本集合 == /context.protocolVersions == /protocol/versions == client.js 可渲染集合，且每个 contentKey 在 /context 有非空正文；'
    + 'J8 = lib/client.js 不得出现整串硬编码版本列表或 localStorage 版本白名单（须能对"注入硬编码"的夹具报 FAIL）。'
    + '④ 步11：`audit-all.mjs` 顶部把层清单升格为 `AUDIT_LAYERS_MANIFEST = { version, layers:[{id,key,name}] }`（key 集合与顺序必须与现有 REQUIRED_LAYERS 一致），'
    + '并在 `verify-iteration-state.mjs` 中断言「最近一次 audit-all 结果的层 key 集合 == MANIFEST 的 key 集合」：缺层与多层都必须 FAIL。'
    + '⑤ 步12：工作区侧统一 `resolveArtifactPath(repoRoot, artifactPath)`（相对路径按 repoRoot 解析、绝对路径原样、解析不到返回 null），'
    + '在 verify-iteration-state.mjs 与 verify-gates.mjs 使用它做 artifacts 存在性判据；须能对"路径错位"夹具报 FAIL。'
    + '⑥ 步13：package.json version → 4.11.0；docs/COMPATIBILITY.md 版本矩阵新增 4.11.0 行；test/timeout-fix.test.js 的版本锚点更新为 4.11.0。'
    + '⑦ 全版本回归：node --test test/*.test.js 用例数 **≥508 且 0 失败**；严禁为迁就实现修改既有断言。'
    + '⑧ 交付：改完后由主 agent 执行 deliver-three-copies.mjs + 重启宿主 + HTTP 实测（CC 不执行交付与重启、不打 tag）。',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务是 **V2 迭代**，一次派发含 6 个子任务，请**串行**完成。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）
工作区（主 agent 工具链所在，部分脚本在这里）：/mnt/d/dsh relay test

【背景：V1 已完成】
V1 把协议版本元数据收敛为 lib/index.js 的 PROTOCOL_VERSIONS_META（6 项：version/concurrent/isConcurrent/contentKey/label），
随 /context 与 /protocol 下发 protocolVersions[]，并有只读端点 GET /dsh-web-relay/protocol/versions。
当前仓库全量测试基线 **508 例 0 失败**。不得让它减少，也不得为迁就实现改既有断言。

【子任务 1（最高优先，真缺陷）：修影子门禁的仓库根解析 — lib/shadow-gate.js】
现象（已实测）：/steps/update 的 complete 被 shadow-l1/shadow-l2 拒绝，报
  Cannot find module 'D:\\dsh relay test\\lib\\client.js'
即门禁在**宿主工作区**里找仓库文件。
根因：shadowRepoCandidates 的候选顺序是 [base, payload.repoPath, env.DSH_RELAY_REPO_PATH, env.DSH_RELAY_REPO, moduleDir]，
而 resolveRepoPath(base) 只要求 base 是 git 仓库根；宿主工作区自身也是 git 仓库 → 第 1 候选即命中，moduleDir（插件自身 lib/）永远走不到。
要求：
· resolveRepoPath(base) 增加**仓库特征校验**：该 git 根下必须存在 package.json 且其 name === 'dsh-web-relay'；
· 候选不满足特征时**继续试下一个候选**，不得直接返回 null；
· 候选顺序与 env 覆盖语义保持不变（外部 AI 评估：提升 moduleDir 优先级会破坏"插件装在 node_modules 里时从宿主找 target repo"的泛化能力）；
· 在 test/shadow-gate.test.js 增加**反向夹具**：构造"候选 base 是 git 仓库但不含 dsh-web-relay 的 package.json"，
  断言修前逻辑会错误解析到 base（用测试内的旧实现或断言新逻辑不再如此），修后解析到含特征的插件仓库根。
  注意：该测试文件现有夹具用 fs.mkdtempSync 建临时目录（勿改回硬编码路径）。

【子任务 2：/ask 对 body 冲突声明显式拒绝 — lib/index.js（+必要时 lib/autoiter-decl.js）】
现象（已实测）：/ask 只从 prompt+answer **文本**提取 iterations/finalAcceptance/autoDecision（lib/index.js 约 2870 行），
body 里的同名字段被**静默忽略**。实测：body 传 iterations:2/autoDecision:true/finalAcceptance，落盘仍是 1/false/null。
要求：
· body 显式传入这三个字段中的任意一个，且与文本解析结果不一致（**包括文本未声明、解析得默认值的情形**）→ 返回 400，
  错误信息要说明"body 与文本声明不一致/文本未声明，请只用其中一处声明"；
· body 不带这些字段 → 行为与现在完全一致（向后兼容，不得影响既有调用方）；
· 在 test/autoiter-decl.test.js（已存在）补用例：冲突 → 400；一致 → 通过；body 不带 → 通过。
· 只做"显式拒绝"，**不要实现 body 与文本合并**（会引入两个来源）。

【子任务 3：协议版本口径自洽断言 J7/J8 — 工作区脚本】
文件：/mnt/d/dsh relay test/verify-iteration-state.mjs（该脚本已有 J1–J6 与 --selftest；请沿用其既有风格与输出格式）
· J7：断言四处版本集合一致 —— lib/index.js 的 PROTOCOL_VERSIONS_META、/context.protocolVersions、/protocol/versions、lib/client.js 实际可渲染集合
  （client.js 是浏览器 bundle，无法直接 import：请用源码级断言，例如要求它包含 meta.map / protocolVersions 的数据驱动渲染痕迹且不含整串硬编码列表）；
  并断言每个 contentKey 在 /context 有非空正文。宿主不可达时按该脚本既有的"未验证"语义处理（不得伪装成 PASS）。
· J8：断言 lib/client.js 不得出现整串硬编码版本列表、不得有 localStorage 版本白名单。
· 两条判据都要在 \`--selftest\` 里带**负控**（注入硬编码/注入白名单的夹具必须被判定为 FAIL），防止断言永真。

【子任务 4：audit-all 层清单版本化 — 工作区脚本】
文件：/mnt/d/dsh relay test/audit-all.mjs
· 把现有 REQUIRED_LAYERS 升格/包裹为 \`AUDIT_LAYERS_MANIFEST = { version: '<显式版本号>', layers: [{ id, key, name }] }\`，
  key 集合与**顺序**必须与现有 REQUIRED_LAYERS 完全一致（9 层：③gates ④chainRun ⑤delivery ⑥claims ⑦sediment ⑧quotaSingleSource ⑨wakeOccurrence ⑩iterationState ⑪eventDrill）；
  导出该 MANIFEST 供其它工具引用。
· 在 verify-iteration-state.mjs 中新增断言：最近一次 audit-all 结果里的层 key 集合 == MANIFEST 的 key 集合；
  **缺层（漏跑）与多层（未登记）都必须 FAIL**，并带负控自检。

【子任务 5：artifacts 可解析判据 — 工作区脚本】
文件：/mnt/d/dsh relay test/verify-iteration-state.mjs 与 verify-gates.mjs
· 统一提供 \`resolveArtifactPath(repoRoot, artifactPath)\`：绝对路径原样返回；相对路径按 repoRoot 解析；解析不到（文件不存在）返回 null。
· 用它对协议 Step List 的 artifacts 做存在性判据（repoRoot = 插件仓库根，不是宿主工作区）。
· 带负控：路径错位（相对路径按工作区解析）必须被判 FAIL。此判据与子任务 1 是同一族缺陷（证据路径锚点错位），请勿只改一处。

【子任务 6：版本号 4.11.0】
· /mnt/d/dsh-web-relay/package.json 的 version → "4.11.0"；
· /mnt/d/dsh-web-relay/docs/COMPATIBILITY.md 版本矩阵新增 4.11.0 行（并保持既有行不删）；
· /mnt/d/dsh-web-relay/test/timeout-fix.test.js 的版本锚点断言从 '4.10.0' 改为 '4.11.0'
  （**注意：外部规划里写的 test/version-anchor.test.js 不存在，真实锚点就在这个文件**）；
· test/compat-metadata.test.js 的矩阵校验需同步通过。

【写入范围（严格，其它文件一律不得改动）】
仓库侧：
- /mnt/d/dsh-web-relay/lib/shadow-gate.js
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/lib/autoiter-decl.js（仅在确需时）
- /mnt/d/dsh-web-relay/test/shadow-gate.test.js
- /mnt/d/dsh-web-relay/test/autoiter-decl.test.js
- /mnt/d/dsh-web-relay/test/timeout-fix.test.js
- /mnt/d/dsh-web-relay/test/compat-metadata.test.js（仅在矩阵校验需同步时）
- /mnt/d/dsh-web-relay/docs/COMPATIBILITY.md
- /mnt/d/dsh-web-relay/package.json
工作区侧：
- /mnt/d/dsh relay test/audit-all.mjs
- /mnt/d/dsh relay test/verify-iteration-state.mjs
- /mnt/d/dsh relay test/verify-gates.mjs
**不要改** probes/protocol-version-grounding-accept.mjs（主 agent 的验收探针）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 所有改动的 .js/.mjs 通过；
② 仓库全量「node --test test/*.test.js」（传展开后的文件列表，勿用目录参数）**用例数 ≥508 且 0 失败**，贴改动前后计数；
③ \`node /mnt/d/dsh relay test/verify-iteration-state.mjs\` 与 \`--selftest\` 输出（J7/J8/层清单/artifacts 判据须 PASS，负控须真 FAIL）；
④ \`node /mnt/d/dsh relay test/verify-gates.mjs\` 输出（应 PASS；若因新增判据需要登记，请在报告中说明登记方式）；
⑤ \`node /mnt/d/dsh relay test/audit-all.mjs\` 输出总判定（应 OK 或说明原因）；
⑥ 反向证据：对子任务 1 与子任务 5，必须给出"修前会错、修后正确"的同一夹具两次结果对比；
⑦ git status --porcelain 只含写入范围内文件（工作区侧文件在另一个仓库，请分别列出）；
⑧ 报告含：每个子任务的改动前后代码片段、为何不构成第二来源/为何不破坏既有调用方、残余风险。
⑨ **不要**执行 git commit、**不要**运行 deliver-three-copies.mjs、**不要**打 tag、**不要**重启宿主（都由主 agent 做）。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
}
