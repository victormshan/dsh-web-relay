// 修复：acceptanceScript 的**执行语义**必须真的可用（裸脚本 token 要以 node 执行 + 三类结局必须可区分）。
//
// 背景（2026-09-18 实测，本会话最贵的一次通道缺陷，主 agent 已取证）：
//   · lib/task-schema-v2.mjs 的 defaultExec 把 acceptanceScript 当成 **shell 命令**：execFileSync('/bin/sh', ['-c', 值])。
//   · 主 agent 按"这是脚本路径"在规格里写 'probes/loaded-hash-accept.mjs'，于是 runner 去 exec 这个文件本身
//     → `/bin/sh: 1: probes/loaded-hash-accept.mjs: not found` → 任务被结算成 **v2-validate-failed**，
//       即：一份**已经通过独立验收（8/8、探针 9/9）**的合格产物，被自带验收器判成失败。
//   · 该字段（s2v2_3 实现）此前**从未被任何真实任务使用过**：单元测试全部注入假 exec，
//     所以"单测全绿、真实执行路径从未被触碰"——第一次真用就坏。
//   · 更糟的是**结局混同**：文件不存在 / 命令不存在（exit 127）与"探针跑完判定不合格(exit 1)"被压成同一个
//     {ok:false}，无法区分"工具坏了"与"产物不合格"。这正是 EISDIR→REJECT 触发 25 次重派循环那类事故的同款病灶。
//
// 外部验收探针：probes/acceptance-invocation-accept.mjs（走生产路径 WSL 调 task-schema-cli，自带两侧自检）。
// 该探针在修复前实测 4/8 FAIL（裸 token 不执行、not found、缺 INSTRUMENT 分类、命令不存在缺分类）。
export const task = {
  taskId: 'ccfix-20260918-acceptcall',
  kind: 'implement',
  title: 'acceptanceScript 执行语义修复：裸脚本 token 走 node + 三类结局（通过/业务不合格/工具错误）必须可区分',
  refs: ['lib/task-schema-v2.mjs', 'scripts/task-schema-cli.mjs', 'test/task-schema-v2.test.mjs'],
  acceptanceScript: 'probes/acceptance-invocation-accept.mjs',
  anchors: [
    { file: 'lib/task-schema-v2.mjs', pattern: 'function defaultExec', note: '当前实现：execFileSync(\'/bin/sh\', [\'-c\', script]) —— 裸脚本 token 因此被当命令执行' },
    { file: 'lib/task-schema-v2.mjs', pattern: 'export function runAcceptanceScript', note: '需要在此处区分三类结局（通过 / 业务不合格 / 工具错误）' },
    { file: 'scripts/task-schema-cli.mjs', pattern: 'acceptance = runAcceptanceScript(', note: '调用点：需把 taskId/taskDir 与仓库根传进去，供解析与注入环境' },
    { file: 'scripts/task-schema-cli.mjs', pattern: '[acceptance-script]', note: '错误前缀所在处：三类结局的标记在此拼出' },
  ],
  acceptance:
    'acceptanceScript 支持两种形态并保持既有语义：①**脚本 token**（单个 token 且以 .mjs/.cjs/.js 结尾，不含空白与 shell 元字符）'
    + '→ 用 node 执行，相对路径依次按 **仓库根 → 任务目录** 解析，并把 taskId 作为第一个参数传入；'
    + '②**命令形态**（其余情况）→ 仍按 shell 命令执行（POSIX 用 sh -c），不得回归。'
    + '两种形态都要向子进程导出 DSH_TASK_ID / DSH_TASK_DIR / DSH_REPO。'
    + '结局必须三分且**在错误文本里带可判别标记**：子进程退出 0 → ok:true；'
    + '子进程退出 1..126（探针确实跑完了并给出否定）→ `[acceptance-script][FAIL]`；'
    + '文件/命令不存在（ENOENT、127）或超时/无法启动 shell（工具错误）→ `[acceptance-script][INSTRUMENT]`。'
    + 'runAcceptanceScript 的返回值需带 `kind`（"ok" | "fail" | "instrument"）以便调用方判定。'
    + 'node --check 通过；新增用例 ≥5（两形态各一、相对路径解析顺序、三类结局各一）；'
    + '排除 test/shadow-gate.test.js 后全量 0 失败；verify-files-coverage 通过；改动文件 LF/无 BOM；'
    + '仅改 lib/task-schema-v2.mjs、scripts/task-schema-cli.mjs、test/task-schema-v2.test.mjs',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务修复一个**真实发生过的通道缺陷**：验收脚本的执行语义。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【事故经过（主 agent 已取证，务必先读代码确认）】
1) lib/task-schema-v2.mjs 的 defaultExec 目前是：
   execFileSync("/bin/sh", ["-c", script], { cwd, stdio: "pipe" })
   即把 acceptanceScript 的值**当成一整条 shell 命令**执行。
