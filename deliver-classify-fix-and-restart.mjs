// 分类器修复交付上线：落盘证据 + 写 watchdog 重启信号（延迟执行，调用方先返回）
import fs from 'node:fs';

const TRACE = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const REQ = String.raw`D:\dsh-web-relay\bin\restart.request.json`;
const now = new Date().toISOString();
const PREV_BOOT = 'mu3buvhm-61e5def3';

const body = `
## [主 agent] ${now} — 分类器修复交付上线（用户选「交付上线」）

【交付】dry-run：清单 30 条 → 52 文件；三副本各「一致 51 | 待更新 1，缺失 0」，待更新仅 lib/cc-stats.mjs。
\`deliver-three-copies.mjs --apply\`：三副本各更新 1 个（备份 \`.dsh-relay-backup-2026-09-16T00-34-54-074Z\`），
回读校验通过；**运行时副本与仓库逐字节一致**（比特征匹配更强的判据），且含新引入的
\`combineErrorCodeAndReason\`（调用点合并 errorCode 与 reason 的实现）。

【交付前实测（对照）】运行时 /health-check 的 ccChainStats.byFailure 仍是旧规则：
\`{cc-quota-exhausted:2, cc-timeout:1, runner-failed:3, unknown:3, timeout:1}\` —— 证明只交付不重启无效。
当时 bootId = ${PREV_BOOT}。

【本次动作】经用户确认，写 watchdog 重启信号 \`bin/restart.request.json\`（延迟执行）由常驻 watchdog
在后续 tick 执行：prep-restart → 等 3080 释放 → 以 \`--no-open --trusted-host\` 拉起新宿主。

【重启后须核验】\`node verify-classify-fix-replay.mjs --expect-live\`：
要求运行时 byFailure 与本地仓库一致（\`{cc-quota-exhausted:2, cc-timeout:2, runner-failed:2}\`，
unknown 与泛化 timeout 均不再出现），且 failed/markerMissing 与仓库同为 6/5。
该脚本已支持两种阶段（默认断言"运行时仍是旧值"，加 --expect-live 则断言"已生效"），
避免上线后再改判据、也避免留下一个过期即说谎的检查。
`;

fs.appendFileSync(TRACE, body, 'utf8');
console.log(`[trace] 已追加 ${Buffer.byteLength(body, 'utf8')} 字节 → 轨迹共 ${fs.statSync(TRACE).size} 字节`);

const delaySecs = Number(process.argv[2] || 90);
const requestedAt = Date.now();
const req = {
  at: requestedAt + delaySecs * 1000,
  requestedAt,
  delaySecs,
  reason: '主 agent：用户确认交付分类器修复上线（lib/cc-stats.mjs）；延迟执行以免调用方进程随宿主树被杀',
  by: 'pid:' + process.pid,
};
fs.writeFileSync(REQ, JSON.stringify(req, null, 2), 'utf8');
console.log(`[restart] 已写重启信号 → ${REQ}`);
console.log(`[restart] 计划执行于 ${new Date(req.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（${delaySecs}s 后，watchdog 每 5s 一跳）`);
console.log(`[restart] 重启后核对：node verify-classify-fix-replay.mjs --expect-live`);
