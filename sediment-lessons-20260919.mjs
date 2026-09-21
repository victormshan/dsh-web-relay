// 沉淀 2026-09-16..09-19 的语境能力（11 条 lesson）到 docs/main-agent-lessons.json。
// 幂等：按 id 去重（重复运行不会写两次）。
import fs from 'node:fs';

const FILE = 'D:\\dsh-web-relay\\docs\\main-agent-lessons.json';
const now = new Date().toISOString();
const L = (n) => `L-2026-0919-${String(n).padStart(3, '0')}`;

const entries = [
  {
    id: L(73),
    title: '判定「回归」必须在所有生产平台上复现——单平台失败不算回归（权威 = 交集）',
    category: 'judgment-heuristic',
    layer: 'L1',
    trigger: '验收/回归跑在一个平台，而被测代码的生产消费者在另一个平台（本项目：lib/task-schema-v2.mjs 由 WSL runner 使用，插件本体跑 Windows）；或某测试在 A 平台红、B 平台绿时',
    decision: '① 不要选单一平台当权威（选哪个都会误判一类）：判据取**交集**——同一用例在**两个平台都失败**才算真回归；单平台失败如实列出、标注平台差异、不阻断；② 交叉复核**按需触发**（只在首个平台有失败时才跑第二个平台），否则每次验收都多跑一遍全量，会把周期性审计拖到超时（实测）；③ 生产侧必须能跑通声明的验收探针——探针里禁止硬编码单平台路径。',
    rationale: '混合架构里「生产环境」不是一个而是多个：同一仓库里不同文件的消费者不同。用单一平台当权威，既会把另一平台的环境差异误判成缺陷（实测连 REJECT 两轮完全正确的实现），又会掩盖真正的跨平台回归。交集规则同时满足「不漏真回归」与「不误杀环境差异」。',
    evidence: '2026-09-18 ccfix-20260918-acceptcall / -b：命令形态的 POSIX 用例在 Windows 红、WSL 绿；初版 Windows-only 门禁连判两轮 REJECT（烧掉两轮 cc 配额），改交集规则后同一次交付判 ACCEPT 8/8；按需触发交叉复核把四层审计从 >120s 超时降回 47s。',
    confidence: 'high', status: 'proposed', suggested: 'proposed', confirmedBy: null, recordedAt: now,
    crossRef: [L(75)],
  },
  {
    id: L(74),
    title: '「字段已实现且单测全绿」≠「真实路径可用」——上线前必须有至少一次真实使用者走过的证据',
    category: 'tooling-trap',
    layer: 'L1',
    trigger: '新增/启用一个此前**没有真实使用者**的字段或钩子（本项目：task.json 的 acceptanceScript，schema/CLI/单测全都有、真实任务 0 使用者）；或某能力只有注入假依赖的单元测试覆盖时',
    decision: '① 对「从未被真实任务用过」的字段，默认按**未验证**对待；② 上线前造一个最小真实使用者跑通（本次是 ⑤b 任务首次声明 acceptanceScript，才发现执行语义是坏的）；③ 单测若全部注入假 exec/假 fs，必须同时有一条使用**真依赖**的用例，否则红绿都不代表可用。',
    rationale: '单元测试的注入点会系统性地绕开真实执行路径：被测逻辑全绿，而它真实调用外部命令/文件系统的那一层从未运行。这类缺陷第一次真用必然暴露，且往往被误读成「产物不合格」。',
    evidence: '2026-09-18 实测：全 D:\\cc-tasks\\tasks 只有 1 个任务声明过 acceptanceScript；其 defaultExec 把值当 shell 命令跑 → 首次真用即 /bin/sh: probes/x.mjs: not found，把一份独立验收 8/8 的合格产物判成 v2-validate-failed（v10/v11/v12 三次自报 failed 同源）。',
    confidence: 'high', status: 'proposed', suggested: 'proposed', confirmedBy: null, recordedAt: now,
  },
  {
    id: L(75),
    title: '负控（变异）必须自证「真的改坏了」；目标被跳过/不存在 = 空转，看起来与「通过」完全一样',
    category: 'tooling-trap',
    layer: 'L1',
    trigger: '写/审一个门禁的负控（把目标改坏、要求门禁报失败）时；或用「强制某层失败」来证明失败可见性时',
    decision: '① 变异后断言**内容确实改变**，否则单列 FAIL（「门禁没报失败」只说明负控是空的）；② 强制失败的目标必须选**永不被跳过**的对象；③ 工具自身要在「负控空转」时判工具错误并说明，而不是给一个看似通过的结论。',
    rationale: '负控的价值全在「它真的制造了坏输入」。一旦变异是空操作、或目标因环境被跳过，负控就退化成永真检查，而它的输出与「门禁正确报失败」一模一样——这类静默退化只能靠让负控自证来根除。',
    evidence: '2026-09-18 两次：① meta-gate 拿一份无 anchors 的老规格去改锚点 → apply() 空操作 → 误判「门禁有病」（加「变异必须改变内容」断言后修复）；② 隐藏启动器的失败可见性负控得到 exit 0，真因是所指定的层当时正被跳过（链条在飞）→ audit-all 增加「负控目标被跳过 → exit 3 并说明空转」。',
    confidence: 'high', status: 'proposed', suggested: 'proposed', confirmedBy: null, recordedAt: now,
    crossRef: [L(73)],
  },
  {
    id: L(76),
    title: '跨进程只传结构化数据（JSON），不要位置化的文本拼接——空字段会让后续字段错位',
    category: 'tooling-trap',
    layer: 'L1',
    trigger: '父进程要读子进程产出的多个字段（本项目：读 /health-check 的 loadedSha 与 loadedLibHash）时',
    decision: '子进程 console.log(JSON.stringify({...}))，父进程 JSON.parse；禁止 a + 空格 + b 再按空白切分——空值加 trim() 会把第二个字段顶到第一位。',
    rationale: '位置化的文本协议把「字段缺失」编码成「字段位移」，错误表现为数据错配而不是缺字段，因此不会报错，只会给出一个看似正常的**错误结论**（仪器说谎）。',
    evidence: '2026-09-18：⑤ 交付接地把 loadedLibHash 误读成 loadedSha → 报「loadedSha 与 HEAD 不一致」的假失败，恰好掩盖了真实结论（宿主是否加载新代码）；改 JSON 传递后立刻给出正确判定并升级为「精确」。',
    confidence: 'high', status: 'proposed', suggested: 'proposed', confirmedBy: null, recordedAt: now,
  },
  {
    id: L(77),
    title: '单槽告警/信号文件会静默丢告警——用「主槽 + 队列 + 销账自动提升」',
    category: 'engineering-action',
    layer: 'L1',
    trigger: '设计一个「需要人/主 agent 介入」的落盘通道（信号文件），且可能有多个来源同时告警时',
    decision: '① 主槽只放一条；别的来源在**未销账**时**入队**而非覆盖；② 人销账主槽时自动提升队首（并给新代数 → 新 id，使消费者会为新告警再次唤醒）；③ 来源自愈时只自动销账**同源**条目。',
    rationale: '单槽文件的下一次写入就是一次无声删除。告警通道丢失告警而无人察觉，比没有该通道更危险——它同时破坏了「检测」与「对检测的信任」。',
    evidence: '2026-09-18：信号模块自检的 [POS] 用例抓到「另一来源写入会顶掉尚未销账的告警」（链条护栏告警被审计告警覆盖 → 前者凭空消失）；改主槽+队列并覆盖 9 条去重/复发/提升用例后 26/26 通过。',
    confidence: 'high', status: 'proposed', suggested: 'proposed', confirmedBy: null, recordedAt: now,
    crossRef: [L(78)],
  },
  {
    id: L(78),
    title: '无人值守下「检测」不等于「升级」：失败必须接到唤醒通路，并按同源只叫一次防告警疲劳',
    category: 'engineering-action',
    layer: 'L1',
    trigger: '部署周期性检查/审计（本项目四层审计每 30 分钟）时；或某告警只写日志与退出码、没有任何人被通知时',
    decision: '① 告警要显式接到消费端（信号文件 → 插件 boot/心跳 → 唤醒主 agent）；② 同源失败用**稳定键**去重，只叫一次；人销账后复发才再叫；③ 来源自愈自动销账，免留一条早已恢复的告警；④ 退出码语义不得因「多做一步写信号」而改变。',
    rationale: '写进日志的告警只对「已经在看的人」有效，而无人值守场景的前提恰恰是没人在看。同时，周期性失败若每次都唤醒，会在几小时内制造告警疲劳，使通道失效——所以「只叫一次 + 销账后复发可再叫」是必要语义。',
    evidence: '2026-09-18 实测：四层审计连续 9 次 ACTION-NEEDED：⑤ 交付接地（宿主未加载仓库代码），只写进 audit.log 与计划任务 Last Result，**无人被叫醒**（4 小时无人值守）；同期链条侧同类信号已能把主 agent 叫醒（当日实证）。补齐后通路真跑验证：真审计强制失败 → 退出码仍 1、写下 audit-action-needed、连续第二次不重写。',
    confidence: 'high', status: 'proposed', suggested: 'proposed', confirmedBy: null, recordedAt: now,
    crossRef: [L(77), L(79)],
  },
  {
    id: L(79),
    title: '唤醒/告警的证据必须事后仍可取：可观测记录不得被后续「去重评估」覆盖',
    category: 'judgment-heuristic',
    layer: 'L1',
    trigger: '设计唤醒/去重逻辑时；或需要事后证明「某次唤醒真的发生过」时',
    decision: '记录里保留**最近一次决定性评估**（如 lastNotifiedAt / sessionIdSource），去重评估只更新「已通知集合」，不要重写那条决定性记录；否则事后只剩源码可查。',
    rationale: '「记录说没有」与「确实没发生」在事后无法区分。证据被自己的去重逻辑抹掉，等于该能力不可审计，也就不可信——这与「诊断说谎比不诊断更糟」同源。',
    evidence: '2026-09-18：boot 扫描依信号唤醒主 agent 成功（交接消息确已到达），但 /health-check 的 pendingHuman 被后续 decision:none 的去重评估重写 → sessionIdSource 回落 none、notifiedAt 为 null，成功唤醒的痕迹消失，只能靠读代码 + duplicateSuppressed 反推。',
    confidence: 'high', status: 'proposed', suggested: 'proposed', confirmedBy: null, recordedAt: now,
  },
  {
    id: L(80),
    title: '规格写窄也是根因：只写「取 env」而实现已有回退 → 能力在真实宿主上永久空转',
    category: 'judgment-heuristic',
    layer: 'L1',
    trigger: '给执行体写实现规格（尤其涉及配置来源、回退策略、默认值）时；或某能力「代码在、日志也在、但从不生效」时',
    decision: '① 写规格前先搜仓库里是否已有该能力的回退/兜底实现，有则点名要求复用；② 交付后核对「能力是否真会被触发」，而不只看代码存在；③ 把「长期只记录不生效」的既有日志当作能力空转的现成证据。',
    rationale: '规格是执行体的唯一输入：规格里少写一个回退来源，实现就永久只走那条窄路径，而代码审查看起来完全正确。既有日志里早已写着「仅记录留痕」这类空转证据，只是没人把它当成缺陷信号。',
    evidence: '2026-09-18：宿主启动器未注入 DSH_SESSION_ID，而插件心跳日志长期打印「有待办但无 sessionId（expr 未落盘且宿主 env 无 DSH_SESSION_ID），仅记录留痕」；我给的规格只写「sessionId 取 process.env.DSH_SESSION_ID」，忽略了仓库既有的 mostRecentExprSessionId() 回退 → v12 唤醒通路在真机永远空转；v13 补回退后才通（当日实证唤醒成功）。',
    confidence: 'high', status: 'proposed', suggested: 'proposed', confirmedBy: null, recordedAt: now,
  },
  {
    id: L(81),
    title: '让计划任务「不弹窗」时必须保证退出码仍可见——隐藏失败是最坏的回归',
    category: 'engineering-action',
    layer: 'L1',
    trigger: '把计划任务/定时入口改为隐藏窗口运行时；或用户抱怨定时任务弹出 cmd 窗口时',
    decision: '① 用 VBS 启动器：WScript.Quit sh.Run("cmd /c ""<入口>""", 0, True) —— 窗口样式 0（隐藏）+ 等待完成 + **透传退出码**（既有 watchdog 启动器丢弃退出码，但它不依赖；入口的 Last Result 是失败可见性的唯一出口）；② 门禁钉死这三条并负控「丢掉 WScript.Quit」「样式改 1」「不等完成」；③ 用最小夹具真跑（exit 7 → 7）验证，而不是只读文本。',
    rationale: '「消除弹窗」与「保留失败可见性」在实现上是两个独立性质，很容易在改启动方式时丢掉后者；一旦丢掉，所有失败都会静默，且因为窗口不再弹，连「它跑过」都不再可见。',
    evidence: '2026-09-18：4 个计划任务全部改走 _hidden-run-*.vbs；门禁 19/19（含四类变异负控 + 启动器目录扫描与数量下限），功能夹具 3/3（exit 0→0、exit 7→7）；真实审计入口实测 exit 0、audit.log 按期追加。',
    confidence: 'high', status: 'proposed', suggested: 'proposed', confirmedBy: null, recordedAt: now,
  },
  {
    id: L(82),
    title: '竞态：只在启动时判「环境是否就绪」不够——运行中途状态变化必须作废整轮',
    category: 'tooling-trap',
    layer: 'L1',
    trigger: '长任务（审计/回归）与周期性任务（每 20 分钟取锁）共享状态时',
    decision: '① 逐项/逐层复查共享状态，途中发生变化 → 作废整轮（exit 3）并说明「本轮结论无意义」，不给半真半假的判定；② 区分「瞬时取锁」（<1 分钟自行释放 → 等一小会儿继续）与「真在干活」（锁已存在较久 → 立即作废），否则会被调度器的空转锁频繁打断。',
    rationale: '跨状态转变采集到的数据来自两个不同的世界，拼接成的结论既不能证真也不能证伪，而它看起来完全正常——这正是最容易被采信的一类错误结论。',
    evidence: '2026-09-18：回归套件在链条取锁瞬间跑出 19/26 的**混合判定**（前半段真跑、后半段「本次跳过」被读成失败）；随后又因调度器每 20 分钟的瞬时锁被整轮作废两次；改为持续性判别 + 中途复查后 29/29 通过。',
    confidence: 'high', status: 'proposed', suggested: 'proposed', confirmedBy: null, recordedAt: now,
  },
  {
    id: L(83),
    title: '门禁必须校验「该文件真正该满足的性质」——套错契约会系统性误报；入口经包装后须改可传递校验',
    category: 'tooling-trap',
    layer: 'L1',
    trigger: '给新入口/新文件配门禁并想复用既有门禁时；或入口从「直接调用」改为「经包装器调用」时',
    decision: '① 先列出该文件真正该满足的性质再写门禁，契约不同的文件不得复用；② 入口改为经包装器调用后，「必须真的跑到目标脚本」要从字面匹配升级为**可传递**校验（提及的 .mjs 内容里含目标脚本），否则正确的接线会被判成「没在跑」；③ 覆盖范围用目录扫描 + 数量下限，防新增入口漏检或有人改回旧方式。',
    rationale: '门禁的误报与漏报同源：它校验的是「我以为的性质」。复用别的文件的契约、或用字面匹配代替实际依赖关系，都会让门禁在正确实现上报错、在错误实现上放过——两个方向都破坏门禁的可信度。',
    evidence: '2026-09-18：run-audit.cmd 套用链条器门禁 → 4 项假失败，改专属门禁后 19/19；入口改经 run-audit-signal.mjs 包装后，「必须真的跑到 audit-all」从字面匹配升级为可传递校验（含 3 条 [NEG]：提及不存在的 mjs / 提及不含 audit-all 的 mjs / 不提 mjs）。',
    confidence: 'high', status: 'proposed', suggested: 'proposed', confirmedBy: null, recordedAt: now,
  },
];

const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const existing = new Set((j.lessons || []).map((x) => x.id));
const added = entries.filter((e) => !existing.has(e.id));
j.lessons = [...(j.lessons || []), ...added];
fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n', 'utf8');
console.log(`已新增 ${added.length} 条（跳过已存在 ${entries.length - added.length} 条）→ 共 ${j.lessons.length} 条`);
console.log(added.map((e) => `${e.id} [${e.category}] ${e.title.slice(0, 46)}`).join('\n'));
