// 生成类实验生成器：测「多角色反证协议」能否提出**历史上被验证过的更优替代方案**
//
// 与 A/B（验证类）实验的区别：
//   A/B 测「能否发现草稿里**既存**的缺陷」；本实验只给**决策前**的上下文，测「能否**想出**更好的做法」。
//
// 防混淆（关键）：通用建议（如"大任务要拆"）模型从训练知识就能答对，会把效应吹高。
//   故每个案例标注 genericity，并**预登记**：主指标只在 repo-specific 子集上计算。
//
// 预登记（在看到任何结果前固定）：
//   H1：多角色反证协议（架构师提案 → 反证架构师专找"在本仓库特定机制下会失效"之处 → 择优）
//       比单方提议，在 **repo-specific 子集** 上提出历史验证替代方案的条数更多。
//   H0：无差异 → 判「该层面协议无收益」。
//   主指标：specific 子集（案例 1、2）命中数（0-2）。
//   次指标：全 4 例命中数；无关/误解建议数（定性）；耗时。
//   判定规则：D 更优 ⇔ specific 命中 D > S；相等即判无收益。规则此刻固定，事后不得调整。
import fs from 'node:fs';

// 每例：situation = **决策前**上下文（不含任何事后线索、不含答案）
//      truth       = 历史上被事件验证的更优做法（不下发给 cc）
//      tokens      = 命中判定用的概念组（每组命中任一 token 记为组命中；全部组命中才算 hit）
//      genericity  = 'specific' | 'mid' | 'generic'
const CASES = [
  {
    id: 1, genericity: 'specific',
    title: '链条状态文件的设计',
    situation: `某自动化链条包含若干待办项，由 Windows 计划任务每 20 分钟触发一次执行；
执行体把进度持久化到一个 JSON 状态文件里，以便断点续跑、并在全部跑完后不再重复派发。
现在要设计这个状态文件与"已跑完"判定。请给出你的设计。`,
    truth: '状态必须按链条身份隔离：实现里状态文件是全局单文件，且写盘时无条件把当前链条 id 写进去；于是当调度器改指另一条链条时，旧链条的 index/completedAt 被整体继承——新链条（项数更少）会命中「已完成」守卫被判为已跑完而静默跳过，永不派发（实测：5 项旧链条 index=5 对 1 项新链条）。正确做法是 chainId 变化即视为换链条，备份旧状态并按新链条重开。',
    tokens: [
      ['隔离', '独立', '按链条', 'per-chain', 'chainid', '分文件', '各自', '命名空间'],
      ['继承', '沿用', '旧状态', 'completedat', '静默', '跳过', '误判', '已完成', '残留'],
    ],
  },
  {
    id: 2, genericity: 'specific',
    title: '诊断模式的状态副作用',
    situation: `某脚本有正常模式与两个诊断模式（--probe-only / --selftest-quota）。三种模式共用同一段初始化代码，
初始化会载入状态文件、并在某些情况下改写状态（例如清空某个字段）。诊断模式要求"无副作用"。
现在要设计保证方式。请给出你的做法。`,
    truth: '不能靠"在某个分支前加豁免"：豁免只挡住了分支，而初始化末尾仍有无条件的状态字段赋值，且保存动作（save）散落在多处——诊断路径只要有一处触发保存，就会把被改写的内存状态落盘（实测：把活跃链条的归属写成了默认链条 id，进而导致下次运行误判换链条并重复派发已完成项）。判据应是"诊断模式下内存状态对象是否被改动"，而不是"是否走了某个分支"；做法上要么让诊断模式完全不进入状态初始化，要么把状态改动收敛到单一出口并断言未触发。',
    tokens: [
      ['所有保存', '全部保存', '每处保存', '保存路径', 'save', '落盘', '统一出口', '单一出口', '收敛', '冻结', '只读快照', '不进入'],
      ['分支', '豁免', '不够', '遗漏', '无条件', '内存状态', '状态对象', '未改动', '断言'],
    ],
  },
  {
    id: 3, genericity: 'mid',
    title: '把代码交付到运行时副本',
    situation: `插件在仓库中开发，但运行时加载的是另一份安装目录下的副本（由配置文件按包名挂载）。
现有一个交付脚本：它遍历包内文件清单，**只补齐目标端缺失的文件**；对已存在但内容不同的文件只报告、不覆盖。
现在要保证"改动能真的生效"。请给出你的设计。`,
    truth: '必须覆盖式交付：只补缺失会让"被修改的既有文件"永远是旧的，表现为"看起来同步了其实没生效"；正确做法是逐文件哈希比对并覆盖，覆盖前备份旧文件，写后回读校验，且交付后需重启宿主才对运行时生效。',
    tokens: [
      ['覆盖', 'overwrite', '强制同步', '哈希', '比对', '逐文件'],
      ['备份', '回读', '校验', '可回滚', '重启'],
    ],
  },
  {
    id: 4, genericity: 'generic',
    title: '任务粒度安排',
    situation: `要完成一个改动：涉及 5 个文件（含新增模块、接线到主入口、补测试、更新文档），并要求给出性能实测数字。
执行体是外部编码代理，单次执行有硬性时长上限，且与其额度配额共享。
现在要安排任务粒度。请给出你的做法。`,
    truth: '拆分为多个可独立验收的任务（纯逻辑层 / 接线 / 文档与实测），因为单次执行有硬超时与配额约束；实测：打包版在 490 秒处因配额耗尽中断、只产出半成品且无测试，而拆分后的两项分别在 6.7 与 8.0 分钟内完成并通过独立验收。',
    tokens: [
      ['拆分', '分解', '分期', '多任务', '子任务', '分步'],
      ['超时', '预算', '配额', '900', '时长', '上限'],
    ],
  },
];

