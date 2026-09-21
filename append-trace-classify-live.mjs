// 记录：分类器修复上线生效核验 + 本次重启续跑扫描为何判定 0 条
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — 分类器修复上线生效（12/12）+ 重启续跑扫描判定说明

【重启】信号被 watchdog 消费；新宿主 PID 12920 启动于 08:36:41；bootId
\`mu3buvhm-61e5def3\` → \`mu3desif-4d1b465f\`；selfCheck contract.ok=true（本次 boot）。

【上线生效核验 verify-classify-fix-replay.mjs --expect-live = 12/12】
- 运行时 /health-check 的 ccChainStats 已反映新规则：
  \`byFailure={cc-quota-exhausted:2, cc-timeout:2, runner-failed:2}\`，failed/markerMissing = **6/5**
  —— 与本地仓库、与 spec 验收 ③ 的预期三者一致；unknown 与泛化 timeout 均已消失。
- 交付前该字段为 \`{unknown:3, timeout:1, runner-failed:3, cc-timeout:1, quota:2}\` / 10/1，
  即「交付+重启」确实是生效的必要条件（只交付不重启无效，已两次实测）。

【重启续跑扫描：resumed=0 是正确行为，不是失效】
/health-check 的 resumed 字段 = \`{at:00:36:53Z, checked:99, resumed:0, paused:0, resumedExprs:[], noSessionId:[]}\`。
判据（回源 lib/resume-scan.js:isExprInterrupted，勿凭记忆）：
  busy   = status ∈ {executing, review} **或** activeSteps 非空
  crossBoot = state.bootId 已打戳且 ≠ 当前 bootId
  续跑 ⇔ busy && crossBoot；status 为 paused/stopped 的一律不参与（防熔断任务每次重启刷计数）
本 expr（expr-2026-09-13_17-36-07）现状 status=done、finalized=true、activeSteps=[] → busy=false
→ action=none → 不续跑。lib/index.js 的注释也写明「bootResumeScan 只续跑**在飞**的 expr
（已 finalize 的计划不在续跑名单里）——这是正确行为」。另有熔断：同一断点反复跨重启续接
restartCount ≥ 2 → paused（引入 progressFingerprint 后，"有进展的重启"会重置计数，避免误熔断）。
另：心跳机制（双保险 b）本 boot 亦已触发（heartbeat.at=00:37:07Z）。

【结论】本次重启后「不续跑」= 无在飞任务可续，机制本身正常（checked=99 证明扫描确实跑了）。
主 agent 的会话侧工作（交付、验收、轨迹）本就不属于该机制的覆盖范围——它只针对三方协议的 expr 步骤状态。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
