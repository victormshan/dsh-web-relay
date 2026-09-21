// A/B 实验（B 组）：规格评审协议的对照实验。本文件由 gen-ab-specs.mjs 生成，请勿手改。
// 唯一变量 = 评审协议段落；语料、输出格式、约束与另一组逐字节相同。
export const task = {
  taskId: 'ccab-20260916-review-b',
  kind: 'understand',
  title: 'A/B 实验 B 组：对 7 份 spec 草稿做规格评审（机器可读结论块）',
  refs: ['lib/index.js', 'lib/selfcheck.mjs', 'lib/cc-stats.mjs', 'bin/watchdog.mjs'],
  anchors: [
    { file: 'lib/cc-stats.mjs', pattern: 'export function summarizeChainTasks', note: '仓库存在的符号之一（供你核对草稿断言）' },
  ],
  acceptance:
    'out/report.md 必须包含严格格式的 AB-RESULT 机器可读块，对案例 1..7 各给一行 '
    + 'FOUND|NOT_FOUND|UNCERTAIN 并附 evidence（文件:行号）与 finding；'
    + '块之后附每案例 2-4 行理由；**不得修改仓库任何文件**（写入范围外零改动，本任务写入范围为空）；'
    + 'node --check 对改动文件（应为 0 个）通过。',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  writeScope: [],
  prompt: `你是 dsh-web-relay 项目的**规格评审员**。下面给出 7 份 spec 草稿片段（来自真实工程），请你评审并逐份给出结论。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码，**只读**；你可以且应当读源码来核对草稿中的断言）

【语料】本消息末尾附有 7 份草稿。请对每一份独立评审。

【本任务约束】
- **不得修改仓库任何文件**；只允许读取与检索。
- 产物只写你自己的工作目录 out/report.md（任务契约已约定）。
- 不要猜测本任务的目的或草稿的来源；只按工程事实评审。

【必须输出机器可读块】报告 out/report.md 中必须包含如下块（严格格式，逐案例一行，顺序与编号一致）：

AB-RESULT-BEGIN
CASE 1: FOUND|NOT_FOUND|UNCERTAIN | evidence=<文件:行号 或 -> | finding=<一句话>
CASE 2: ...
...
CASE 7: ...
AB-RESULT-END

字段含义：
- FOUND     = 你认定该草稿存在**真实缺陷**（会导致门禁失败、结论错误、或状态不一致）
- NOT_FOUND = 你认定该草稿没有问题
- UNCERTAIN = 你无法在有权限范围内证实或证伪
evidence 字段：给出你结论所依据的证据位置（文件:行号）。若你的结论无法指向任何仓库位置，写 - 。

【报告还应包含】每个案例的简短理由（2-4 行），放在机器可读块之后。

【评审协议（B 组）】
对每份草稿，严格执行以下反证纪律：
1) **主动反证**：把你的任务理解为「尝试推翻这份草稿」，而不是「理解并认可它」。对草稿中每一条**可核对的断言**
   （锚点是否存在、文件是否存在、数值是否属实、结论是否成立、状态是否会不一致），都要真的去仓库里核对。
2) **证据强制**：任何 FOUND 结论**必须**附带仓库中的具体位置（文件:行号）；给不出位置的判断不得标 FOUND。
   草稿引用二手来源（例如注释、文档）时，**必须回源到权威实现**核对，不得直接采信二手来源。
3) **不轻信既有结论**：草稿说"已完成/已消除/已规避"时，必须验证该说法在代码上是否真的成立。
4) **无法证实即标 UNCERTAIN**：不得用"看起来合理"代替证据。

================ 草稿语料（共 7 份） ================

【案例 1】某 spec 的 anchors 声明与对应验收：
anchors: [
  { file: 'lib/index.js', pattern: 'function healthHeavyEmpty(', note: '缓存空态形状——必须同步补新字段' },
]
验收条款：该锚点必须通过规格门禁 check-spec 的锚点校验。

【案例 2】某 spec 的写入范围：
- lib/index.js
- lib/selfcheck.mjs
- test/selfcheck.test.mjs（若已存在则扩充；用于字段契约用例）

【案例 3】某 spec 的性能论证：
"lib/index.js 的注释记载 watchdog 探针超时为 2000ms。本次改动给「重启后首次探测」新增约 155-248ms，
 使该路径总耗时达到约 1670-1770ms，逼近探针超时，因此必须优化首探路径，否则会触发误判宿主失联。"

【案例 4】某修复方案的处置描述：
"诊断模式（--selftest-quota / --probe-only）会产生状态副作用：它们不传链条文件，默认落到 v1-v3，
 会触发换链条逻辑并写出多余备份。修复：在换链条判断之前加 diagnosticOnly 豁免，诊断模式直接跳过换链条。
 该修复已完成，副作用已消除。"

【案例 5】某链条项的标注设计：
"链条项不挂 planStepId（避免给已收口的计划补塞步骤）。运行链条时仍传 --close-after-accept，
 由 cc-chain.mjs 统一决定该项的状态标注。这样既避免伪造协议步骤，又能让链条统一收口。"

【案例 6】某 spec 的 anchors 声明：
anchors: [
  { file: 'lib/cc-stats.mjs', pattern: 'export function summarizeChainTasks', note: '聚合纯函数（直接复用）' },
  { file: 'lib/selfcheck.mjs', pattern: 'export const SELFCHECK_REQUIRED_HEALTH_FIELDS', note: '契约清单' },
]

【案例 7】某 spec 的写入范围与验收：
写入范围：lib/cc-stats.mjs、test/cc-stats.test.mjs
验收：node --check 通过；新增用例 ≥8 且既有用例不减；排除 test/shadow-gate.test.js 后全量 0 失败；
     改动文件 LF/无 BOM；写入范围外零改动。

================ 语料结束 ================`,
};
