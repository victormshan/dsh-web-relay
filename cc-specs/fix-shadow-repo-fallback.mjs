// 修复：影子沙盒的 repoPath 解析必须**自持**（不依赖环境变量也能从模块自身位置解析出仓库根）。
//
// 背景（2026-09-19 实测，两轮都白跑，主 agent 已取证）：
//   · 长期空转：`resolveRepoPath(base)` 以**工作区**（D:\dsh relay test，不是 git 仓库）为基准 → null；
//     其回退与定时 GC 读 `DSH_RELAY_REPO_PATH`，而宿主启动器设的是 `DSH_RELAY_REPO`（名字不一致）→ 回退永不生效。
//     ⇒ 每个 high 步骤都判 "非 git 工作区：L2 降级"（当前计划 9 处记录），L2 worktree 隔离/原子合并/定时 GC 从未运行。
//   · 第一轮修复（启动器补 DSH_RELAY_REPO_PATH）**重启后仍不生效**：`request-restart` 重启的是**宿主**，
//     而宿主由常驻 watchdog 拉起，watchdog 继承的是它自己启动时的环境（实测 watchdog 进程起于 9/15，早于改动）。
//     ⇒ 教训：**不要把可用性押在环境变量上**；应让插件用自己已能算出的仓库根兜底（lib/ 上溯）。
//
// 外部验收探针：probes/shadow-repo-accept.mjs（仓库侧、双平台可跑、当场可判，不需要重启）。
// 实测基线：**0/6 FAIL**（Windows 与 WSL 判定一致；失败项正对应缺失的自持回退）。
export const task = {
  taskId: 'ccfix-20260919-shadowrepo',
  kind: 'implement',
  title: '影子沙盒 repoPath 解析补自持回退（lib/ 上溯），不再依赖 DSH_RELAY_REPO_PATH',
  refs: ['lib/shadow-gate.js', 'lib/index.js', 'test/shadow-gate.test.js'],
  acceptanceScript: 'probes/shadow-repo-accept.mjs',
  anchors: [
    { file: 'lib/shadow-gate.js', pattern: 'export function resolveRepoPath', note: '现有"以 base 探测 git 根"的实现——新解析函数复用它作为第一顺位' },
    { file: 'lib/shadow-gate.js', pattern: 'export function runL2ShadowGate', note: 'L2 门禁入口（repoPath 由新解析函数提供）' },
    { file: 'lib/index.js', pattern: 'const repoRoot = resolveRepoPath(base)', note: '第 1 处调用点（影子门禁）——改为调用新解析函数' },
    { file: 'lib/index.js', pattern: 'const gcRepo = (typeof process.env.DSH_RELAY_REPO_PATH', note: '定时 GC 的 env-only 门槛（本次要改掉的那一处）' },
    { file: 'lib/index.js', pattern: '定时 Shadow GC 未启用', note: '日志措辞所在处（门槛改了之后应与实际一致）' },
  ],
  acceptance:
    '① lib/shadow-gate.js 新增并导出：'
    + 'shadowRepoCandidates({ base, payload, env, moduleDir }) → 有序候选路径数组；'
    + 'resolveShadowRepo({ base, payload, env, moduleDir }) → 第一个"确实是 git 根"的候选，找不到返回 null。'
    + '**候选顺序固定为**：① base 的 git 根（复用 resolveRepoPath）② payload.repoPath ③ env.DSH_RELAY_REPO_PATH '
    + '④ env.DSH_RELAY_REPO ⑤ **moduleDir 的 git 根**（moduleDir 缺省由 import.meta.url 推导：lib/ 的上一级即仓库根）。'
    + '**关键性质**：第 ⑤ 顺位必须使"完全没有环境变量、base 也不是 git 仓库"时仍能解析出仓库根。'
    + '② lib/index.js 的 4 处取仓库根位置（影子门禁 / 回滚 / GC 端点 / 另一处）一律改调 resolveShadowRepo，'
    + '并让**定时 GC 的 gcRepo 也来自该解析函数**——不得仍以"DSH_RELAY_REPO_PATH 是否存在"作为启用门槛；'
    + '启动日志按实际结果打「已启用/未启用」（不得出现"已解析出 repo 却说未启用"的矛盾）。'
    + '③ 其余行为不变：L1/L2 判据、回滚语义、GC 逻辑、影子端点契约都不得改动。'
    + '④ 新增用例 ≥5：候选顺序（payload 优先于 env、env 优先于 moduleDir）；无 env + 非 git base 仍解析出仓库根；'
    + '全不可用 → null；定时 GC 在无 env 时也应启用（可对纯函数断言）。既有用例不减。'
    + 'node --check 通过；排除 test/shadow-gate.test.js 的 WSL 已知差异后全量 0 失败；verify-files-coverage 通过；'
    + '改动文件 LF/无 BOM；仅改 lib/shadow-gate.js、lib/index.js、test/shadow-gate.test.js',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务修一个"机制长期静默降级"的根因。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【问题（主 agent 已取证，报告里请引用这两条证据）】
1. lib/shadow-gate.js 的 resolveRepoPath(base) 以调用方传入的 base（本机是**工作区** D:\\dsh relay test，不是 git 仓库）
   为基准执行 git rev-parse --show-toplevel → 失败 → 返回 null。
2. lib/index.js 里取影子仓库根的三处回退是 payload.repoPath → process.env.DSH_RELAY_REPO_PATH；
   而宿主启动器设的是 DSH_RELAY_REPO（名字不同）→ 回退永不生效。
   后果：shouldUseShadow 对每个 importance=high 的步骤都返回 degraded（计划里 9 处 "非 git 工作区：L2 降级"），
   L2 worktree 隔离 / 原子合并 / 定时 GC 从未运行；插件每次启动都在日志里喊「定时 Shadow GC 未启用」。
3. 反面教训（已实测）：把修复寄托在"启动器补 DSH_RELAY_REPO_PATH"上**无效** —— request-restart 重启的是宿主，
   而宿主由常驻 watchdog 拉起，watchdog 继承自己启动时的环境。**所以修法必须让插件不依赖环境变量。**

【硬性要求 1：lib/shadow-gate.js 新增自持解析（纯函数 + 薄封装）】
- 导出 shadowRepoCandidates({ base, payload, env, moduleDir }) → string[]（按优先级排列的候选；
  仅做候选构造，不做 IO，便于单测）。
- 导出 resolveShadowRepo({ base, payload, env, moduleDir }) → string|null（按候选顺序返回**第一个确实是 git 根**的路径；
  复用既有 resolveRepoPath 做 git 判定）。
- 候选顺序（固定，报告里请贴出实现）：① resolveRepoPath(base) ② payload.repoPath ③ env.DSH_RELAY_REPO_PATH
  ④ env.DSH_RELAY_REPO ⑤ resolveRepoPath(moduleDir)。moduleDir 缺省值必须**由 import.meta.url 推导**
  （shadow-gate.js 位于 lib/，其上一级即仓库根）——这是"完全无 env 也能工作"的关键。
- 找不到任何可用来源时返回 null（**不得**凭空构造路径）。

【硬性要求 2：lib/index.js 接线】
- 把取影子仓库根的 4 处（约 L3369 / L4562 / L4572 / L4755）统一改为调用 resolveShadowRepo
  （保留 payload.repoPath 的语义：作为候选之一传入，而不是绕过新函数）。
- **定时 GC**（约 L5089）：gcRepo 也必须来自 resolveShadowRepo；启用条件改为"解析成功即启用"，
  **不得**再以 DSH_RELAY_REPO_PATH 是否存在为门槛；启动日志按实际打「已启用：周期 Nms（repo=…）」或
  「未启用（未解析到 git 仓库）」，两者必须与事实一致。
- 其余行为不变：L1/L2 判据、回滚、GC 逻辑、影子端点契约都不得改。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/shadow-gate.js
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/test/shadow-gate.test.js（已存在，扩充）
其它文件一律不得改动。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 全部改动文件通过；
② 新增用例 ≥5（候选顺序两种优先级 / 无 env + 非 git base 仍解析出仓库根 / 全不可用 → null / 定时 GC 无 env 也应启用）；
③ 全量回归：**排除 test/shadow-gate.test.js 的 WSL 已知差异**后 0 失败（显式文件清单，并说明你如何排除该差异）；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；不要用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：候选顺序实现（贴代码）、moduleDir 的推导方式、4 处调用点改动前后、定时 GC 门槛改动前后、
   用例清单、未做项与残余风险。
⑧ 冒烟自证（必须做）：运行 node /mnt/d/dsh-web-relay/probes/shadow-repo-accept.mjs 并贴完整输出
   （该探针真 import 你的模块并断言"无 env 也能解析出仓库根"等 6 条，当场可判、不需要重启宿主）。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
