// 落盘交接记录 + 触发 watchdog 接管重启，激活本会话的交付
import fs from 'node:fs';

const TRACE = 'D:\\dsh relay test\\web-relay\\traces\\expr-2026-09-13_17-36-07.md';
const REQ = 'D:\\dsh-web-relay\\bin\\restart.request.json';

const body = `
【第 47 轮：A4 拆分备用 + 触发重启激活本会话交付】

一、A4 拆分（A4 曾于 490s 处因配额耗尽中断，产物只到一半且无测试，已还原工作树）
- 新规格 **A4a**（\`cc-specs/feat-chain-stats-a.mjs\`，门控 PASS：3 anchors 校验 0 失败 0 告警）：
  只做**纯逻辑层**——\`summarizeChainTasks\` 纯函数 + \`loadChainTaskResults\` **有界读取器** + ≥8 用例；
  复用既有 \`classifyCcFailure\`；**cc-marker-missing 单列不计入 failed**；窗口/边界与畸形输入都要有用例锁定；
  **明确不改 lib/index.js**（接线属 A4b）。
- A4b（待 A4a 落地后派）：/health-check 接线 + 文档 + **health-check 耗时前后实测**
  （该端点被 4s 超时的 watchdog 探针探测，超时会误判宿主挂掉——今晚刚修过同类问题）。

二、重启前核对（均已确认）
- 三副本**完全一致**：\`deliver-three-copies\` 报「一致 52 | 待更新 0」（三目标）。
- 运行时副本已含本会话全部关键修复（逐项 grep 确认）：\`isIgnoredArtifact\`（selfcheck .bak 排除）、
  \`unclaimed-pending\`（A1）、\`shouldSuppressWake\`（A3）、\`wakeLedger\`（A2）、\`DEFAULT_QUOTA_TZ\`（配额解析修复）。

三、本次重启将激活（此前均为「已交付但运行端未加载」）
1. **selfcheck 的 .bak 排除**——否则每次宿主启动都会因运行时副本里的 3 个部署备份而**假唤醒主 agent**
   （本会话实测过一次）；这是本次重启最直接的收益。
2. A1 \`unclaimed-pending\` 信号 + A2 唤醒台账/状态核对 + A3 配额感知抑制（含 A5' 已即时生效的配额来源）。
3. \`queueDepth\` 口径修复（A7）与配额恢复时刻解析修复（8 小时时区偏差 + 仅小时文案）。
（A5' 渠道侧配额状态写入与 A6 心跳打点**已在渠道侧即时生效**，不依赖重启。）

四、重启后核验清单（交给后续会话）
1. \`/health-check\` 的 \`bootId\` 应变化；
2. \`selfCheck\` 应为 \`differing:[]\` + \`ignored:3\` + \`notified:false\`
   ——「.bak 被忽略且**没有**假唤醒」的双重证据；
3. \`wakeLedger\` 字段出现（A2 生效）；
4. \`node "D:\\dsh relay test\\regression-post-restart.mjs"\` 期望 14/14。

五、配额恢复（本地 07:00，实测文案 \`resets 7am\`）后的剩余工作
1. 派 **A4a**（规格已就绪、门控 PASS）→ 独立验收 → 提交 → 交付；
2. 派 **A4b**（接线 + 文档 + 性能实测）；
3. A5（relay 读 chain-state.json 的 quotaResetsAt）**已降为可选/互补**——A5' 从渠道侧覆盖了同一缺口
   且覆盖面更广（任何 runner 任务撞配额都会写状态）。

注：宿主重启会**解除 goal 武装**（\`activation: disarmed\`），需人说「继续」才会恢复自动续跑。
`;

fs.appendFileSync(TRACE, `\n## [主agent] ${new Date().toISOString()}\n\n${body.trimEnd()}\n`, 'utf8');
console.log(`[trace] 已追加 ${Buffer.byteLength(body, 'utf8')} 字节 → 轨迹共 ${fs.statSync(TRACE).size} 字节`);

const delaySecs = 90;
const requestedAt = Date.now();
fs.writeFileSync(REQ, JSON.stringify({
  at: requestedAt + delaySecs * 1000,
  requestedAt,
  delaySecs,
  reason: '主 agent：激活本会话交付（selfcheck .bak 排除 + A1/A2/A3/A7 + 配额解析修复）；三副本已核对一致',
  by: 'pid:' + process.pid,
}, null, 2), 'utf8');
console.log(`[restart] 已写重启信号，计划 ${new Date(requestedAt + delaySecs * 1000).toLocaleTimeString()} 由 watchdog 执行`);
console.log('[restart] 重启后按轨迹「四、核验清单」确认；goal 将解除武装，说「继续」即恢复。');