2) 上一个任务在 task.json 里按"这是脚本路径"填写：acceptanceScript = "probes/loaded-hash-accept.mjs"。
   于是 runner 执行 /bin/sh -c 'probes/loaded-hash-accept.mjs' → 该文件不是可执行文件、也不在 PATH 里
   → "/bin/sh: 1: probes/loaded-hash-accept.mjs: not found" → 任务被结算为 **v2-validate-failed**。
   而这份产物实际上**通过了独立验收**（另一套验收器以 node 执行同一探针：8/8 项、探针 9/9 判定 PASS）。
   也就是说：自带验收器把一份合格产物判成了失败。
3) 该字段此前从未被任何真实任务使用（单元测试全部注入假 exec），所以"单测全绿但真实路径从未被触碰"。

【硬性要求 1：两种形态都要支持】
- **脚本 token 形态**：值为单个 token（不含空白、不含 shell 元字符 ; & | < > ( ) $ \` " '），且以 .mjs / .cjs / .js 结尾
  → 必须用 **node** 执行该文件（process.execPath 或 "node"），并把 **taskId 作为第一个命令行参数**传入。
  相对路径解析顺序：① 仓库根（可由调用方传入，默认可用环境变量 DSH_REPO 或进程 cwd 的上级推断）② 任务目录（cwd）。
  两处都找不到 → 报**工具错误**（见要求 2），错误信息里要列出**尝试过的绝对路径**。
- **命令形态**：其余情况 → 保持现有 shell 语义（POSIX 用 /bin/sh -c，且 cwd 为任务目录），不得回归。
- 两种形态都必须向子进程注入环境变量：DSH_TASK_ID、DSH_TASK_DIR（任务目录绝对路径）、DSH_REPO（仓库根绝对路径）。

【硬性要求 2：三类结局必须可区分（本条是本次修复的核心价值）】
现在任何非 0 退出都被压成 {ok:false, error}，导致"工具坏了"与"产物不合格"无法区分（同类病灶曾引发 25 次无意义重派）。
请改为三分，并在错误文本里带**可判别标记**（外部验收脚本会按标记分类）：
- 退出码 0 → { ok: true, kind: "ok" }
- 退出码 1..126（探针确实运行完成并给出否定）→ { ok: false, kind: "fail", error: "[acceptance-script][FAIL] <摘要>" }
- 文件不存在 / 命令不存在（shell 返回 127、ENOENT）/ 超时 / 无法启动 shell → { ok: false, kind: "instrument", error: "[acceptance-script][INSTRUMENT] <摘要>" }
调用方 scripts/task-schema-cli.mjs 需相应地把错误前缀写成 [acceptance-script][FAIL] 或 [acceptance-script][INSTRUMENT]，
并在 JSON 输出里保留 kind（若该位置已有 errors 数组，追加进数组即可，但**前缀标记必须存在**）。
注意：**不得**为了让错误"更好看"而把 instrument 归成 fail，也不得反过来；这是本次要修的判断。

【硬性要求 3：可测性】
现有单元测试全部注入假 exec，因此**真实执行路径从未被覆盖**。请新增用例 ≥5，至少覆盖：
① 脚本 token 形态：真实执行一个临时 .mjs 探针，断言 exit 0 → ok:true，且探针能读到 taskId 参数与 DSH_TASK_ID；
② 命令形态不回归：exec 传入 shell 命令仍按命令执行；
③ 相对路径解析顺序：token 相对**任务目录**与相对**仓库根**都能找到（可用临时目录夹具）；
④ 三类结局各至少一条（ok / fail / instrument），并断言 kind 与错误文本标记；
⑤ token 指向不存在文件 → kind==="instrument" 且错误含 [INSTRUMENT]。
测试请用 node:test（与仓库既有风格一致）。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/task-schema-v2.mjs
- /mnt/d/dsh-web-relay/scripts/task-schema-cli.mjs
- /mnt/d/dsh-web-relay/test/task-schema-v2.test.mjs（已存在，扩充）
其它文件一律不得改动（含 package.json、lib/index.js、bin/watchdog.mjs）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 全部改动文件通过；
② 新增用例 ≥5 且既有用例不减；
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单，不要用目录式调用）。
   注意：WSL 下该文件有 3 项已知环境差异（Windows 侧同一 commit 全绿），**不要**试图"修"它，直接排除并如实说明；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：defaultExec 的改动前后代码、两类形态的分派逻辑（贴出判定 token 形态的那几行）、
   三类结局的映射表（退出码 → kind → 标记）、尝试路径列表的实现位置、用例清单、未做项与残余风险。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
