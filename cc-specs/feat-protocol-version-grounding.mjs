// V1 实施规格：协议版本选择器接地（后端单一数据源 + 数据驱动前端 + contentKey 泛化 + 交付接地）
//
// 来源：外部 AI（web-Gemini 通道，expr-2026-09-22_17-42-08）7 步 Step List；
//       1-5 步为其原始规划，6-7 步由主 agent 以 restructure 追加（补漏：宿主实际加载 profiles/web 运行副本、
//       仓库全量测试与既有门禁/回归），追加已在 traces 留痕。
//
// 本规格把 7 步合并为**一次串行派发**：第 2、3 步都改 lib/client.js，
// 外部 AI 的 depends_on 只保证"在 1 之后"，未互相串行——并发改同一文件必冲突，
// 故在派发层强制串行（不改动其规划内容）。
export const task = {
  taskId: 'ccfeat-20260922-protoversion',
  kind: 'implement',
  title: '协议版本选择器接地：后端版本元数据单一来源 + 前端数据驱动 + contentKey 泛化 + 三副本交付',
  refs: ['lib/index.js', 'lib/client.js', 'test/compat-metadata.test.js', 'test/hybrid-channel-ui.test.js', 'docs/COMPATIBILITY.md'],
  acceptanceScript: 'probes/protocol-version-grounding-accept.mjs',
  anchors: [
    { file: 'lib/index.js', pattern: 'const isConcurrent = (v) =>', note: '后端唯一按版本分叉处（v1.6–v2.0 并发）；本任务把版本清单收敛为单一来源，isConcurrent 必须改为读该来源' },
    { file: 'lib/index.js', pattern: 'const protocolV20 = {', note: '/context payload 构造处：新增 protocolVersions[] 元数据并随 /context 返回' },
    { file: 'lib/index.js', pattern: 'protocolVersion: data.protocolVersion || ', note: 'readStepState 缺省回落 v1.5 —— 本次**不得修改**该行为（改它会让历史 14 个未写版本的 expr 拓扑语义变化）' },
    { file: 'lib/client.js', pattern: "const [protocolVersion, setProtocolVersion] = useState(() => {", note: 'localStorage 白名单 + 静默回落 v1.5 的源头（缺陷本体）' },
    { file: 'lib/client.js', pattern: "h('option', { value: 'v1.5' }", note: '硬编码 5 个 option 的下拉（缺陷本体）' },
    { file: 'lib/client.js', pattern: 'const pick = protocolVersion === ', note: '逐版本取正文的 if/三元链（缺陷本体，须泛化为 contentKey 映射）' },
  ],
  acceptance:
    '① 后端暴露协议版本元数据单一来源：lib/index.js 定义一份 PROTOCOL_VERSIONS_META（元素含 version / concurrent / contentKey / label），'
    + 'isConcurrent 改为读该来源（不得再手写版本字面量或链），/dsh-web-relay/context 响应新增 protocolVersions[] 字段（等于该元数据）。'
    + '② 新增版本只需改一处：元数据里加一个版本（含 contentKey），测试环境断言 /context 自动多出对应正文键，且元数据中每个 contentKey 在 /context 都有非空正文。'
    + '③ 前端不再有重复版本知识：lib/client.js 的下拉选项、localStorage 取值校验、正文取值三处全部改为读 /context.protocolVersions（数据驱动）；'
    + '禁止出现整串硬编码版本列表、禁止 localStorage 白名单、禁止逐版本 protocolVersion===\'v1.x\' 比较（分支数须降到 ≤2）。'
    + '④ 前端导出纯函数 resolveProtocolVersion(stored, meta)（挂在 client 工厂导出的出口上），语义：'
    + 'stored 命中元数据 → 返回该 version；未命中/缺失 → 返回元数据首项 version（**不得硬编码 v1.5**）；meta 为空 → 返回 null。'
    + '⑤ 下拉须有 fallback：/context 不可达时不白屏（用元数据的只读兜底副本渲染），并保留既有 localStorage 持久化。'
    + '⑥ 具体渲染行为无法在无头环境用真实浏览器验证，故验收以「源码级断言 + HTTP 实测」组合为准（见验收脚本），禁止声称做过浏览器实测。',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务把一个**有实证缺陷**的能力修好：协议版本选择器没有接地。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）
宿主实际加载的副本：C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-web-relay（Windows 侧；你只需保证仓库源码正确，覆盖由主 agent 用 deliver-three-copies.mjs 做）

【缺陷实证（主 agent 已取证，勿再质疑其存在）】
· 后端 v2.0 是活的：/dsh-web-relay/context 实测返回 protocolV20（version='v2.0'，正文 10917 字，中英双语均有）。
· 但前端协议版本下拉**从未**包含 v2.0：lib/client.js 硬编码 \`h('option',{value:'v1.5'})\`…\`'v1.9'\` 五个选项。
· localStorage 白名单（client.js 约 692-698 行）只认 v1.6|v1.7|v1.8|v1.9，其余**静默回落 v1.5**。
· 正文取值分支（client.js 约 866-884、1845-1849 行）无 v2.0 —— 即使手改 localStorage 为 v2.0，面板显示的仍是 v1.9 正文。
· 既有 99 个 expr 里有 21 个已落盘 protocolVersion='v2.0'（后端 isConcurrent 判为并发），前端却一律显示 v1.9 正文。
⇒ 同一份"版本知识"在后端常量 / 前端白名单 / 前端逐版本取值**三处重复**，且无任何机器断言关联。
（反向复现：验收脚本内置旧世界解析器，断言 legacyResolve('v2.0') === 'v1.5' —— 它当前 PASS，证明缺陷真实存在。）

【硬性要求 1：后端单一来源】
· 在 lib/index.js 定义一份协议版本元数据常量（建议名 PROTOCOL_VERSIONS_META），元素形状：
  { version: 'v1.5', concurrent: false, contentKey: 'protocolV15', label: '<中文标签>' }，覆盖 v1.5/v1.6/v1.7/v1.8/v1.9/v2.0 六版，顺序从旧到新。
  键名 { version, concurrent, contentKey, label } **不得改名**（前端与验收脚本按此消费）。
· \`const isConcurrent = (v) => …\` 改为读该元数据（例如 META 里 concurrent 为真的集合），**不得**再手写 v1.6||v1.7||… 链。
· /dsh-web-relay/context 响应新增 \`protocolVersions\` 字段 = 该元数据（在既有 protocolV15..protocolV20 之外**新增**，不得移除既有键；
  注意 /context 有两个构造点——约 3083 行与约 5096 行，两处都要加，否则中英/两条路径会不一致）。

【硬性要求 2：前端数据驱动（消灭三处重复）】
· 下拉选项改为由 /context 的 protocolVersions 渲染（每项 label 用元数据 label），**不得**出现整串硬编码版本列表。
· localStorage 取值校验改为「命中元数据即采用」，不再白名单硬编码；非法/未知值按 resolveProtocolVersion 规则回落元数据首项。
· 正文取值改为 contentKey 映射：\`const meta = protocolVersions.find(m => m.version === protocolVersion); const body = ctx[meta.contentKey]\`，
  删除逐版本 if/三元链（目标：client.js 中 \`protocolVersion === 'v1.x'\` 比较出现 ≤2 次）。
· 导出纯函数并挂到 client 工厂出口：
  \`resolveProtocolVersion(stored, meta)\` —— stored 命中 → stored；未命中/缺失 → meta[0].version；meta 为空 → null。
  **不得硬编码 'v1.5' 作为回落值**（回落目标是"元数据首项"，由数据决定）。
· /context 不可达时不得白屏：保留一份只读兜底元数据用于渲染（网络失败降级，不是把兜底当唯一来源）。
· 版本持久化（localStorage 键 dsh-web-relay:protocol-version）行为保留。

【硬性要求 3：不得越界】
· **不得**修改 readStepState 里 \`protocolVersion: data.protocolVersion || 'v1.5'\` 的缺省回落——历史 14 个未写版本的 expr 拓扑语义必须不变。
· **不得**改动审核链（/steps/auto-review 的 external→web-gemini→claude-code→dialog→manual 与 reviewChannel）、配额、唤醒、cc 通道。
· **不得**新增/重命名协议版本号（不要造 v2.1）；**不得**新增 HTTP 端点（元数据随 /context 返回即可，避免两个来源）。
· **不得**跑 git init / 格式化 / 大范围重命名。

【写入范围（严格，其它文件一律不得改动）】
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/lib/client.js
- /mnt/d/dsh-web-relay/test/compat-metadata.test.js
- /mnt/d/dsh-web-relay/test/hybrid-channel-ui.test.js
- /mnt/d/dsh-web-relay/test/protocol-versions.test.js（新建，见下）
- /mnt/d/dsh-web-relay/docs/COMPATIBILITY.md（仅在确需同步版本语义说明时改）

【测试要求】
· 新建 test/protocol-versions.test.js，至少覆盖：
  ① 元数据六版齐全、version 唯一、并发档恰为 v1.6–v2.0（v1.5 非并发）；
  ② 元数据每个 contentKey 都能在一个模拟的 /context payload 里取到非空正文；
  ③ resolveProtocolVersion 四条语义（命中 / 未命中 / 缺失 / meta 空）；
  ④ 反向用例：用旧白名单逻辑断言 legacyResolve('v2.0')==='v1.5'（证明缺陷形态），并断言新逻辑给出 'v2.0'；
  ⑤ 源码级：lib/client.js 不再含整串硬编码版本列表、不再含 localStorage 白名单，且 \`protocolVersion === 'v1.x'\` 比较 ≤2 次。
· 既有用例不得减少；test/timeout-fix.test.js 的版本锚点测试若因本次不改版本号而无需变更，则不要动它。

【硬性验收（逐条写入 out/report.md 自证）】
① \`node --check\` 所有改动文件通过；
② 全量测试 \`node --test test/*.test.js\`（传展开后的文件列表，勿用目录参数）0 失败，并贴出改动前后的用例计数；
③ 运行 \`node probes/protocol-version-grounding-accept.mjs\` 并**贴完整输出**：源码静态断言与反向断言必须全 PASS；
   （该探针的 HTTP 断言依赖宿主重启加载新代码，本次允许 SKIP——不得把 SKIP 说成 PASS，也不得为了让 HTTP 段变绿而改探针。）
④ 运行 \`node probes/protocol-version-grounding-accept.mjs --selftest\` 贴输出（5/5）；
⑤ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑥ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8') 写文件；不要用 PowerShell 读写源码）；
⑦ 报告含：改动前后代码片段、三处重复版本知识各自如何被消除、resolveProtocolVersion 语义与四条用例、
   为何缺省回落必须是"元数据首项"而非 v1.5、残余风险（尤其：真实浏览器渲染未验证）。
⑧ 不要提交 git commit（主 agent 统一提交）；也不要运行 deliver-three-copies.mjs（第 6 步由主 agent 执行）。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
}
