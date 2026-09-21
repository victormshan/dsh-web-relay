// 生成类实验 **第二轮（out-of-sample）** 生成器
//
// 为什么重做：第一轮的结论为 inconclusive，原因是 ① 仪器有系统性假阴性且偏差与处理相关（D 的协议要求引用证据
// → 答案更长更密，token 匹配器奖励词密度）；② 单裁判有地板/天花板效应。**不能拿第一轮数据调仪器**（事后拟合），
// 故换**新语料**并用**改进后的仪器**重做。
//
// 本轮语料全部取自本会话**后段**的真实事件（与第一轮不重叠），且都具备"反直觉 + 特定于本系统"的特征——
// 这正是第一轮案例 4（通用建议"大任务要拆"）暴露的混淆：通用建议靠训练知识就能答对。
//
// 仪器改进（在第一轮已证缺陷上针对性设计，且**在看到本轮任何结果之前固定**）：
//   ① 风格归一：剥离 markdown 记号、折叠空白、**统一截断到同一长度**后再评 → 掐掉"长度/词密度"通道；
//   ② **成对比较**取代绝对 0/1（成对判断远比绝对评分稳定，且直接给出两臂胜率）；
//   ③ **仪器自检（锚点）**：每例内附带一对"金标准答案 vs 敷衍答案"，要求裁判必须选中金标准；
//      锚点不通过 → 该例的仪器判定**作废**，而不是照用其结论；
//   ④ 多例、多对聚合出胜率与二项置信区间。
import fs from 'node:fs';

const CASES = [
  {
    id: 1, kind: 'insight', title: '失败重派策略',
    situation: `某自动化链条由计划任务每 20 分钟触发一次。某项失败后，实现会把该项标记为"可重跑"，依赖下一次触发自动重试；
每次执行会占用一份稀缺的共享额度。请给出你的失败重派设计。`,
    truth: '重试必须有次数上限/终止条件。仅把失败标为"可重跑"再靠周期触发自动重试，会让**持久性失败**（验收器自身缺陷、环境被污染等）无限重派、持续消耗额度（实测 25 次、约 87 分钟执行时间）而无人知晓。正确做法：为同一项累计重派计数，达上限即置为"等人工介入"并停止；且要区分"额度耗尽/等待"这类**非缺陷暂停**，不计入失败计数。',
    tokens: [['上限', '次数', '阈值', '终止', '最大重试', 'maxattempts', '熔断', '停止重试', '计数'],
             ['持久性', '无限', '循环', '反复', '持续', '耗尽', '累积']],
    negTokens: [],
  },
  {
    id: 2, kind: 'insight', title: '改动归属判定',
    situation: `一个验收器用 \`git status --porcelain\` 取出"本次任务改动的文件清单"，再与任务声明的写入范围核对。
请评估这个判定方式是否稳，并给出你的做法。`,
    truth: '不稳。`git status` 默认把**未跟踪目录聚合为目录项**（如 `?? bin/web-relay/`）；若后续把每个条目当文件处理（逐项 readFileSync）会抛 EISDIR 使验收器**崩溃**，而调用方只看到非零退出——于是"工具崩溃"被读成"判定不合格"，进而触发重试。正确做法：用 `-uall`（untracked-files=all）让未跟踪文件**逐个列出**；对条目做 isFile 防御；并让崩溃与业务判定使用**可区分的退出码**。',
    tokens: [['uall', 'untracked', '逐个', '展开', '目录', '聚合'],
             ['崩溃', '异常', '退出码', '区分', 'isfile', '文件类型', '非文件', '容错']],
    negTokens: [],
  },
  {
    id: 3, kind: 'insight', title: '运行数据的落盘位置',
    situation: `某组件把运行记录写到 \`<工作区>/web-relay/experiments/\`；而"工作区"由调用方传入，未传时回退到进程的 cwd。
仓库根目录的 \`.gitignore\` 里写着 \`web-relay/experiments/\`。请评估这样设计会出什么问题、并给出改法。`,
    truth: '当调用方未显式传工作区、而进程 cwd 恰在仓库子目录（如 `bin/`）时，会在仓库内生成 `bin/web-relay/experiments/`；而 `.gitignore` 里**含中间斜杠**的模式是**锚定在 .gitignore 所在目录**的，故根级规则**匹配不到**该子目录 → 仓库呈现"脏" → 任何以工作树做写入范围校验的工具都会把运行数据判成**越界改动** → 触发拒绝与重试（实测演变成 25 次重派）。正确做法：关键参数不得依赖 cwd 默认值（必须显式传入）；忽略规则用 `**/` 前缀覆盖任意层级。',
    tokens: [['workspacepath', '显式', '必须传', '参数', 'cwd', '默认值', '工作区'],
             ['锚定', '层级', '**/', '相对', 'gitignore', '子目录', '匹配']],
    negTokens: [],
  },
  {
    id: 4, kind: 'control', title: '避免重复派发（过度设计对照）',
    situation: `一条链条的若干项全部跑完后，计划任务仍会每 20 分钟触发一次，会把同一批项重新派发一遍。
请给出你的做法。`,
    // 对照：正确答案很简单；引入重型机制即为过度设计（对抗协议可能诱发"为复杂而复杂"）
    truth: '一个**幂等守卫**就够了：记录"全部完成"的标记（完成时刻 + 已完成项数 ≥ 总项数）后直接跳过并在日志里说明原因。**不需要**数据库、分布式锁、消息队列或外部状态机——本场景是单机单进程的定时任务，重型机制只会增加故障面。',
    tokens: [['幂等', '守卫', '已跑完', '跳过', '标记', 'completed']],
    negTokens: ['数据库', 'redis', '分布式锁', '消息队列', 'kafka', 'zookeeper', 'etcd'],
  },
  {
    id: 5, kind: 'control', title: '聚合持续增长的目录（过度设计对照）',
    situation: `要出一个统计：读某个持续增长的目录（已有数十个子目录，每个子目录一份小 JSON），聚合其中的结果。
请给出你的读取与聚合设计。`,
    truth: '**有界读取 + 容错**即可：按目录 mtime 只取最近 N 个、单条损坏跳过并计数、目录不可访问时 fail-open 返回空结果与原因。**不需要**引入数据库、索引服务或缓存中间件——总量是几十个小文件，重型存储只会增加依赖与故障面。',
    tokens: [['有界', '最近', 'limit', '上限', 'N 个', '数量上限'],
             ['跳过', 'fail-open', '不抛', '容错', '损坏', '失败容忍']],
    negTokens: ['数据库', 'elasticsearch', '索引服务', 'kafka', 'redis'],
  },
];