const OUTPUT_FORMAT = `【必须输出机器可读块】报告 out/report.md 中必须包含如下块（严格格式，逐案例、顺序与编号一致）：

GEN-RESULT-BEGIN
CASE 1:
ALTERNATIVE: <一句话：你最终推荐的做法>
RISK: <一句话：在你所推荐的做法下，最可能失效的地方>
CASE 2:
ALTERNATIVE: ...
RISK: ...
CASE 3:
ALTERNATIVE: ...
RISK: ...
CASE 4:
ALTERNATIVE: ...
RISK: ...
GEN-RESULT-END

块之后，每个案例另附 3-6 行说明：你为什么这样设计、考虑过哪些替代、为什么排除它们。`;

const COMMON = `你是 dsh-web-relay 项目组的资深架构师。下面给出 4 个**设计情境**（均为真实工程场景，但只给出决策前的上下文）。
请对每个情境**独立**给出你的设计建议。

仓库根：/mnt/d/dsh-web-relay（只读；你可以读它来了解现状，但**不得修改任何文件**）

【约束】
- **不得修改仓库任何文件**；只允许读取与检索。
- 产物写你自己的工作目录 out/report.md。
- **完成后必须写入完成标记 done.flag**（路径见任务契约）——只写产物不写标记会被判为失败。
- 不要猜测本任务的目的或情境的来源。

${OUTPUT_FORMAT}`;

const PROTOCOL_S = `【工作方式（S 组）】
按你作为资深架构师的常规判断，对每个情境给出你认为最合适的做法，并说明关键取舍。`;

const PROTOCOL_D = `【工作方式（D 组）】对每个情境，严格执行以下多角色流程，并把最终结论写入机器可读块：
1) **架构师**：先给出你直觉上最合适的设计。
2) **反证架构师**：切换视角，**专门寻找该设计在本系统特定机制下会失效的地方**——
   重点问：状态是何时、被谁、以什么条件写盘的？哪些分支之外仍有遗留的副作用？
   继承/复用旧状态会带来什么？只在某个入口加判断够不够？请具体到"哪一行还会执行"。
3) **择优**：若反证成立，提出至少一个**替代设计**，并明确说明它比原方案稳在哪里；
   若反证不成立，说明为什么原方案足够稳。
4) 写入 ALTERNATIVE 的必须是**经过第 2、3 步之后的最终推荐**，不是第 1 步的直觉方案。`;

function buildPrompt(protocol) {
  const body = CASES.map((c) => `【情境 ${c.id}】${c.title}\n${c.situation}`).join('\n\n');
  return `${COMMON}

${protocol}

================ 情境（共 4 个） ================

${body}

================ 情境结束 ================`;
}

function buildSpec(arm, protocol) {
  const taskId = `ccgen-20260916-prop-${arm.toLowerCase()}`;
  return `// 生成类实验（${arm} 组）：由 gen-genexp-specs.mjs 生成，请勿手改。
// 唯一变量 = 工作方式段落；情境、输出格式、约束与另一组逐字节相同。
export const task = {
  taskId: '${taskId}',
  kind: 'understand',
  title: '生成类实验 ${arm} 组：4 个设计情境的方案建议（机器可读结论块）',
  refs: ['lib/index.js', 'bin/watchdog.mjs'],
  anchors: [
    { file: 'lib/cc-stats.mjs', pattern: 'export function summarizeChainTasks', note: '仓库存在的符号之一（供你了解现状）' },
  ],
  acceptance:
    'out/report.md 必须包含严格格式的 GEN-RESULT 块，对情境 1..4 各给 ALTERNATIVE 与 RISK 各一行；'
    + '块之后每情境另附 3-6 行说明；必须在任务契约约定处写入 done.flag；'
    + '**不得修改仓库任何文件**（本任务写入范围为空）。',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  writeScope: [],
  prompt: \`${buildPrompt(protocol)}\`,
};
`;
}

