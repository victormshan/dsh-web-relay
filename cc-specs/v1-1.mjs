// V1-1 步骤契约规格（精修版：对齐 lib/breakthrough-gate.js 真实 API 与 warn 语义）
// 派发: node cc-dispatch.mjs cc-specs/v1-1.mjs
export const task = {
  taskId: 'v1-1-breakthrough-gate',
  kind: 'implement',
  title: 'V1-1: 突破度三阶评估硬门禁（warn→阻断：连续 Incremental 拦截 + restructure 接入）',
  refs: [],
  acceptance:
    'lib/breakthrough-gate.js 新增 evaluateBreakthroughPlan({steps, history}) 纯函数，复用既有 breakthroughTypeOf/versionTypeOf；阈值 env DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL 默认 3，达到即 gatePassed=false + requiredType="structural" + reasons 给出依据；既有 auditBreakthrough 的 warn(streak>=2) 语义与 3 个既有导出保持不变；lib/index.js 的 /steps/restructure 在 gatePassed=false 时返回 400 + error="breakthrough-gate" 并 appendTrace 留痕，成功时返回体附 breakthrough 审计字段；未触发时行为零变化；处理「全部未声明 breakthrough_type」的保守拦截（verdict=gate-needs-declaration，env DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED=1 可显式放行），且 /ask 路径必须审计并落盘 incrementalStreak 以堵住绕过；node --check 通过；node --test test/*.test.js 全绿且 breakthrough-gate 用例从 5 增至 ≥13；verify-files-coverage 通过；写入范围外零改动',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务把「Architect 突破度三阶评估」从**非阻断 warn** 升级为**代码层硬门禁**（保留 warn 作为轻提示）。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码；禁止使用 /mnt/d/DSH/... 旧路径）

【现状（请先 Read 核对，勿凭猜测）】
- lib/breakthrough-gate.js（43 行）现有导出：
  - breakthroughTypeOf(step) → 'incremental'|'structural'|'paradigm'|null（读 step.breakthrough_type，兼容 architect_vision/architect 嵌套）
  - versionTypeOf(steps) → 'breakthrough'（含 structural/paradigm）| 'incremental'（仅 incremental）| null（均无）
  - auditBreakthrough(steps, prevStreak=0) → { streak, warn }：**warn 在 streak >= 2 时给出，非阻断**（P3 v3.5.0 语义）
- lib/index.js 的 /steps/restructure 处理器（约 L3960-4050）已做依赖校验（悬空 depends_on → 400）与 normalizeStep 归一化。
- 缺口依据：docs/v3-roadmap-implementation-gap-analysis.md §2.4 与 §5 第 3 项（"Architect 突破度无代码门禁，仅协议文本"）。
- 既有测试：test/breakthrough-gate.test.js（5 个用例，测上述 3 个导出 + 源码级接线断言）。

【写入范围（严格，越界即失败）】
- /mnt/d/dsh-web-relay/lib/breakthrough-gate.js
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/test/breakthrough-gate.test.js
- /mnt/d/dsh-web-relay/docs/CC-HYBRID.md（仅在需要补一行说明时）
其他文件一律不得改动（含 package.json、其他测试文件）。

【要求】
1) 新增纯函数（无 IO、无 Date/随机、可注入历史）：
   evaluateBreakthroughPlan({ steps, history }) →
     { gatePassed, consecutiveIncremental, verdict, requiredType, reasons[] }
   - 复用 breakthroughTypeOf/versionTypeOf，**不要**重复实现类型判定；
   - "本版纯 Incremental" = versionTypeOf(steps) === 'incremental'（含 unknown/null 视为不触发，防误报）；
   - consecutiveIncremental = 历史连续纯 Incremental 版本数（history 为数组，元素可为 'incremental'|'breakthrough'|null 或 {type} 形式；按"遇 breakthrough 归零、遇 null 跳过不重置"累计）+（本版为 incremental ? 1 : 0）；
   - MAX = Number(process.env.DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL || 3)；
   - consecutiveIncremental >= MAX → gatePassed=false、requiredType='structural'、reasons 列出计入的版本序号/依据（可读中文）；否则 gatePassed=true、requiredType=null、reasons=[]；
   - verdict 给出简短结论串（如 'gate-blocked' / 'gate-passed'）。