const OUTPUT_FORMAT = `【必须输出机器可读块】报告 out/report.md 中必须包含如下块（严格格式，逐案例、顺序与编号一致）：

GEN2-RESULT-BEGIN
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
CASE 5:
ALTERNATIVE: ...
RISK: ...
GEN2-RESULT-END

块之后，每例另附 3-6 行说明：为什么这样设计、考虑过哪些替代、为什么排除它们。`;

const COMMON = `你是 dsh-web-relay 项目组的资深架构师。下面给出 5 个**设计情境**（均为真实工程场景，但只给出决策前的上下文）。
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
   重点问：状态是何时、被谁、以什么条件写盘的？哪些分支之外仍有遗留的副作用？继承/复用旧状态会带来什么？
   只在某个入口加判断够不够？哪个"工具"或"默认值"会在此处咬人？请具体到"哪一行还会执行"。
3) **简约审查**：再切换一次视角，问"这个方案是否引入了本场景不需要的复杂度？"——
   若场景本身足够简单，更重的机制应被**明确排除**，而不是因为"看起来更工业级"就欣然采用。
   （本指令刻意**不列举具体技术名词**，请自行判断何为"过重"——列举会替你作答。）
4) **择优**：写出经过第 2、3 步之后的最终推荐；若反证不成立，说明为什么原方案足够稳。`;

function buildPrompt(protocol) {
  const body = CASES.map((c) => `【情境 ${c.id}】${c.title}\n${c.situation}`).join('\n\n');
  return `${COMMON}\n\n${protocol}\n\n================ 情境（共 ${CASES.length} 个） ================\n\n${body}\n\n================ 情境结束 ================`;
}

// 转义：语料正文里含反引号（如 `git status --porcelain`）与可能的 ${，若原样嵌入生成的模板字符串
// 会破坏语法（实测：SyntaxError: Unexpected identifier 'git'）。故嵌入前转义；**cc 收到的 prompt 内容不变**。
const escapeForTemplate = (s) => String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

