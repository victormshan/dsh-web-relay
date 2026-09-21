// V1-2 步骤契约规格（v2：原前提已被实测证伪，按真实缺口重写）
//
// 原规格前提：「/ask 路径缺 autoDecision 落盘」——**已证伪**：
//   lib/index.js L2256-2270（ask 路径）与 L2618-2622（parse 路径）都已调用 extractAutoIterDecl 并把
//   iterations/currentIteration/finalAcceptance/autoDecision 写入 writeStepState（写白名单见 L1596-1599）。
// 真实缺口（实测）：外部 AI 只按**叙述式**声明（正文里写「（iterations: 3）」），严格 JSON 块缺失 →
//   宽松兜底只抓到 iterations=3，autoDecision/finalAcceptance 落成 false/null，形成**半状态**：
//   版间门认为共 3 版，但每版仍需人工审核 → 与「人工缺席下的自动演化」目标直接矛盾，且当前无任何告警。
//   证据：expr-2026-09-13_17-36-07.steps.json → iterations=3, autoDecision=false, finalAcceptance=null。
// 另据 lesson L-2026-0914-060：外部 AI 看不到仓库 → 需把**机器生成的能力清单**随 /ask 注入（根因治理）。
export const task = {
  taskId: 'v1-2-autoiter-decl-integrity',
  kind: 'implement',
  title: 'V1-2: AutoIteration 声明契约完整性（半状态可见化）+ /ask 注入机器生成能力清单与严格声明样例',
  refs: [
    'lib/autoiter-decl.js',
    'lib/index.js',
    'test/autoiter-decl.test.js',
    'docs/CC-HYBRID.md',
  ],
  acceptance:
    '可行性审计前置并给出行号证据（已实现项标注「已存在」不重写）；'
    + 'assessAutoIterDecl 半状态判定正确（iterations>1 且 autoDecision=false → halfState，iterations=1 或 autoDecision=true → 非半状态）；'
    + '/ask 响应对半状态可见化且不报错；/ask payload 注入机器生成的能力清单与严格声明块样例（清单非手写硬编码）；'
    + '新增受控声明补全入口（/steps/declare 或等价），非法 iterations 被拒且未携带 autoDecision 时不回退既有 true，并 appendTrace 留痕；'
    + 'node --check 通过；全量测试全绿且新增用例≥8（既有用例不减）；verify-files-coverage 通过；改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务修复「AutoIteration 声明契约不完整」导致的自治缺口。结论必须有代码证据（file:line）与命令输出。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码；禁止使用 /mnt/d/DSH/... 旧路径）

【第 0 步（必做，未做则本任务判失败）：可行性审计】
上一版 V1-2 规格声称「/ask 路径缺 autoDecision 落盘」，**已被实测证伪**。因此你必须先取证再动手：
1. 在 lib/index.js 中 grep \`extractAutoIterDecl\` 与 \`autoDecision\`，给出全部命中行号；
2. 确认 writeStepState 的写白名单是否已含 iterations/finalAcceptance/autoDecision；
3. 在 lib/index.js 中 grep 是否存在「iterations>1 但 autoDecision=false」的告警/校验逻辑；
4. 在 /ask payload 组装处 grep 是否已注入能力清单或声明样例。
把上述 4 项的行号/命中数写进 report.md 的「现状取证」一节。
**凡已实现的要求，一律标注「已存在」并跳过，禁止重写已上线能力**（lesson L-2026-0914-060：外部 AI 看不到仓库时最易重造已上线功能）。

【真实缺口（实测，按此实现）】
- 现象：外部 AI 在正文里写「系统设定自动演化代号为 AutoIteration（\`iterations: 3\`）」——是**叙述式**，
  没有协议要求的严格 JSON 块，于是 lib/autoiter-decl.js 的宽松兜底只抓到 iterations=3，
  autoDecision/finalAcceptance 落成 false/null。
- 已落盘证据（expr-2026-09-13_17-36-07.steps.json）：iterations=3、autoDecision=false、finalAcceptance=null，
  7 步全部 pending。后果：版间门认为共 3 版，但每版仍需人工审核 → 与「人工缺席下的自动演化」矛盾，且无任何告警。
- 协议依据：docs/main-agent-lessons.json L-2026-0903-002——只认严格 JSON 块，叙述式不解析（别改这条契约）。

【写入范围（严格）】只允许改动以下文件，其他一律不得改动：
- /mnt/d/dsh-web-relay/lib/autoiter-decl.js
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/test/autoiter-decl.test.js
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md（补充说明）

【要求】
1) **半状态判定（新增可注入纯函数，建议放在 lib/autoiter-decl.js）**：
   \`assessAutoIterDecl(decl)\` → \`{ complete, halfState, reasons: string[], hint: string|null }\`。
   规则：\`iterations > 1 && autoDecision !== true\` → \`halfState:true\`，reasons 说明「多版声明但未开自动决策」，
   hint 给出一条可直接复制的严格块示例（含 iterations 与 finalAcceptance 占位）；\`iterations <= 1\` → 非半状态（单轮属正常）；
   \`iterations > 1 && autoDecision === true\` → 非半状态。入参畸形（null/非对象/字段类型错）→ 返回
   \`{ complete:false, halfState:false, reasons:['invalid-decl'], hint:null }\`，**不得抛错**。
2) **可见化**：/ask 完成后，若判定为半状态，必须在 /ask 响应体中透出该判定（例如 \`autoIterDecl: { complete, halfState, reasons, hint }\`），
   并 \`console.warn\` 一条形如 \`[dsh-web-relay] AutoIteration 声明不完整: <reasons>（本次将按每版人工审核推进）\` 的日志；
   同时把该判定写入该 expr 的 steps.json 一个**新增**字段（例如 \`autoIterDeclAudit\`），供面板/审计读取。
   **不得**改变既有字段语义（iterations/autoDecision/finalAcceptance 的取值规则不变），**不得**让 /ask 因声明问题报错或中断。
3) **/ask 注入能力清单与声明样例**（根因治理，直接对应 lesson L-2026-0914-060）：
   在 /ask 发给外部 AI 的 payload 里附上两段**机器生成**的内容：
   a. 严格声明块样例与说明：明确「只有严格 JSON 块 \`{"iterations":N,"finalAcceptance":"…","autoDecision":true}\` 会被解析；正文叙述式声明会被忽略」；
   b. 能力清单：**运行时/构建时机器生成**（例如扫描 lib/*.js 的导出名 + 读取 docs/capabilities/registry.yaml 的条目），
      控制在约 2000 字符内并按稳定顺序输出；**严禁手写硬编码清单**（手写清单会随代码漂移，正是本插件要消除的漂移源）。
      生成函数必须可单测：registry.yaml 缺失或格式异常时优雅退化（返回可用清单或空清单 + 不抛错）。
   - **注入点（已在仓库内定位，必须落在这里）**：/ask 处理器中 provider=gemini-free 分支的 guidedPrompt 组装处
     （lib/index.js L2086-2096）。**实测：该 guidedPrompt 被同分支全部降级节点复用**——callGemini(L2102)、
     webGeminiAsk(L2106/L2117)、callDialogModel(L2110/L2121) 传的都是同一个 guidedPrompt，
     因此注入这一处即覆盖 external→web-gemini→dialog 整条链；另有一个独立的 provider=web-gemini 分支
     （L2128+ 自建 guidedPrompt，见 L2132-2135），能一并覆盖更好（请在报告中列出你实际覆盖了哪些分支与证据）。
     只把内容写进记录 md 而没进外呼 payload 视为未完成。
   - **路径解析必须复用既有范式**：读取 docs/capabilities/registry.yaml 时必须用既有 REPO_ROOT/rel()
     （lib/index.js L1713-1716；L1721 已有 rel('docs','capabilities','registry.yaml') 先例），
     或等价的 import.meta.url 相对解析（如 L59、L1727）；**禁止**硬编码绝对路径或依赖 process.cwd()——
     否则运行副本（装在 node_modules 下）读不到文件，注入会静默为空。
4) **兼容与回归**：lib/autoiter-decl.js 既有导出（extractAutoIterDecl 等）签名与行为保持不变；既有测试用例不得减少。
5) **声明补全入口（让「人工缺席下的自动演化」真正可启动）**：现状是半状态只能靠重新 /ask 或手改 JSON 来纠正，
   缺少受控入口。要求新增一个显式入口（例如 POST /dsh-web-relay/steps/declare，或复用 /steps/update 的 action=declare）：
   - 请求体：{ workspacePath, exprId, iterations?, finalAcceptance?, autoDecision?, reason? }；
     **必须接受 workspacePath**（与 /steps/update 一致，relay 靠它解析 base 定位 steps.json；缺了无法落盘）；
   - **响应体形状（契约，主 agent 侧工具 declare-autoiter.mjs 依赖）**：
     { ok: true, stepState: { iterations, autoDecision, finalAcceptance, ... }, autoIterDecl: { complete, halfState, reasons, hint } }
     ——即更新后的完整 stepState + assessAutoIterDecl 的判定结果，字段名不得改名（工具按此解析并回显核对）；
   - 校验：iterations 必须为 1-10 的整数（非法 → 400 且不写坏状态）；finalAcceptance 非空字符串；
   - **只允许显式置 true**：请求未携带 autoDecision 时不得把已有的 true 回退为 false（防误降级）；
   - 必须 appendTrace(role=用户或 mainagent) 记录「何时把声明从 X 改成 Y、理由 reason」，并在响应体返回更新后的声明 + assessAutoIterDecl 判定；
   - 该入口不得触发任何执行（只改声明状态）。
6) 测试（test/autoiter-decl.test.js 或新增测试文件，新增 ≥3 例）：合法声明生效且留痕文本含前后值；非法 iterations（0 / 11 / 字符串）被拒且状态不变；未携带 autoDecision 时既有 true 不回退。

【测试要求（test/autoiter-decl.test.js，新增用例 ≥5，全部用注入的 fake fs / 纯字符串入参，不得读写真实 D:\\cc-tasks）】
   - halfState：iterations=3 + autoDecision=false → true，hint 含严格块示例；
   - 非半状态：iterations=3 + autoDecision=true；iterations=1 + autoDecision=false；
   - 畸形入参（null / 字符串 / iterations 为字符串）→ complete:false 且不抛错；
   - 严格块优先：同一文本同时含严格块与叙述式 → 以严格块为准；
   - 能力清单生成：正常 registry 生成非空清单；registry 缺失时优雅退化且不抛错；
   - 全部使用注入的 fake fs / 纯字符串入参，**不得读写真实工作区外的路径、不得发网络请求**。

【硬性验收（逐条自证，贴命令与输出到 out/report.md）】
① \`node --check lib/autoiter-decl.js && node --check lib/index.js\` 通过。
② \`node --test --test-reporter=tap test/autoiter-decl.test.js\` 全绿，且报告里给出「新增前 vs 新增后」用例数。
③ 全量回归：\`node --test --test-reporter=tap $(ls test/*.test.js test/*.test.mjs)\`；
   **不要**用 \`node --test test/\`（Node 26 会把目录当单个测试项而报 1 个假失败）。主 agent 侧实测基线为 441 例全通过（*.test.js 子集 306 例）。
④ \`node scripts/verify-files-coverage.mjs\` 通过。
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(p, s, 'utf8')；**不要**用 PowerShell 读写文件——lesson L-2026-0914-061：PowerShell 转写会造成 UTF-8 双重编码）。
⑥ \`git -C /mnt/d/dsh-web-relay status --porcelain\` 只含写入范围内文件（贴进 report.md）。
⑦ 报告含「现状取证」一节（第 0 步 4 项 grep 的行号/命中数）+ 改动点 file:line + 新增用例名 + 未做项与残余风险。`,
};
