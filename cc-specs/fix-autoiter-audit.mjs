// 修复任务：/steps/declare 未把 AutoIteration 判定落盘（autoIterDeclAudit 恒为 null）
// 取证（主 agent 已读源码，勿推翻）：
//   lib/index.js L1564 读白名单含 autoIterDeclAudit；L1614 写白名单也含 autoIterDeclAudit —— 字段两侧都通了，
//   但**从未被赋值**：stepsDeclareHandler（L3153-3178）在 L3170 先 writeStepState({...state, ...plan.after})，
//   直到 L3173 才 assessAutoIterDecl(plan.after) —— 判定只进了 L3174 的响应体，写完盘才计算，故落盘恒为 state 里的 null。
//   对照：/ask 路径（L2349）确实写了 autoIterDeclAudit: askAutoIterDecl，所以只有 declare 入口漏。
export const task = {
  taskId: 'ccfix-20260915-autoiteraudit',
  kind: 'implement',
  title: '修复 /steps/declare 未落盘 autoIterDeclAudit：判定须先算后写，并在审计字段中带来源与时间',
  refs: ['lib/index.js', 'lib/autoiter-decl.js'],
  acceptance:
    'stepsDeclareHandler 先计算 assessAutoIterDecl 再 writeStepState，使 steps.json 的 autoIterDeclAudit 在声明补全后非 null；'
    + '审计字段自带 at（ISO 时间）与 source（declare/ask）并含声明快照（iterations/autoDecision/finalAcceptance）与判定（complete/halfState/reasons/hint）；'
    + '/ask 路径同样补 source 标记（保持既有一致性）；读接口 /steps 能读回该字段；'
    + 'node --check 通过；新增用例 ≥4（declare 落盘非 null / 字段结构与来源 / 读接口可见 / 未声明时保持 null 或 null 语义不变）；'
    + '全量测试全绿且既有用例不减；verify-files-coverage 通过；改动文件 LF/无 BOM；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务修复一个**审计字段形同虚设**的缺陷：字段已在读写白名单里，却从未被赋值。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【缺陷实证（主 agent 已读源码取证，勿推翻、勿扩大】
- lib/index.js L1564（读白名单）与 L1614（写白名单）**均已包含** autoIterDeclAudit —— 也就是说读写通道都是通的，唯一问题是没人给它赋值。
- 直接原因在 stepsDeclareHandler（约 L3153-3178）：
    L3170  const updated = await writeStepState(base, exprId, { ...state, ...plan.after }, safePolicy)
    L3173  const autoIterDecl = assessAutoIterDecl(plan.after)
    L3174  json(res, 200, { ok: true, stepState: updated, autoIterDecl })
  **先写盘、后计算**：判定只进了 HTTP 响应体；写盘时 spread 的 state.autoIterDeclAudit 是 readStepState 读出来的 null（或旧值），故落盘恒为 null。
- 实测证据：权威 steps.json 中 autoIterDeclAudit = null，而 /steps/declare 的响应里 autoIterDecl 是有值的（complete/halfState/reasons 齐全）。
- 对照（说明只有这一个入口漏）：/ask 路径 L2349 明确写了 autoIterDeclAudit: askAutoIterDecl，故 /ask 路径不空。
- 影响：V1-2 规格要求的「判定落盘供面板/事后审计追溯」失效——人工缺席下的自动演化声明**无法事后审计**（响应是一次性的，落盘才是可追溯的）。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/test/autoiter-decl.test.js（已存在则扩充；不存在则新建）
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md（补充说明）
其它文件一律不得改动（含 package.json）。

【要求】
1) **先算后写**：在 stepsDeclareHandler 中把 assessAutoIterDecl 的计算**移到 writeStepState 之前**，并把结果作为 autoIterDeclAudit 一并传入写盘状态（不要再依赖 spread 旧 state 里的值）。
2) **审计字段自描述**：autoIterDeclAudit 的值应为对象，至少含：
   - at：ISO 时间戳（写入时刻）；
   - source：来源标记，declare 入口写 'declare'，/ask 入口写 'ask'（/ask 侧同样补上，保持一致）；
   - decl：本次声明快照 { iterations, autoDecision, finalAcceptance }；
   - verdict：assessAutoIterDecl 的判定 { complete, halfState, reasons, hint }（字段名照抄 assessAutoIterDecl 的真实返回，勿自创）。
   注意：assessAutoIterDecl 的实际返回字段是 complete / halfState / reasons / hint（见 lib/autoiter-decl.js L47-64），**不要臆造字段名**。
3) **不改变既有语义**：只新增/修正 autoIterDeclAudit 的落盘，不得改动 steps/status/finalized/iterations 等任何既有字段的行为；declare 仍不得触发任何执行（不 wake、不动 steps、不动 status）。
4) **读接口可见**：确认 /steps 读回时该字段能带出（读白名单已有，勿删）。
5) **测试**（≥4 例，纯函数/纯逻辑优先，不碰网络）：
   - declare 后 autoIterDeclAudit 非 null 且 at/source/decl/verdict 结构完整、source === 'declare'；
   - 声明完整（iterations>1 且 autoDecision=true）时 verdict.complete === true 且 halfState === false；
   - 半状态（iterations>1 且 autoDecision 非 true）时 verdict.halfState === true 且 reasons 非空；
   - 未声明/无声明字段时保持既有 null 语义（不得凭空写一个空对象冒充"已评估"）。
   既有用例不得减少。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check lib/index.js 通过；
② node --test --test-reporter=tap test/autoiter-decl.test.js 全绿（贴用例数与清单）；
③ 全量回归：node --test --test-reporter=tap（**显式测试文件清单**，不要用目录式调用）0 失败；
   基线：Windows 侧全量 517 例、*.test.js 子集 377 例（**必须在 Windows 语义下成立**：夹具用 path.join/os.tmpdir()，不硬编码 /tmp）；
   若出现路径相关失败，必须用 git stash 证明改动前同样失败；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：缺陷取证（L3170 先写 / L3173 后算的次序证据）、改动点 file:line、改动前后 autoIterDeclAudit 的实际值对比、新增用例清单、未做项与残余风险。`,
};