function buildSpec({ arm, round, protocol }) {
  const taskId = `ccgen2-20260917-${arm.toLowerCase()}${String(round).padStart(2, '0')}`;
  return `// 生成类实验第二轮（${arm} 组第 ${round} 轮）：由 gen-genexp2-specs.mjs 生成，请勿手改。
// 同一组内各轮的 prompt **逐字节相同**，仅 taskId 不同。
export const task = {
  taskId: '${taskId}',
  kind: 'understand',
  title: '生成类实验二轮 ${arm}${String(round).padStart(2, '0')}（机器可读结论块）',
  refs: ['lib/index.js', 'bin/watchdog.mjs'],
  anchors: [
    { file: 'lib/cc-stats.mjs', pattern: 'export function summarizeChainTasks', note: '仓库存在的符号之一' },
  ],
  acceptance: 'out/report.md 含严格格式 GEN2-RESULT 块（情境 1..5 各 ALTERNATIVE/RISK 一行）；必须写 done.flag；不得修改仓库任何文件（写入范围为空）。',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  writeScope: [],
  prompt: \`${escapeForTemplate(buildPrompt(protocol))}\`,
};
`;
}

const N = Number(process.argv[2] || 8);   // 每臂轮数
const SPEC = 'D:\\dsh relay test\\cc-specs';
const promptS = buildPrompt(PROTOCOL_S);
const promptD = buildPrompt(PROTOCOL_D);

const items = [];
for (let r = 1; r <= N; r++) {
  fs.writeFileSync(`${SPEC}\\genexp2-s${String(r).padStart(2, '0')}.mjs`, buildSpec({ arm: 'S', round: r, protocol: PROTOCOL_S }), 'utf8');
  fs.writeFileSync(`${SPEC}\\genexp2-d${String(r).padStart(2, '0')}.mjs`, buildSpec({ arm: 'D', round: r, protocol: PROTOCOL_D }), 'utf8');
  // 交错排列（S,D,S,D…）：配额按窗口推进，交错可让两臂共享同一时间/额度压力，抵消漂移
  items.push(`    { label: 'S 第 ${r} 轮', spec: 'cc-specs/genexp2-s${String(r).padStart(2, '0')}.mjs', taskId: 'ccgen2-20260917-s${String(r).padStart(2, '0')}' },`);
  items.push(`    { label: 'D 第 ${r} 轮', spec: 'cc-specs/genexp2-d${String(r).padStart(2, '0')}.mjs', taskId: 'ccgen2-20260917-d${String(r).padStart(2, '0')}' },`);
}
fs.writeFileSync('D:\\dsh relay test\\cc-chains\\v7-gen2.mjs',
  `// v7-gen2 链条（由 gen-genexp2-specs.mjs 生成）：${N} 轮 × 2 臂 = ${items.length} 项，交错排列。
export const chain = {\n  id: 'v7-gen2',\n  items: [\n${items.join('\n')}\n  ],\n};\n`, 'utf8');

// ground truth（不下发给 cc）
fs.writeFileSync('D:\\cc-tasks\\genexp2-labels.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  round: 2, outOfSample: true,
  note: '新语料（与第一轮不重叠）；仪器改进与判定规则在**看到本轮任何结果之前**固定',
  hypothesis: 'H1: 多角色反证（含简约审查）在成对比较中的胜率 > 50%；H0: = 50%（无差异）',
  primaryMetric: '成对盲评胜率（风格归一后），按案例聚合并给二项置信区间',
  secondaryMetrics: ['风格归一后的 token 命中率（同一批输出）', '过度设计对照的净负面命中'],
  decisionRule: '仪器自检（锚点）全部通过后，才算该例有效；仅当合并胜率的 95% CI 下界 > 50% 才判 D 更优',
  styleControl: '评前统一归一：剥离 markdown 记号、折叠空白、**所有答案截断到同一长度**',
  cases: CASES.map((c) => ({ id: c.id, kind: c.kind, title: c.title, situation: c.situation, truth: c.truth, tokens: c.tokens, negTokens: c.negTokens })),
  arms: { S: promptS.length, D: promptD.length },
}, null, 2), 'utf8');

console.log(`  已生成 ${N} 轮 × 2 臂 = ${items.length} 份 spec + 链条 cc-chains/v7-gen2.mjs`);
console.log(`  prompt 长度: S=${promptS.length} 字符  D=${promptD.length} 字符（差异 = 协议段，符合设计）`);
console.log('  ground truth → D:\\cc-tasks\\genexp2-labels.json（不交给 cc）');
