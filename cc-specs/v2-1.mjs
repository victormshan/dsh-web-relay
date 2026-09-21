// V2-1 步骤契约规格（v2：原「新建案例库 + reflection-engine」前提已被审计证伪，按真实缺口重写）
//
// 审计证据（主 agent 已 grep 取证，实施者需自行复核并贴行号）：
//   - caseBlock（历史拒收案例）**只注入审核侧**：lib/index.js L655 定义、L719/L736 buildReviewPrompt、
//     L3249 取用、L3266 swarm 上下文、L3323/L3334/L3365 buildReviewPrompt 调用、L3352/L3397 cc 审核任务。
//   - lessonBlock（教训 Top-K）**只注入主 agent handoff**：L32 import、L1730-1734 生成、L1736
//     `return base + '\n' + MAIN_AGENT_ASSEMBLY + lessonBlock`（handoff 装配）。
//   - /ask 发给外部 AI 的 payload **既无案例也无教训注入**（grep 无命中）→ 规划方没有记忆，
//     这正是 lesson L-2026-0914-060 记录的三轮幻觉/重复造轮子的根因。
//   - 案例库 `web-relay/experiments/prompt-case-library.md` 已有真实案例（81 行，最早 2026-09-04）；
//     collectRejectedCases（L677，P1 v3.5.0 已修双重 bug）在 finalize 幂等追加。
//   - test/ 下**没有任何 case 相关测试文件**（覆盖 = 0）。
//   - 外部 AI 原方案要求新建 cases/rejected-cases.json + lib/reflection-engine.js = **第二套并行存储**，弃用。
export const task = {
  taskId: 'v2-1-planning-reflection',
  kind: 'implement',
  title: 'V2-1: 规划侧反思注入（/ask payload 注入 案例 Top-K + 教训 Top-K + 能力清单）+ 案例库抽出可测模块并补测试',
  refs: ['lib/index.js', 'lib/lessons-inject.js', 'docs/CC-HYBRID.md'],
  acceptance:
    '可行性审计前置（贴 grep 行号，已实现项标注已存在不重写）；lib/case-library.js 抽出案例库解析/选择纯函数且行为与旧实现等价，lib/index.js 改为调用它；'
    + '/ask 发给外部 AI 的 payload 注入三段机器生成内容（案例 Top-K、教训 Top-K、能力清单复用而非重写），并遵守总长度上限与明确的裁剪优先级；'
    + '无命中时整段省略不留空标题；test/case-library.test.js 新增 ≥6 例且全绿；'
    + 'node --check 通过；全量测试全绿且既有用例不减；verify-files-coverage 通过；改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务补上「规划侧反思闭环」——让外部 AI 规划时能看到历史拒收案例、教训与能力清单。结论必须有 file:line 证据与命令输出。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【第 0 步（必做，未做则判失败）：可行性审计】
先取证再动手，把下列结果的行号/命中数写进 report.md 的「现状取证」一节：
1. grep caseBlock 的全部命中行，确认它只出现在审核侧（buildReviewPrompt / swarm / cc 审核任务）；
2. grep lessonBlock 与 lessons-inject 的命中行，确认它只出现在 handoff 装配（约 L1730-1736）；
3. grep /ask 处理器（约 L2250-2290 与 payload 组装处），确认发给外部 AI 的文本里**没有**案例/教训注入；
4. ls test/ | grep -i case，确认案例库测试覆盖为 0；
5. Read lib/index.js L640-710，确认 readCaseLibrary/buildCaseBlock/collectRejectedCases 的现有语义与容错。
**凡已实现的要求一律标注「已存在」并跳过，禁止重写已上线能力**（lesson L-2026-0914-060）。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/lib/case-library.js（**新建**）
- /mnt/d/dsh-web-relay/lib/lessons-inject.js（仅在需要导出/微调时）
- /mnt/d/dsh-web-relay/test/case-library.test.js（**新建**）
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md（补充说明）
其它文件（含 package.json）一律不得改动。

【要求】
1) **抽出可测模块（行为等价，不得改语义）**：新建 lib/case-library.js，把案例库的**解析与选择**逻辑做成可注入纯函数
   （建议：parseCaseLibrary(text) → 条目数组；selectTopCases(items, { query, limit=3 }) → 选中条目；renderCaseBlock(selected) → 文本块），
   并把 readCaseLibrary/buildCaseBlock 的 IO 部分保留在 lib/index.js 但改为调用新模块。
   等价性要求（**逐条核对，不得"顺手优化"**——下面是主 agent 读实码得到的确切规则）：
   - 解析：正则 /## 案例 (\d+)[\s\S]*?exprId: ([^\n]+)[\s\S]*?stepId: ([^\n]+)[\s\S]*?category: ([^\n]+)[\s\S]*?reason: ([^\n]+)[\s\S]*?recordedAt: ([^\n]+)/g，
     字段 { seq, exprId, stepId, category, reason, recordedAt }，均 trim；读取失败/无匹配 → 空数组，不抛错。
   - 选择：query 小写后按 /\s+/ 切词，仅取 length>2 的词；每命中一个词出现在 case.reason.toLowerCase() 中 +1；
     若 query 包含 case.category（小写）再 +2；过滤 score>0 → 按 score 降序 → slice(0,3)（Top-K 硬上限 3）。
   - 渲染：【历史拒收案例（V3.1 反思注入，Top-K≤3）】 + 换行 + 每行 "N. [category] reason.slice(0,300)（exprId Step stepId）"；
     无命中或空库 → 返回空串 ''（不返回只有标题的空块）。
   - 注意：现有 category 加分项要求 **query 文本里出现类别名**（如 acceptance_gap），自由文本 prompt 基本不会命中——
     这是既有行为，**原样保留**，不要改成模糊匹配。
   - 现有 buildCaseBlock(base, step) 的 topic 来源是 step.detail + ' ' + step.acceptance；抽出后
     selectTopCases 应接受**通用 query 字符串**，由调用方决定（审核侧仍传 detail+acceptance，规划侧传用户 prompt）。
