// 跟进（v11）：把命令形态的**平台分派抽成纯函数**，并让 Windows 侧明确拒绝而不是抛裸 ENOENT。
//
// 背景（v10 实测，主 agent 已取证）：
//   · v10 的实现质量很高：脚本 token 形态、三类结局（ok/fail/instrument + 标记）、env 注入、候选路径列表全部到位，
//     外部验收探针在修好的仓库上 **8/8 PASS**。
//   · 但命令形态硬编码 `command = "/bin/sh"`，于是：
//     ① 全量测试里有 1 条用例（"真实 shell exit 127 → instrument"）**只在 POSIX 成立**，在 Windows 上失败；
//     ② Windows 上任何命令形态都得到 "[acceptance-script][INSTRUMENT] 命令不存在（ENOENT）: spawnSync /bin/sh ENOENT"
//        —— 语义地雷：读起来像"命令有问题"，实际是"这条路径在本平台根本不受支持"。
//   · 我不放宽"全量 0 失败"的门禁去迁就环境，而是要求把这个判断**变成可确定性测试的纯函数**：
//     把平台分派抽出、用注入的 platform 覆盖两个平台，两个平台的行为都必须被测到。
export const task = {
  taskId: 'ccfix-20260918-acceptcall-b',
  kind: 'implement',
  title: 'acceptanceScript 命令形态：平台分派抽成纯函数 + win32 明确拒绝（不再是裸 /bin/sh ENOENT）',
  refs: ['lib/task-schema-v2.mjs', 'scripts/task-schema-cli.mjs', 'test/task-schema-v2.test.mjs'],
  acceptanceScript: 'probes/acceptance-invocation-accept.mjs',
  anchors: [
    { file: 'lib/task-schema-v2.mjs', pattern: 'function classifyExecResult', note: '三类结局分类器（v10 已实现，保持不动）' },
    { file: 'lib/task-schema-v2.mjs', pattern: 'command = "/bin/sh"', note: '命令形态硬编码 /bin/sh 的位置——本次要改为平台分派' },
    { file: 'lib/task-schema-v2.mjs', pattern: 'export function runAcceptanceScript', note: '命令形态的入口：改为调用新的纯函数取 invocation' },
    { file: 'test/task-schema-v2.test.mjs', pattern: 'exit 127', note: '只在 POSIX 成立的那条用例（需按平台守卫）' },
  ],
  acceptance:
    '**工作树里已有 v10 的实现（未提交），一律在其基础上做最小改动，不得回退或重写既有行为。**'
    + '① 把"命令形态该用什么 shell"抽成一个**纯函数**（例如 buildInvocation({script, platform, ...}) → {command, args}），'
    + 'platform 为**注入参数**（默认 process.platform），使两个平台的行为都能被单元测试确定性地覆盖；'
    + '② POSIX 行为不变：command="/bin/sh"，args=["-c", script]；'
    + '③ **win32：命令形态必须明确拒绝**——返回 {ok:false, kind:"instrument"}，错误信息含 '
    + '`[acceptance-script][INSTRUMENT]` 且明确说明"命令形态在 win32 不受支持 / 请改用脚本 token 形态"，'
    + '**不得**去 spawn /bin/sh（也就不会再有裸 "spawnSync /bin/sh ENOENT"）；'
    + '④ 脚本 token 形态与三类结局分类保持 v10 行为不变，且脚本 token 形态在两个平台都必须可用；'
    + '⑤ 那条"真实 shell exit 127"的既有用例若只在 POSIX 成立，请按平台守卫（win32 下显式 skip 并打印原因），'
    + '并**新增**用注入 platform 覆盖两平台的用例（win32 命令形态 → instrument + 明确信息；posix → /bin/sh -c 形状）；'
    + '⑥ node --check 通过；排除 test/shadow-gate.test.js 后全量 0 失败（含 Windows 与 WSL 两个平台）；'
    + 'verify-files-coverage 通过；改动文件 LF/无 BOM；仅改 lib/task-schema-v2.mjs、scripts/task-schema-cli.mjs、test/task-schema-v2.test.mjs',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。这是对上一轮工作的**最小跟进修复**。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）
**注意：工作树里已经有上一轮的实现（未提交，git status 会显示 lib/task-schema-v2.mjs、scripts/task-schema-cli.mjs、
test/task-schema-v2.test.mjs 三个文件为 modified）。请在其基础上做最小改动，绝对不要回退或重写既有行为。**

【上一轮已经做对的事（保持不动）】
- acceptanceScript 的**脚本 token 形态**（单 token、以 .mjs/.cjs/.js 结尾）→ 用 node 执行，taskId 作第一个参数，
  相对路径按 仓库根 → 任务目录 解析，找不到时错误里列出全部候选绝对路径；
- **三类结局**：exit 0 → ok；exit 1..126 → fail；ENOENT/127/超时/无法启动 → instrument，
  错误文本带 [acceptance-script][FAIL] 或 [acceptance-script][INSTRUMENT] 标记，返回值带 kind；
- 两种形态都注入 DSH_TASK_ID / DSH_TASK_DIR / DSH_REPO。
外部验收探针（probes/acceptance-invocation-accept.mjs，已在仓库内）对以上部分实测 **8/8 PASS**。

【本次要修的（实测证据）】
1) 命令形态的 shell 是**硬编码** /bin/sh（搜索 'command = "/bin/sh"' 即可定位）。后果有两个：
   a. 全量测试里有一条用例「命令形态命令不存在（真实 shell exit 127）→ kind instrument」**只在 POSIX 成立**，
      在 Windows 上会失败（这正是上一轮被独立验收判 REJECT 的唯一原因）。
   b. 在 Windows 上，任何命令形态都会得到
      "[acceptance-script][INSTRUMENT] 命令不存在（ENOENT）: spawnSync /bin/sh ENOENT"
      —— 语义地雷：读起来像"命令有问题"，实际是"这条路径在本平台根本不受支持"。

