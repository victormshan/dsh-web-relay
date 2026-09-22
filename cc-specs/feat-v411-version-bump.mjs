// V2 最后一项（外部 AI 第 6 步，上一轮 cc 超时未做）：版本号 4.10.0 → 4.11.0
export const task = {
  taskId: 'ccfeat-20260922-v411-bump',
  kind: 'implement',
  title: 'V2 收口：版本号 4.11.0 + 兼容矩阵 + 版本锚点测试',
  refs: ['package.json', 'docs/COMPATIBILITY.md', 'test/timeout-fix.test.js', 'test/compat-metadata.test.js'],
  anchors: [
    { file: 'package.json', pattern: '"version": "4.10.0"', note: '改为 4.11.0' },
    { file: 'test/timeout-fix.test.js', pattern: "assert.equal(pkg.version, '4.10.0')", note: '版本锚点断言（外部规划误写为 test/version-anchor.test.js，真实锚点在此）' },
    { file: 'docs/COMPATIBILITY.md', pattern: '4.10.0', note: '版本矩阵：新增 4.11.0 行，既有行不得删除' },
  ],
  acceptance:
    '① package.json version === "4.11.0"；'
    + '② docs/COMPATIBILITY.md 版本矩阵含 4.11.0 行（既有 4.10.0 等行保留）；'
    + '③ test/timeout-fix.test.js 的版本锚点断言改为 4.11.0；test/compat-metadata.test.js 通过；'
    + '④ node --test test/*.test.js 用例数 ≥518 且 0 失败（当前基线 518）；'
    + '⑤ 只改这四个文件，不得顺手改其它内容。',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。**极小改动**任务：版本号升级。

仓库根：/mnt/d/dsh-web-relay

【要做的事（仅此四项）】
1. /mnt/d/dsh-web-relay/package.json：version "4.10.0" → "4.11.0"。
2. /mnt/d/dsh-web-relay/docs/COMPATIBILITY.md：版本矩阵新增 4.11.0 行（说明本次能力：协议版本元数据单一来源 +
   只读端点 /protocol/versions + 影子门禁仓库根解析修复 + /ask body 声明冲突显式拒绝）。**既有行一律保留**。
3. /mnt/d/dsh-web-relay/test/timeout-fix.test.js：把版本锚点断言里的 '4.10.0' 改为 '4.11.0'
   （注意：外部规划里写的 test/version-anchor.test.js **不存在**，真实锚点就在这个文件里，用例名含 "版本号跟踪 package.json"）。
4. 如 test/compat-metadata.test.js 因矩阵变化需要同步（例如它断言当前版本必须在矩阵中出现），一并同步最小改动。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/package.json
- /mnt/d/dsh-web-relay/docs/COMPATIBILITY.md
- /mnt/d/dsh-web-relay/test/timeout-fix.test.js
- /mnt/d/dsh-web-relay/test/compat-metadata.test.js（仅在确需同步时）
其它文件一律不得改动。

【硬性验收（写入 out/report.md）】
① 全量「node --test test/*.test.js」（传展开后的文件列表）用例数 **≥518 且 0 失败**，贴改动前后计数；
② 贴出 package.json 的 version 行、COMPATIBILITY.md 新增行、锚点断言改动前后；
③ git status --porcelain 只含写入范围内文件；
④ **不要** git commit、**不要**打 tag、**不要**运行 deliver-three-copies.mjs（主 agent 负责）。

【完成后】写入完成标记 done.flag。`,
}