2) **保留** auditBreakthrough 的现有语义与返回值（warn at streak>=2，非阻断），不得改动其签名与既有 5 个用例的断言目标。
3) lib/index.js 的 /steps/restructure 接入门禁：
   - 在既有校验之后、写盘之前调用 evaluateBreakthroughPlan（历史从该 expr 已有步骤/状态推导，说明推导依据）；
   - gatePassed=false → HTTP 400 + { ok:false, error:'breakthrough-gate', gatePassed:false, requiredType, consecutiveIncremental, reasons }，并 appendTrace(role='mainagent') 记录拒绝原因；
   - gatePassed=true → 正常放行，且返回体附 breakthrough:{ gatePassed, consecutiveIncremental, verdict }（审计可见）；
   - 未触发阈值时**行为零变化**（approved 保留、悬空依赖 400、normalizeStep 语义不变）。
   - **声明可达性（关键前提，已实测）**：normalizeStep 自 v3.7.0 P1 起**已透传** breakthrough_type（lib/index.js L1257-1258），
     但 L4128 的注释仍写着「normalizeStep 会丢弃 breakthrough_type」——**该注释已过期，必须一并修正**（文档真相）。
     门禁求值所用的数组必须确实携带 breakthrough_type：请用一条回归测试证明「声明了 breakthrough_type 的步骤经 restructure 后仍能被门禁看到」
     （例如构造含 breakthrough_type 的步骤走 normalizeStep 后断言字段仍在；或证明你审计的是原始 newSteps 并贴出证据）。
     若忽略此点，门禁会因全程读到 null 而静默失效——与本次要修复的原始缺陷同类。
   - **向后兼容**：触发既有 warn（streak>=2）时，响应体仍须保留 breakthrough.warn 与 breakthrough.streak（既有前端/审计依赖），
     并在其上追加 gatePassed/consecutiveIncremental/verdict，不得删字段。
4) **输入契约与绕过路径（关键，缺此则门禁形同虚设——实测证据）**：
   - 实测证据：权威计划 expr-2026-09-13_17-36-07 的 7 步 breakthrough_type **全部为 null**；
     而 breakthroughTypeOf 返回 null 时 versionTypeOf 返回 null，auditBreakthrough 对 unknown「不计不重置」→
     streak 永不增长 → 门禁在**任何**阈值下都不会触发。即：只加门禁而不解决「声明缺失」，等于没加。
   - 因此 evaluateBreakthroughPlan 必须处理「全部未声明」：当 steps 非空且其中**没有任何** step 声明
     breakthrough_type（含嵌套 architect_vision/architect）时，返回
     { gatePassed:false, verdict:'gate-needs-declaration', requiredType:'structural' }，
     reasons 说明「本版未声明任何突破度类型，无法判定；请由规划方补 breakthrough_type
     （incremental/structural/paradigm）」——**默认保守拦截**；
     并提供 env DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED=1 作为显式放行开关（默认关闭），
     置 1 时该情形按放行处理（verdict='gate-passed-undeclared-allowed'），便于兼容存量计划。
   - **绕过路径必须堵上**：现状 /ask 路径（lib/index.js 约 L2256-2270 的第 0 步落盘处）**完全不审计**，
     导致 incrementalStreak 恒为 0，外部 AI 经 /ask 产出的计划可绕过门禁。要求 /ask 路径也执行一次
     auditBreakthrough（历史取该 expr 已有 incrementalStreak）并把结果写入 steps.json 的 incrementalStreak；
     在 /ask 响应体透出该审计结果字段（形如 breakthrough: { gatePassed, verdict, consecutiveIncremental, reasons }）并 console.warn，
     **但不阻断 /ask 响应**（/ask 是方案生成，允许后续按提示修正；阻断只发生在 restructure）。
5) 测试：test/breakthrough-gate.test.js 由 5 个用例增至 **≥13** 个（纯函数、不碰真实 fs/网络、跨平台 path.join），新增覆盖：阈值边界（2 次放行 / 3 次拦截）、env 覆盖（设为 2 时 2 次即拦截）、本版含 structural → 放行且 streak 归零、历史为空、unknown/null 不重置不触发、reasons 含具体依据、verdict 取值、**全部未声明 → gatePassed=false + verdict='gate-needs-declaration'**、**未声明且 DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED=1 → 放行**；并保留原有 5 个用例。

【硬性验收（逐条写入 out/report.md 自证）】
1) cd /mnt/d/dsh-web-relay && node --check lib/breakthrough-gate.js && node --check lib/index.js 通过；
2) node --test test/*.test.js 全绿（贴命令与输出尾部；既有用例数不得减少）；
3) node --test test/breakthrough-gate.test.js 通过，且用例数 ≥ 13（原 5 + 新 ≥8，贴实际数字）；
4) node scripts/verify-files-coverage.mjs 通过；
5) 改动文件 2 空格缩进 + LF + 无 BOM（node fs.writeFileSync(...,'utf8')）；
6) git -C /mnt/d/dsh-web-relay status --porcelain 只含写入范围内文件（贴进 report.md）；
7) report.md 给出：新函数签名与语义、restructure 接入点 file:line、拒绝时的响应体样例、warn 与门禁的共存说明。

【交付物】out/report.md + 任务根 done.flag（Bash: touch done.flag）。禁止修改任务目录以外的非上述文件。`,
};