【硬性要求】
① **把平台分派抽成纯函数**，platform 作为**注入参数**（默认 process.platform），签名自定，例如：
   buildInvocation({ script, platform }) → { command, args }
   这样两个平台的行为都能被单元测试**确定性**覆盖（不需要真的跑在 Windows 上）。
② POSIX 不变：command = "/bin/sh"，args = ["-c", script]。
③ **win32：命令形态明确拒绝**：runAcceptanceScript 返回 { ok:false, kind:"instrument" }，
   错误信息含 \`[acceptance-script][INSTRUMENT]\`，且**必须明确说明**"命令形态在 win32 不受支持"以及
   "请改用脚本 token 形态"。**不得**去 spawn /bin/sh（因此不会再出现裸 ENOENT 信息）。
   理由：生产路径是 POSIX（WSL runner），win32 上假装能用只会制造误判；明确拒绝才是可审计的行为。
④ 脚本 token 形态与三类结局分类**保持 v10 行为不变**；脚本 token 形态在两个平台都必须可用。
⑤ 测试：
   - 既有那条 exit 127 用例若只在 POSIX 成立，请**按平台守卫**（win32 下显式 skip 并打印原因），不要删掉它；
   - **新增**用注入 platform 覆盖两平台的用例：win32 命令形态 → instrument 且信息含"不受支持/脚本 token"；
     posix 命令形态 → invocation 为 { command: "/bin/sh", args: ["-c", script] }；
   - 断言不得依赖真实平台（除那条被守卫的 127 用例）。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/task-schema-v2.mjs
- /mnt/d/dsh-web-relay/scripts/task-schema-cli.mjs
- /mnt/d/dsh-web-relay/test/task-schema-v2.test.mjs（已存在，扩充）
其它文件一律不得改动（含 package.json、.gitignore、probes/ —— probes/ 是主 agent 的验收仪器目录，已在 .gitignore 中）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 全部改动文件通过；
② 新增/修改的用例清单 + 每条断言什么；
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单）。
   注意：该文件在 WSL 下有 3 项已知环境差异，**不要**去"修"它，直接排除并如实说明；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：纯函数签名与实现、两个平台各自的 invocation 形状、win32 拒绝路径的代码行、
   被守卫用例的守卫写法、未做项与残余风险。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