2) **/ask 规划侧注入（本任务核心）**：在 /ask 组装发给外部 AI 的 payload 时注入三段**机器生成**内容：
   a) 历史拒收案例 Top-K：用 lib/case-library.js 的 selectTopCases 按当前 prompt 匹配（无命中则**整段省略**，不留空标题）；
   b) 教训 Top-K：复用 lib/lessons-inject.js 既有的 topLessonsForTrigger/renderLessonBlock（触发源为当前 prompt），**不要另写一套**；
   c) 能力清单：复用现有能力清单生成函数（若仓库中已存在——先 grep 确认；不存在则本步**只留调用点**并注释说明依赖 V1-2 落地，不得在本次自行造一套）。
   注入总长度必须设上限（建议 ≤6000 字符）；超限按你在报告中声明的优先级裁剪，并实测报出三段各自的实际字符数（贴证据）。
   - **注入点（已在仓库内定位）**：/ask 处理器 provider=gemini-free 分支的 guidedPrompt 组装处（lib/index.js L2086-2096，传给 callGemini(L2102)）；
     降级分支 L2130+ / L2157+ / L2211 各有自己的组装，请在报告中列出实际覆盖的分支。只写进记录 md 而未进外呼 payload 视为未完成。
   - **路径解析必须分三类对待（混用会静默读空）**：
     a) **仓库资源**（docs/capabilities/registry.yaml）→ 用既有 REPO_ROOT/rel()（lib/index.js L1713-1716；L1721 已有先例）
        或 import.meta.url 相对解析（L59/L1727）；
     b) **工作区状态**（prompt-case-library.md 位于 web-relay/experiments/）→ **保持既有 fs.resolve(EXPERIMENTS_DIR + '/...', { cwd: base })**（L643/L687）——
        注意它在**工作区** base 下而非仓库根；若改用 REPO_ROOT 会读到不存在的文件 → 注入静默为空；
     c) **教训文件**（docs/main-agent-lessons.json）→ 复用既有 LESSONS_JSON_PATH（L1727 绝对路径）。
     三者都**禁止**硬编码绝对路径或依赖 process.cwd()。
3) **不做的事（明确边界）**：不新建第二套案例存储（禁用 cases/rejected-cases.json 之类）；不引入新依赖；不改动审核侧既有注入行为。
4) **测试**：新建 test/case-library.test.js，≥6 例，全部纯函数/注入入参，不碰真实 fs 与网络：
   - 正常条目解析（含 exprId/stepId/category/reason 字段）；
   - 缺字段/畸形条目被安全跳过；
   - 重复条目去重（exprId:stepId 幂等键）；
   - Top-K 上限（>3 条输入只返回 ≤3）；
   - 匹配命中与**不命中**（不命中返回空 → 渲染为空串）；
   - 空文本/文件不存在等容错路径不抛错；
   - 渲染文本包含案例 id 与 reason（供审核/规划方引用）。
5) （可选，允许不做但要说明理由）把 collectRejectedCases 从「仅 finalize」扩展到「单步被打回即时入库」，
   必须保持幂等（exprId:stepId 键已存在则不重复追加）；若判断有回归风险，在报告中写明不做与原因。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check lib/index.js && node --check lib/case-library.js && node --check lib/lessons-inject.js 通过；
② node --test --test-reporter=tap test/case-library.test.js 全绿（贴输出尾部与用例数）；
③ 全量回归：node --test --test-reporter=tap $(ls test/*.test.js test/*.test.mjs) 不得新增失败；
   **不要**用 node --test test/（Node 26 会把目录当单个测试项而报 1 个假失败）。主 agent 侧基线：*.test.js 子集 306 例、全量 441 例全通过；
④ node scripts/verify-files-coverage.mjs 通过（新模块必须被 package files 覆盖，否则会被指出）；
⑤ 改动/新建文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(p, s, 'utf8')；**不要**用 PowerShell 读写文件——lesson L-2026-0914-061）；
⑥ git -C /mnt/d/dsh-web-relay status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ report.md 含：现状取证行号、改动点 file:line、/ask 注入点的前后对比（注入前 payload 字符数 vs 注入后）、三段实际字符数、裁剪策略与理由、未做项与残余风险。

【交付物】out/report.md + 任务根 done.flag（Bash: touch done.flag）。禁止修改任务目录以外的非上述文件。`,
};