fs.writeFileSync('D:\\\\dsh relay test\\\\cc-specs\\\\genexp-s.mjs', buildSpec('S', PROTOCOL_S), 'utf8');
fs.writeFileSync('D:\\\\dsh relay test\\\\cc-specs\\\\genexp-d.mjs', buildSpec('D', PROTOCOL_D), 'utf8');

const labels = {
  generatedAt: new Date().toISOString(),
  kind: 'generative（能否想出更优替代方案）',
  hypothesis: 'H1: 多角色反证协议在 repo-specific 子集上提出历史验证替代方案的条数多于单方提议；H0: 无差异',
  primaryMetric: 'specific 子集（案例 1、2）命中数（0-2）',
  secondaryMetrics: ['全 4 例命中数', '无关/误解建议数（定性）', '耗时'],
  decisionRule: 'D 更优 ⇔ specific 命中 D > S；相等即判「该层面协议无收益」',
  confoundControl: '通用建议（案例 4）会被训练知识答对，故主指标**只在 specific 子集**上计算；mid（案例 3）单独列出',
  matchingRule: '每例给出若干「概念组」，某组的任一 token 出现在该例 ALTERNATIVE+RISK 文本中即记该组命中；全部组命中才算该例 hit。token 匹配粗糙，故同时保留原文供人工阅读。',
  cases: CASES.map((c) => ({ id: c.id, title: c.title, genericity: c.genericity, truth: c.truth, tokens: c.tokens })),
};
fs.writeFileSync('D:\\\\cc-tasks\\\\genexp-labels.json', JSON.stringify(labels, null, 2), 'utf8');

const spec = CASES.filter((c) => c.genericity === 'specific').length;
console.log(`  已生成 genexp-s.mjs / genexp-d.mjs（情境 ${CASES.length}：specific ${spec} + mid ${CASES.filter((c) => c.genericity === 'mid').length} + generic ${CASES.filter((c) => c.genericity === 'generic').length}）`);
console.log('  ground truth → D:\\cc-tasks\\genexp-labels.json（不交给 cc）');

// ---- 追加：生成 N 份 S 组复本 + 对应链条（用于两臂**分布**比较）----
// 动机：D 组因重派循环意外得到 26 次独立运行，而 S 组只有 1 次 → 两臂不可比（n=1 的伪影，
// 详见 _EXPERIMENTS-2026-09-16.md §9.1）。故把 S 也跑到同轮数。
// 不变量：复本的 **prompt 与 S 组逐字节相同**（唯一差别是 taskId 与标题等元数据，不进 cc）。
const REPLICA_N = Number(process.argv[2] || 0);
if (REPLICA_N > 0) {
  const promptS = buildPrompt(PROTOCOL_S);
  const SPEC_DIR = 'D:\\dsh relay test\\cc-specs';
  const items = [];
  for (let i = 1; i <= REPLICA_N; i++) {
    const tag = String(i).padStart(2, '0');
    const taskId = `ccgen-20260916-prop-s-r${tag}`;
    const body = `// S 组复本 r${tag}（由 gen-genexp-specs.mjs 生成，请勿手改）：**prompt 与 S 组逐字节相同**，仅 taskId 不同。
export const task = {
  taskId: '${taskId}',
  kind: 'understand',
  title: '生成类实验 S 组复本 r${tag}（机器可读结论块）',
  refs: ['lib/index.js', 'bin/watchdog.mjs'],
  anchors: [
    { file: 'lib/cc-stats.mjs', pattern: 'export function summarizeChainTasks', note: '仓库存在的符号之一' },
  ],
  acceptance: '同 S 组：out/report.md 含严格格式 GEN-RESULT 块（情境 1..4 各 ALTERNATIVE/RISK 一行）；必须写 done.flag；不得修改仓库任何文件（写入范围为空）。',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  writeScope: [],
  prompt: \`${promptS}\`,
};
`;
    fs.writeFileSync(`${SPEC_DIR}\\genexp-s-r${tag}.mjs`, body, 'utf8');
    items.push(`    { label: 'S 复本 r${tag}', spec: 'cc-specs/genexp-s-r${tag}.mjs', taskId: '${taskId}' },`);
  }
  const chain = `// v6-gen-s26 链条（由 gen-genexp-specs.mjs 生成）：S 组 ${REPLICA_N} 次独立重复，用于与 D 组分布比较。
// 每项均为只读 understand 任务（不传 --close-after-accept）；复本 prompt 与 S 组逐字节相同。
export const chain = {
  id: 'v6-gen-s${REPLICA_N}',
  items: [
${items.join('\n')}
  ],
};
`;
  fs.writeFileSync('D:\\dsh relay test\\cc-chains\\v6-gen-s26.mjs', chain, 'utf8');
  console.log(`  已生成 ${REPLICA_N} 份 S 组复本 + 链条 cc-chains/v6-gen-s26.mjs`);
}
