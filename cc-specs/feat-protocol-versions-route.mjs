// V1 增量（外部 AI 规划验收原文要求，审核方据此打回过 Step 1）：
//   ① 元数据补 isConcurrent 别名（与 concurrent 并存）
//   ② 新增只读端点 GET /dsh-web-relay/protocol/versions（同一份元数据的只读视图，不得成为第二来源）
export const task = {
  taskId: 'ccfeat-20260922-protoversions-route',
  kind: 'implement',
  title: '补 /protocol/versions 只读端点 + 元数据 isConcurrent 别名（外部规划验收原文）',
  refs: ['lib/index.js', 'test/protocol-versions.test.js'],
  acceptanceScript: 'probes/protocol-version-grounding-accept.mjs',
  anchors: [
    { file: 'lib/index.js', pattern: 'export const PROTOCOL_VERSIONS_META = [', note: '元数据单一来源：每项补 isConcurrent 布尔别名（与 concurrent 同值）' },
    { file: 'lib/index.js', pattern: "ctx.effect(() => webServer.register({ kind: 'exact', path: '/dsh-web-relay/route/decide'", note: '路由注册区：照此形状新增一条 /dsh-web-relay/protocol/versions 的 GET 只读路由' },
    { file: 'probes/protocol-version-grounding-accept.mjs', pattern: '/protocol/versions', note: '验收探针已含该端点的断言（当前 2 条 FAIL，改完应变 PASS）' },
  ],
  acceptance:
    '① PROTOCOL_VERSIONS_META 每项新增 isConcurrent（布尔，值等于 concurrent），保留 concurrent 不删（两者并存，前端与审计各按需消费）。'
    + '② 新增 GET /dsh-web-relay/protocol/versions：返回**同一份** PROTOCOL_VERSIONS_META（可直接返回数组，或 {ok:true, versions:[...]} / {ok:true, protocolVersions:[...]}）；'
    + '严禁在此端点内重新拼装/另写一份版本清单（那会造出第二个来源）。CORS 与其他只读端点一致，OPTIONS 返回 204。'
    + '③ 既有 /context、/protocol 的 protocolVersions 行为不变。'
    + '④ node --test test/*.test.js 全绿（当前 505 例），新用例覆盖：isConcurrent 存在且与 concurrent 同值；端点返回 6 项且与 /context 顺序一致。'
    + '⑤ 不得改动审核链/配额/唤醒/cc 通道；不得新增协议版本号。',
  expectArtifacts: ['report.md'],
  outputDir: 'out',
  prompt: `你是 dsh-web-relay 项目的实现工程师（Claude Code headless）。本任务是一个**小增量**：把外部 AI 规划验收原文要求的端点与字段名补齐。

仓库根：/mnt/d/dsh-web-relay（唯一权威源码）

【背景】
上一轮实现（commit 40e3a33）把版本元数据收敛为 lib/index.js 的 PROTOCOL_VERSIONS_META 单一来源，
并随 /dsh-web-relay/context 与 /dsh-web-relay/protocol 下发 protocolVersions[]。
但外部 AI 的规划验收原文要求的是：
  · 一个新读端点 /dsh-web-relay/protocol/versions；
  · 字段名 isConcurrent（我们用的是 concurrent）。
审核方据此把 Step 1 打回。现在补齐这两点——**注意是补齐，不是另起一套**。

【硬性要求 1：isConcurrent 别名】
PROTOCOL_VERSIONS_META 每项加 isConcurrent: <boolean>，值必须等于该项的 concurrent。
**保留 concurrent 字段**（前端已按 concurrent 消费，删了会破）。两者并存，不得只留其一。

【硬性要求 2：只读端点 /dsh-web-relay/protocol/versions】
· 注册一条 exact 路由 path='/dsh-web-relay/protocol/versions'，只处理 GET（OPTIONS 返回 204，CORS 头与既有只读端点一致）。
· 响应体必须直接来自 **PROTOCOL_VERSIONS_META 这一份常量**——禁止在本处理器里重建数组、重写版本字面量、
  或从其它模块复制一份。允许的返回形状（任选其一，探针三种都认）：
  ① 直接返回数组 [ ...PROTOCOL_VERSIONS_META ]；② { ok:true, versions:[...] }；③ { ok:true, protocolVersions:[...] }。
· 建议与既有只读端点保持一致的错误/方法处理风格（参考 /dsh-web-relay/protocol 的实现）。

【硬性要求 3：不破坏既有行为】
· /context 与 /protocol 的 protocolVersions 内容与顺序**不得改变**（探针断言两者逐项一致）。
· 不新增协议版本号；不改 readStepState 的缺省回落；不动审核链/配额/唤醒/cc 通道。

【写入范围（严格）】
- /mnt/d/dsh-web-relay/lib/index.js
- /mnt/d/dsh-web-relay/test/protocol-versions.test.js（已存在，扩充）
其它文件一律不得改动（**特别是不要改 probes/protocol-version-grounding-accept.mjs**）。

【硬性验收（逐条写入 out/report.md 自证）】
① node --check 通过；
② 全量 node --test test/*.test.js 0 失败（贴改动前后用例计数；当前基线 505）；
③ 运行 node probes/protocol-version-grounding-accept.mjs 并贴完整输出：
   **[POS] 元数据带 isConcurrent 别名 与 [POS] /protocol/versions 读端点存在 两条必须由 FAIL 转 PASS**；
   该探针需要宿主已加载新代码，若这两条因"宿主未重启"仍 FAIL，请在报告中明确说明**代码侧可达的依据**
   （例如用 node 直接 import lib/index.js 读取 PROTOCOL_VERSIONS_META 验证 isConcurrent、用 grep 证明路由注册行存在），
   不得声称已端到端验证；
④ git status --porcelain 只含写入范围内文件；
⑤ 改动文件 2 空格缩进 + LF + 无 BOM（用 node fs.writeFileSync 写文件，不要用 PowerShell 改源码）；
⑥ 报告含：改动前后代码片段、为何端点不构成第二来源、用例清单、残余风险。
⑦ 不要执行 git commit，也不要运行 deliver-three-copies.mjs（主 agent 负责）。

【完成后】请务必写入完成标记 done.flag（路径见任务契约）。`,
}
