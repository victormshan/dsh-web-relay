// ⑤b：把"宿主到底加载了哪份代码"变成**精确可证**，并顺手清掉一笔过时注释债。
//
// 背景（本会话两次实测 + 一次歧义）：
//   · 只交付不重启 → 运行时字段纹丝不动（A4b 与分类器修复都靠重启才生效，两次实测）；
//   · 版本号无法标识代码状态（4.9.7 整场会话未变过，主 agent 两次只能靠 bootId 对比间接推断）；
//   · lib/index.js 注释写「探针超时 2000ms」，权威实现是 4000ms（bin/watchdog.mjs），该注释曾误导 cc
//     得出"首探逼近超时"的错误结论（主 agent 回源才推翻）。此债现在被 verify-claims.mjs 登记为 knownDebt。
export const task = {
  taskId: 'ccfeat-20260917-loadedhash',
  kind: 'implement',
  title: '/health-check 暴露已加载代码指纹 loadedLibHash + 修正过时的探针超时注释',
  refs: ['lib/index.js', 'lib/selfcheck.mjs', 'test/selfcheck.test.js'],
  // 执行接地验收：由 verify-cc-task 第 7 项在任务产物上执行（探针自带负控，装填门禁会先验它）
  acceptanceScript: 'probes/loaded-hash-accept.mjs',
  anchors: [
    { file: 'lib/index.js', pattern: 'ccStats: heavy.ccStats', note: '并列暴露位：新字段紧邻此处加入响应体' },
    { file: 'lib/index.js', pattern: 'const HEALTH_CACHE_MS = Number(process.env.DSH_RELAY_HEALTH_CACHE_MS)', note: '模块初始化区（指纹应在启动时算一次并缓存）' },
    { file: 'lib/index.js', pattern: '探针超时 2000ms', note: '过时注释：权威值是 4000ms（bin/watchdog.mjs 的 timeoutMs 默认值），需改正' },
    { file: 'bin/watchdog.mjs', pattern: 'timeoutMs: num(process.env.DSH_WEB_TIMEOUT_MS', note: '探针超时的权威实现（注释必须与它一致）' },
    { file: 'lib/selfcheck.mjs', pattern: 'export const SELFCHECK_REQUIRED_HEALTH_FIELDS', note: '字段契约清单——增列 loadedLibHash' },
  ],
  acceptance:
    '/health-check 响应新增 loadedLibHash（16 位十六进制）与 loadedFrom（已加载模块目录的绝对路径）；'
    + '指纹算法**必须**严格按规格给定实现（逐字一致，因为外部验收器会用同一算法独立重算）；'
    + '指纹在**模块初始化时计算一次并缓存**，**不得**在请求路径内重算（该端点被 watchdog 以超时探针访问）；'
    + '同时把 lib/index.js 中「探针超时 2000ms」的过时注释改正为 4000ms（并注明权威来源 bin/watchdog.mjs）；'
    + 'SELFCHECK_REQUIRED_HEALTH_FIELDS 增列 loadedLibHash，使其随既有重启自检自动校验；'
    + 'node --check 通过；新增用例 ≥3 且既有用例不减；排除 test/shadow-gate.test.js 后全量 0 失败；'
    + 'verify-files-coverage 通过；改动文件 LF/无 BOM；仅改 lib/index.js、lib/selfcheck.mjs、test/selfcheck.test.js',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务让「宿主到底加载了哪份代码」变成**精确可证**，并顺手清掉一笔过时注释债。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【背景（主 agent 已取证）】
- 插件在仓库开发，但运行时加载的是 profile 安装目录下的副本。**只把文件复制过去而不重启宿主，运行时仍是旧代码**（实测两次：A4b 接线、失败分类修复，都必须重启才生效）。
- 版本号无法标识代码状态：package.json 的 version（4.9.7）整场会话未变，导致「这次改动到底上线了没」只能靠 bootId 对比间接推断。
- 因此需要一个**内容指纹**：由插件在启动时算一次，暴露到 /health-check，供外部验收器独立重算比对。

【硬性要求 1：loadedLibHash —— 算法必须与下述逐字一致】
外部验收器会用同一算法对仓库重算，任何偏差都会导致无法比对。规则：

1) 取**已加载模块目录**下 lib/ 内所有 .js 与 .mjs 文件（即与 lib/index.js 同目录）；
2) 按**文件名 basename 升序**排序（只用 basename，不含路径）；
3) 对每个文件，拼一行：basename + "\\n" + sha256_hex(该文件字节内容) + "\\n"；
4) 把这些行按顺序连接成一个 UTF-8 字符串 payload；
5) loadedLibHash = sha256_hex(payload) 的**前 16 个十六进制字符**。

实现要点：用 node:crypto 的 createHash('sha256')；用 fs.readFileSync 读字节（不要传 encoding）；用 import.meta.url / fileURLToPath 定位自身所在目录，**不要硬编码 D:\\ 路径**。
**必须在模块初始化时算一次并缓存**（例如模块级 const），不得在每次请求里重算——该端点被 watchdog 以超时探针访问。
同时暴露 loadedFrom = 该 lib 目录的绝对路径（便于人工排查"到底是哪份副本在跑"）。

【硬性要求 2：修正过时注释】
lib/index.js 中有一处注释声称「（watchdog）探针超时 2000ms」。**权威实现是 4000ms**：
bin/watchdog.mjs 里 timeoutMs 的默认值写作 num(process.env.DSH_WEB_TIMEOUT_MS, 4000)。
请把注释改正为 4000ms，并注明权威来源是该文件的那一行（这条注释曾让上游任务得出错误的性能结论，
属真实事故，故必须在报告里说明你改的是哪一行、改成什么）。

【硬性要求 3：纳入自检契约】
lib/selfcheck.mjs 的 SELFCHECK_REQUIRED_HEALTH_FIELDS 增列 'loadedLibHash'，
使其随既有"重启后自检"自动校验（装一半会被自检抓出）。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/lib/selfcheck.mjs
- /mnt/d/dsh-web-relay/test/selfcheck.test.js（已存在，扩充）
其它文件一律不得改动（含 package.json、lib/cc-stats.mjs、bin/watchdog.mjs —— 后者只读引用）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 全部改动文件通过；
② 新增用例 ≥3：至少覆盖 ①指纹为 16 位十六进制且**对同一目录稳定复现**；
   ②算法按规格实现（可用一个只含两个文件的临时夹具目录，手工按规格算出期望值再比对）；
   ③契约清单含 loadedLibHash；
③ 全量回归：**排除 test/shadow-gate.test.js 后** 0 失败（显式测试文件清单，不要用目录式调用）。
   注意：WSL 下该文件的 TC-Green / TC-GC / getGitHead 三项会失败，这是**已知 WSL 环境差异**（同一 commit 在 Windows 侧全绿），
   不是你引入的：不要 git stash 自证，也不要试图"修"它们，直接排除并如实说明；
④ node scripts/verify-files-coverage.mjs 通过；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync(...,'utf8')；**不要**用 PowerShell 读写文件）；
⑥ git status --porcelain 只含写入范围内文件（贴进 report.md）；
⑦ 报告含：指纹算法的实现位置与关键代码、缓存方式（证明不在请求路径重算）、注释改动的**原行与改后行**、
   用例清单、未做项与残余风险。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）；只写产物不写标记会被判为失败。`,
};
