// A4b 交付上线：先落盘裁决与证据，再写 watchdog 重启信号（延迟执行 → 本进程先返回，不会被随宿主树杀掉）
import fs from 'node:fs';

const TRACE = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const REQ = String.raw`D:\dsh-web-relay\bin\restart.request.json`;
const now = new Date().toISOString();
const PREV_BOOT = 'mu32to7l-5aeb301f';

const body = `
## [主 agent] ${now} — A4b 验收裁决、交付上线与重启（用户选「按推荐」）

【背景】v4-a4b 链条于 07:40:01 自动触发（\`链条 v4-a4b 启动，共 1 项，当前 index=0\`——
换链条状态隔离生效，未被 v4-a4 的 completedAt 挡住），07:48:26 提交 3550028（4 文件）。
这是**连续第二次**无人值守派发成功（第一次为 A4a，07:00 → 07:07）。

【主 agent 独立验收裁决：ACCEPT】
1) verify-cc-task ccfeat-20260916-chainstats-b = ACCEPT（7/7）：4 文件全在声明范围内
   （docs/CC-HYBRID.md、lib/index.js、lib/selfcheck.mjs、test/selfcheck.test.js）；node --check 通过；
   无 BOM/无 CRLF；全量 614/614；*.test.js 子集 456/456；verify-files-coverage OK。
2) 接线点核对（源码级）：空态 \`ccChainStats: null\`（lib/index.js L2220）、聚合
   \`loadChainTaskResults + summarizeChainTasks\`（L2294-2301，整体 try/catch fail-open）、
   响应暴露 \`ccChainStats: heavy.ccChainStats\`（L2348）；契约清单增列（lib/selfcheck.mjs）。
3) **ccStats（审核通道）语义未被触及**：diff 中含 ccStats 的行仅为新增注释，无字段/调用点改动。
4) 工程判断良好：显式传 \`root: CC_TASKS_ROOT\` 而非用读取器自带默认值，理由是「与 recordCcStat 的
   CC_STATS_PATH 保持同一根目录来源，避免 DSH_CC_TASKS_ROOT 被覆盖时两处各读各的目录、统计对不上」。
5) 文档：docs/CC-HYBRID.md 新增 §21（10 处提及），覆盖语义/与 ccStats 分工/marker-missing 单列含义/
   有界读取/TTL 缓存/fail-open/空态形状/契约增列。\`sync-engine-docs --check\` 无漂移、
   \`verify-capabilities\` exit 0。
6) 实测数字（报告自证）：loadChainTaskResults + summarizeChainTasks 端到端 median 155.25ms / max 247.79ms（N=7）。

【重要：对报告所述「残余风险」的独立核查（结论：风险不成立）】
- 报告沿用了 lib/index.js 注释里的「watchdog 探针超时 2000ms」，并据此指出首探路径
  （重启后缓存为空）基线 ~1520ms + 新增 155-248ms ≈ 1670-1770ms「逼近超时」。
- 主 agent 回源核对 \`bin/watchdog.mjs\` L28：\`timeoutMs: num(process.env.DSH_WEB_TIMEOUT_MS, 4000)\`
  —— **真实默认是 4000ms**。故首探裕度约 2.2-2.3 秒，该残余风险不成立，**无需为此单开任务**。
- 但暴露一处**过时注释**：lib/index.js 内「探针超时 2000ms」与实际配置（4000ms）不符，
  属文档/注释准确性问题，非功能缺陷。已记录，未改（仓库代码由 cc 实施）。

【交付上线（用户选「交付上线 + 重启宿主」）】
- dry-run：清单 30 条 → 展开 52 文件；运行时副本 / DSH 侧 / standalone 三副本各「一致 48 | 待更新 4，缺失 0」。
  待更新正是 lib/cc-stats.mjs（**A4a 的产物此前从未交付过**）、lib/index.js、lib/selfcheck.mjs、docs/CC-HYBRID.md。
- \`deliver-three-copies.mjs --apply\`：三副本各更新 4 个（备份于 \`.dsh-relay-backup-2026-09-15T23-50-55-166Z\`），
  回读校验通过。运行时副本回读：lib/index.js 含 ccChainStats 7 处；lib/cc-stats.mjs 含
  summarizeChainTasks 与 loadChainTaskResults（**import 依赖齐备**，这是先交付 A4a 文件的原因：
  只交付 A4b 的 index.js 会直接 import 失败）。
- 交付前实测（关键对照）：运行时 /health-check **没有** ccChainStats（宿主仍跑旧代码）→ 证明
  「只交付不重启」无效，必须重启。当时 bootId = ${PREV_BOOT}。

【本次动作】经用户确认，写 watchdog 重启信号 \`bin/restart.request.json\`（延迟执行）由常驻 watchdog
在后续 tick 执行：prep-restart → 等 3080 释放 → 以 \`--no-open --trusted-host\` 拉起新宿主。
重启后须核验（脚本 verify-a4b-live.mjs，已落盘待跑）：bootId 变化、ccChainStats 出现且带真实数字、
ccStats 未回归、selfCheck 契约 ok 且 differing 为空（本轮已把 ccChainStats 写进契约清单，
故「装了一半」会被自检抓出）。
`;

fs.appendFileSync(TRACE, body, 'utf8');
console.log(`[trace] 已追加 ${Buffer.byteLength(body, 'utf8')} 字节 → 轨迹共 ${fs.statSync(TRACE).size} 字节`);

const delaySecs = Number(process.argv[2] || 90);
const requestedAt = Date.now();
const req = {
  at: requestedAt + delaySecs * 1000,
  requestedAt,
  delaySecs,
  reason: '主 agent：用户确认交付 A4b 上线（ccChainStats 需重启后生效）；延迟执行以免调用方进程随宿主树被杀',
  by: 'pid:' + process.pid,
};
fs.writeFileSync(REQ, JSON.stringify(req, null, 2), 'utf8');
console.log(`[restart] 已写重启信号 → ${REQ}`);
console.log(`[restart] 计划执行于 ${new Date(req.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（${delaySecs}s 后，watchdog 每 5s 一跳）`);
console.log('[restart] 预期：prep → 杀旧宿主 → 等 3080 释放 → 拉起新宿主（--no-open --trusted-host）');
console.log(`[restart] 重启后核对：node verify-a4b-live.mjs --prev-boot ${PREV_BOOT}`);
