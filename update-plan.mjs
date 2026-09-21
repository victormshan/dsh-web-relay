// 按本轮审计结果更新权威计划（expr-2026-09-13_17-36-07）
// 原则：只改被证伪/需补强的步骤文本，id/depends_on/importance/review 保持不动（防止顺手改写依赖图）
import fs from 'node:fs';

const SRC = String.raw`D:\dsh relay test\web-relay\experiments\expr-2026-09-13_17-36-07.steps.json`;
const OUT = String.raw`D:\dsh relay test\_steps-v2.json`;

const updates = {
  '1': {
    title: 'V1-1: 强化突破度硬门禁（含输入契约与 /ask 绕过修补）',
    detail: '基于 lib/breakthrough-gate.js 增加连续 Incremental 计数拦截器：restructure 超阈值返回 400。'
      + '实测补强两点：① 输入契约——权威计划 7 步 breakthrough_type 全为 null，而 versionTypeOf 对 unknown 不计不重置，'
      + '导致门禁在任何阈值下都不会触发，故「全部未声明」必须保守拦截（verdict=gate-needs-declaration，'
      + 'env DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED=1 可显式放行）；② 绕过路径——/ask 路径（lib/index.js L2256-2270）'
      + '完全不审计，incrementalStreak 恒 0，外部 AI 经 /ask 出计划可绕过门禁，故 /ask 也必须审计并落盘。',
    acceptance: 'node --test test/breakthrough-gate.test.js 通过且用例由 5 增至 ≥13（含「全部未声明→保守拦截」与「ALLOW_UNDECLARED=1→放行」两例）；'
      + '/ask 路径审计落盘 incrementalStreak 并以回归测试证明不再绕过。',
    artifacts: ['lib/breakthrough-gate.js', 'test/breakthrough-gate.test.js', 'lib/index.js'],
  },
  '2': {
    title: 'V1-2: AutoIteration 声明完整性（半状态可见化）+ /ask 注入机器生成能力清单',
    detail: '原前提「/ask 缺 autoDecision 落盘」经实测证伪：L2256-2270 与 L2618-2622 均已调用 extractAutoIterDecl 并写入三字段，'
      + '权威 steps.json 实测 iterations=3 已落盘。真实缺口是**半状态**：外部 AI 只写叙述式声明（正文「（iterations: 3）」），'
      + '宽松兜底只抓到 iterations，autoDecision 落成 false、finalAcceptance 为 null —— 版间门认为共 3 版，但每版仍需人工审核，'
      + '且当前无任何告警，直接矛盾于「人工缺席下的自动演化」。本步：新增 assessAutoIterDecl 半状态判定并在 /ask 响应与 steps.json 可见化；'
      + '/ask payload 注入严格 JSON 声明块样例与**机器生成**的能力清单（禁止手写硬编码，随代码漂移）。',
    acceptance: 'node --check 通过；新增用例 ≥5（半状态/非半状态/畸形入参/严格块优先/能力清单退化）；'
      + '半状态时 /ask 响应透出判定且不报错；能力清单由运行时或脚本生成，registry 缺失时优雅退化。',
    artifacts: ['lib/autoiter-decl.js', 'lib/index.js', 'test/autoiter-decl.test.js'],
  },
  '3': {
    title: 'V1 版间门校验与 V1 成果合入',
    detail: '运行全量测试并校验 V1 两项产出的真实生效：① restructure 突破度门禁在「全 null 输入」下的保守拦截行为符合预期；'
      + '② /ask 路径的 incrementalStreak 审计落盘与半状态告警在真实 expr 上可观测；'
      + '③ 检查版间门（lib/index.js L3606）当前完全不读突破度的现状，并把该缺口移交给 V2-2。',
    acceptance: 'node --test 全量通过；V1 门禁与半状态可见化各给出一次真实 expr 的观测证据（steps.json 字段 + 响应片段）。',
  },
  '4': {
    title: 'V2-1: 规划侧反思注入 + 案例库抽出可测模块',
    detail: '审计结论（推翻原方案）：案例库**已存在且有真实数据**（web-relay/experiments/prompt-case-library.md 81 行，最早 2026-09-04），'
      + 'collectRejectedCases（L677）已在 P1 v3.5.0 修掉双重 bug（过滤只收仍 rejected + fs.writeText 三参写坏），'
      + '故原方案「新建 cases/rejected-cases.json + lib/reflection-engine.js」是**第二套并行存储**，弃用。'
      + '真实缺口：caseBlock 只注入审核侧（L719/L736/L3249/L3266/L3323+）、lessonBlock 只注入主 agent handoff（L1730-1736），'
      + '/ask 发给外部 AI 的 payload **零反射注入**；test/ 下 0 个 case 相关测试。'
      + '本步：抽出 lib/case-library.js（纯函数、行为等价）+ /ask payload 注入三段（案例 Top-K、教训 Top-K、能力清单，复用既有函数）+ 补测试。',
    acceptance: 'node --test test/case-library.test.js ≥6 例全绿；/ask 注入前后字符数与三段实际长度有实测对比；不新增第二套案例存储。',
    artifacts: ['[NEW] lib/case-library.js', '[NEW] test/case-library.test.js', 'lib/index.js', 'lib/lessons-inject.js'],
  },
  '5': {
    title: 'V2-2: 版间门与突破度联动（连续 Incremental 阻止进入下一版）',
    detail: '原 V2-2「对接 lessons-inject」已实现（L32 import、L1732-1736 handoff 装配），故重划。'
      + '真实缺口（实测）：版间门 L3606 只判 iterations/currentIteration 与「全部 approved」，**完全不读突破度**，'
      + '于是协议条款「每 2 个 Incremental 后下一版须含 Structural/Paradigm」在自动迭代里无人执行。'
      + '要求：Vn 全部 approved 且未达 iterations 上限时，若连续 incremental ≥ 阈值（复用 V1-1 的 evaluateBreakthroughPlan），'
      + '则不进入 Vn+1，改为把「下一版必须含 structural/paradigm」写入规划提示并唤醒主 agent，判定落盘留痕；未触发时行为零变化。',
    acceptance: 'node --check 通过；新增用例 ≥5（阈值触发/未触发/历史为空/unknown 不触发/唤醒文案含 requiredType）；全量测试不减少。',
    artifacts: ['lib/index.js', 'test/breakthrough-gate.test.js'],
  },
  '6': {
    title: 'V3-1: 引擎↔文档一致性校验器（路由表/环境开关/版本锚点）',
    detail: '审计结论：scripts/sync-engine-docs.* **不存在**（scripts/ 全部文件名已核）；'
      + 'docs/capabilities/registry.yaml 中 architect-breakthrough-gate 的 verification 只有 file-exists + content-contains（L174-178），'
      + '即能力「只在文档里成立」；本轮已实测到真实漂移（DSH_CC_REVIEW_TIMEOUT_MS 文档语义 vs 代码按 kind 分档）。'
      + '建立只读校验器：收集三类机器事实（webServer.register 路由、process.env.DSH_* 开关、package.json 版本锚点）并与文档比对，'
      + '漂移 exit≠0 并输出结构化清单；配套夹具测试。',
    acceptance: 'node scripts/sync-engine-docs.mjs --check 输出三类计数与真实漂移清单；test/sync-engine-docs.test.js ≥4 例全绿；verify-files-coverage 与 verify-capabilities 通过。',
    artifacts: ['[NEW] scripts/sync-engine-docs.mjs', '[NEW] test/sync-engine-docs.test.js', 'docs/CC-HYBRID.md', 'package.json'],
  },
  '7': {
    title: 'V3-2: 全量回归 + 三版 AutoIteration 端到端终验',
    detail: '跑全量测试；核验各缺口的代码化落地（突破度硬门禁与输入契约、声明完整性、规划侧反思注入、版间门联动、文档同步）；'
      + '按 finalAcceptance 收口——当前 finalAcceptance=null，需先由 V1-2 的声明完整性机制补出可核验标准；'
      + '产出三版迭代的轨迹与版间门判定证据；cc 通道侧一并核验失败分类（quota/permission/timeout）在 /health-check 可见。',
    acceptance: 'node --test 全量 100% 通过（Windows 侧基线 441 例；*.test.js 子集 306 例）；'
      + 'finalAcceptance 非空且逐条有证据；三版轨迹、版间门判定与突破度记录齐备。',
  },
};

const j = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const changed = [];
for (const s of j.steps) {
  const u = updates[String(s.id)];
  if (!u) continue;
  const before = JSON.stringify({ t: s.title, d: s.detail, a: s.acceptance, ar: s.artifacts });
  if (u.title) s.title = u.title;
  if (u.detail) s.detail = u.detail;
  if (u.acceptance) s.acceptance = u.acceptance;
  if (u.artifacts) s.artifacts = u.artifacts;
  const after = JSON.stringify({ t: s.title, d: s.detail, a: s.acceptance, ar: s.artifacts });
  if (before !== after) changed.push(String(s.id));
}

// 依赖图/元数据必须保持不动——自证
console.log('  更新步 =', changed.join(', ') || '(无)');
for (const s of j.steps) {
  console.log(`  [${s.id}] status=${s.status} imp=${s.importance} review=${s.review} depends_on=[${(s.depends_on || []).join(',')}] :: ${s.title}`);
}
fs.writeFileSync(OUT, JSON.stringify(j.steps, null, 2), 'utf8');
console.log('  已写出 ->', OUT);
