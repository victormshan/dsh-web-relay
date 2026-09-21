// V3-1 步骤契约规格（审计后：sync-engine-docs 确不存在，且 drift 点已定位）
//
// 审计证据：
//   - scripts/ 现有：audit-capability-persistence.mjs / export-capability-pack.mjs / install-new-env.{ps1,sh} /
//     task-schema-cli.mjs / verify-capabilities.mjs / verify-cc-gates.sh / verify-files-coverage.mjs / verify-lessons.mjs
//     → scripts/sync-engine-docs.* **不存在**（方案要点成立）。
//   - 漂移实证①：docs/capabilities/registry.yaml 中 architect-breakthrough-gate 条目的 verification 只有
//     file-exists + content-contains（L174-178），即「能力只在文档里成立」，与代码是否强制无关。
//   - 漂移实证②：本轮已见真实漂移——DSH_CC_REVIEW_TIMEOUT_MS 的文档描述与代码实际语义（按 kind 分档）不一致，
//     直到修复任务才补文档。
//   - 仓库无 package.json scripts（此前实测 scripts 字段为空），因此验证必须能被主 agent 直接 node 调用。
export const task = {
  taskId: 'v3-1-engine-doc-sync',
  kind: 'implement',
  title: 'V3-1: 引擎↔文档一致性校验器（路由表/环境开关/版本锚点 三类机器事实 vs 文档；--check 漂移即失败）',
  refs: ['lib/index.js', 'docs/CC-HYBRID.md', 'docs/COMPATIBILITY.md'],
  acceptance:
    '新增 scripts/sync-engine-docs.mjs，可 node 直接运行；--check 收集三类机器事实（webServer.register 路由、process.env.DSH_* 开关、package.json/协议版本锚点）并与文档比对，'
    + '漂移时 exit≠0 且输出结构化清单（缺项/多项），无漂移时 exit 0 且输出计数；不修改任何文档（只读校验）；'
    + 'test/sync-engine-docs.test.js 用临时夹具覆盖「无漂移通过」「路由缺失」「开关缺失」「版本锚点不一致」四类，≥4 例全绿；'
    + 'node --check 通过；全量测试全绿且既有用例不减；verify-files-coverage 通过（新脚本在 package files 覆盖内）；改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务建立「引擎与文档一致性」的机器校验，防止文档与代码漂移（此前已发生：突破度门禁只在文档里成立、环境开关语义与代码不一致）。结论必须有命令输出。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【第 0 步（必做）：可行性审计】
把下列取证结果写进 report.md 的「现状取证」：
1. ls scripts/，确认 sync-engine-docs.* 是否已存在（若已存在则本任务转为"增强现有脚本"并在报告说明，不得重写）；
2. grep -c "webServer.register" lib/index.js，列出全部注册的路由路径字符串（这是第一类机器事实）；
3. grep -o "process\\.env\\.DSH_[A-Z_]*" lib/*.js | sort -u，列出全部环境开关（第二类机器事实）；
4. node -e 读 package.json 取 version（第三类机器事实）；确认 package.json 是否有 scripts 字段（用于说明为何不注册 npm script）；
5. Read docs/CC-HYBRID.md 的结构，指出路由表/环境开关/版本锚点分别该落在哪一节（给出小节标题与行号）。
**已存在的能力一律标注「已存在」，禁止重造**（lesson L-2026-0914-060）。

【★ 返工要求（第二次尝试被 Windows 侧验收拒绝，必须处理）】
本仓库验收基线是 **Windows**：显式清单 node --test 在 Windows 上必须全绿（基线：全量 ≥499 例、*.test.js 子集 ≥359 例）。
上次交付的 test/sync-engine-docs.test.js（8 例）在 WSL 能过，但 **Windows 上 7 例失败**，实测清单：
「无漂移」「路由缺失」「环境开关缺失」「版本锚点不一致」「版本锚点简写」「（加分）stale-in-doc」「正则无命中」。
典型断言差异（Windows 实跑）：
    actual: false, expected: true
    actual: [],    expected: [ '/dsh-web-relay/steps/new-route' ]
→ 夹具写入的假 lib/文档在 Windows 上没被收集到（典型的分隔符 / 绝对路径 / tmpdir 问题）。
要求：
1) 夹具完全跨平台：一律 path.join 拼路径；临时目录用 fs.mkdtempSync(path.join(os.tmpdir(), 'sed-'))；
   不硬编码 /tmp；断言路径统一 path.join 或统一转 POSIX 后比较；
2) scripts/sync-engine-docs.mjs 内部也不得依赖平台（读文件用 path.join；路由/开关正则不假定分隔符）；
3) 交付前**在 Windows 侧实跑**并贴证据：node --test --test-reporter=tap test/sync-engine-docs.test.js（8/8 全绿）
   与全量显式清单（0 失败；若出现 shadow-gate 等路径相关失败，必须用 git stash 证明改动前同样失败）；
4) 若某断言在 Windows 下无法稳定成立，改为对**纯函数返回值**断言（collectEngineFacts/diffFacts），
   而不是对平台路径字符串断言——用例数与覆盖面不得减少。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/scripts/sync-engine-docs.mjs（**新建**）
- /mnt/d/dsh-web-relay/test/sync-engine-docs.test.js（**新建**）
- /mnt/d/dsh-web-relay/package.json（**仅**在 files 数组需要加入新脚本路径时；除此之外不得改动，尤其不得加 scripts）
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md（**仅**当 --check 发现的真实缺项必须补齐时；补的是既有事实，不得虚构能力）
其它文件一律不得改动。

【要求】
1) **只读校验器**：scripts/sync-engine-docs.mjs
   - 用法：node scripts/sync-engine-docs.mjs [--check] [--json] [--root <dir>]（默认 root=仓库根；--check 为默认行为）；
   - 三类比对：
     a) **路由**：从 lib/index.js 提取 webServer.register 的 path 字符串（形如 /dsh-web-relay/steps/update），
        逐一确认在 docs/CC-HYBRID.md 中出现；反向也检查文档里写了但代码未注册的路由（标记为 stale-doc）；
     b) **环境开关**：从 lib/*.js 提取 process.env.DSH_* 名称，逐一确认在 docs/CC-HYBRID.md 中被记载；
     c) **版本锚点**：package.json 的 version 必须出现在 README.md 与 docs/COMPATIBILITY.md 的版本锚点处
        （若文档采用"4.9.x"锚点格式，请按实际格式匹配，并在报告中说明你所采用的匹配规则）。
   - 输出：无漂移 → 打印三类事实的计数并 exit 0；有漂移 → 打印结构化清单（每类下列出 missing-in-doc / stale-in-doc），
     --json 时输出机器可读 JSON（字段：routes/envSwitches/versionAnchors 各自的 ok 与差异数组），exit≠0。
   - **不得**修改任何文件（本脚本纯校验；文档补齐由人或主 agent 决定）。
   - 容错：文档缺失/正则无命中时给出明确诊断信息，不得抛栈；对无命中的类别标记为 warning 而非静默通过。
2) **可测性**：把"收集事实"与"比对"做成可注入入参的纯函数（例如 collectEngineFacts({ readFile, root }) 与
   diffFacts(facts, docs)），CLI 只做 IO 与退出码。测试不得依赖真实仓库内容（用临时目录夹具）。
3) **测试** test/sync-engine-docs.test.js（≥4 例，纯夹具，不碰真实网络）：
   - 夹具中文档与引擎一致 → diff 为空、exit 语义为通过；
   - 夹具中某路由未写进文档 → missing-in-doc 命中该路由；
   - 夹具中某环境开关未写进文档 → missing-in-doc 命中该开关；
   - 夹具中版本锚点不一致 → versionAnchors.ok=false 且列出期望值与实际值；
   - （加分）文档写了代码不存在的路由 → stale-in-doc 命中。
4) **实测并落文档**：用真实的仓库跑一次 node scripts/sync-engine-docs.mjs --check，把**真实漂移清单**
   贴进 report.md；若确有缺项且属于"文档漏记既有事实"，可以在 docs/CC-HYBRID.md 补齐（只补事实），
   补完后再跑一次给出"零漂移"输出；若你判断某些缺项属于历史遗留且补齐风险高，则保留漂移并在报告中列明，**不得删文档内容来凑通过**。
5) 不得引入任何新依赖（只用 node 内置模块）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check scripts/sync-engine-docs.mjs && node --check test/sync-engine-docs.test.js 通过；
② node scripts/sync-engine-docs.mjs --check 的真实输出（含三类计数与漂移清单）粘贴进报告；--json 输出也给一份；
③ node --test --test-reporter=tap test/sync-engine-docs.test.js 全绿（贴用例数 ≥4）；
④ 全量回归：node --test --test-reporter=tap $(ls test/*.test.js test/*.test.mjs) 不得新增失败；
   **不要**用 node --test test/（Node 26 会把目录当单个测试项而报 1 个假失败）。主 agent 侧基线：*.test.js 子集 306 例、全量 441 例全通过；
⑤ node scripts/verify-files-coverage.mjs 通过；node scripts/verify-capabilities.mjs 通过；
⑥ 改动/新建文件 2 空格缩进 + LF + 无 BOM（node fs.writeFileSync(p, s, 'utf8')；**不要**用 PowerShell 读写文件——lesson L-2026-0914-061）；
⑦ git -C /mnt/d/dsh-web-relay status --porcelain 只含写入范围内文件（贴进 report.md）；
⑧ 报告含：现状取证行号、脚本用法与退出码语义、三类事实的匹配规则、真实漂移清单、补齐了哪些文档缺项、
   残余漂移与未做项。

【交付物】out/report.md + 任务根 done.flag（Bash: touch done.flag）。禁止修改任务目录以外的非上述文件。`,
};
