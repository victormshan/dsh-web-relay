// goal 末轮（36/36）最终盘点 v2：逐条判定 + 证据索引 + 3:20 后执行序
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const REPO = 'D:\\dsh-web-relay';
const head = String(spawnSync('git', ['-C', REPO, 'log', '--oneline', '-1'], { encoding: 'utf8' }).stdout || '').trim();
const unpushed = String(spawnSync('git', ['-C', REPO, 'log', '--oneline', 'origin/main..HEAD'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean);
const now = new Date().toISOString();

const body = `
## [主 agent] ${now}

【goal 末轮（36/36）最终盘点 v2：逐条判定 + 证据索引 + 额度恢复后的执行序】

■ 目标 (1)「Claude Code 编码通道稳定可靠」→ **已达成**（四项要求各有现跑证据）
| 要求 | 证据 |
| --- | --- |
| 守护常驻可自愈 | systemd user enabled + Restart=always/5s + linger=yes；kill -9 实测 PID 更换、NRestarts 递增、心跳续跑（restart-test.sh） |
| 派发前探活 | ccWatchdogAlive fail-open（仅结构缺失阻塞）；专用心跳 watchdog.heartbeat 已装入运行脚本；真实目录三态实测 |
| 端到端可验证 | verify-cc-task.mjs 五项 + 改动可归属判定（最近 20 提交按 taskId 匹配）；冒烟 29s SUCCESS；V1-1 独立验收 7/7 ACCEPT |
| 失败分类与降级可审计 | runner errorCode（quota/permission/timeout/failed/validate）+ classifyCcFailure + cc-stats 四桶 + cc-doctor recent/legacy 区分 + /health-check ccWatchdogWarning（**重启后实测在位**） |
附加治理：配额自愈短路、断点续跑 clearStaleAttempt（真实执行过）、watchdog 重复文件非 glob 隔离（实测 SKIP duplicate）、runner CRLF/退出码/Edit 授权修复、崩溃兜底清锁。

■ 目标 (2)「突破架构能力 + 人工缺席下的自动版本演化」→ **能力已就位，执行受外部额度门控（进度 1/7）**
- 计划 7 步已按可行性审计改正（3 处被证伪前提）；三代（V1/V2/V3）Step 0 建模齐备；V3-2 终验 7 条清单固化
- 8 份规格（v1-1/v1-2/v2-1/v2-2/v3-1/fix-cc-stats/hb/smoke）全部通过派发前门控（含语法前置门与模板卫生扫描）
- 已完成：**step 1（V1-1 突破度硬门禁）approved，reviewedBy=external（Swarm 双角色盲审）**，提交 4d43ea1；提交后运行中实测：POST /steps/restructure → 400 breakthrough-gate（保守拦截未声明的计划）——门禁**在真实宿主体内生效**
- 待执行：step 2（V1-2）→ 4 → 5 → 6；受额度限制（实测 resets 3:20am；V1-2 曾两次以 cc-quota-exhausted 失败并被正确分类/暂停）

■ 自动化与守卫（全部经实测）
- 链条 cc-chain（计划任务 dsh-cc-chain-v1v3-b，每 20 分钟、窗口 8 小时）：探针 → 派发 → 机械验收 → 暂定提交 → **闭环收口（独立审核）** → 续派
- 守卫：协议门 requiresApproved（V2-1 前须 step 3 approved，实测 CLOSED）｜审核强度门 web-gemini + **自审守卫**（claude-code/cc/claude 一律拒）｜未落地守卫｜20 分钟收口超时｜rejected 自动 reopen｜额度短路（≤6h 上限）｜崩溃清锁｜证据包硬门（*_GATE=BLOCKED 拒收口）
- 工具链回归 14/14（regression-post-restart.mjs，干净树前置）

■ 3:20 额度恢复后的执行序（无需人工启动）
1. 链条重派 V1-2（clearStaleAttempt 归档残留；按修订后契约实现 /steps/declare 与 /ask 注入）→ 机械验收 → 提交 → 闭环收口（独立审核）
2. 链条尝试 V2-1 → **被协议门拦下**（awaiting-gate，等 step 3）→ 这是设计行为
3. 主 agent：verify-v1-acceptance.mjs 出证据（届时 V1_GATE=PASS）→ protocol-close-step.mjs 3 收口 V1 版间门
4. 主 agent：declare-autoiter.mjs --auto-decision 完成声明（iterations=3 + autoDecision=true + finalAcceptance）
5. 链条续跑 V2-1 → V2-2 → V3-1（各步独立审核收口）
6. 主 agent：V2/V3 版间门 + verify-v3-acceptance.mjs → step 7 终验收口（V3_GATE）

■ 判定：**不 complete、不 blocked**
- 不 complete：目标 (2) 尚有 6/7 步未执行，且 finalAcceptance 未声明（终验硬条件）。
- 不 blocked：约束有明确时间界限（3:20am）且已武装自恢复机制（每 20 分钟触发 + 断点续跑 + 具名停止态），期间每轮均产出可验证改进。

■ 证据索引
1. 本轨迹（919 行）：目标 (1) 收口证据包 → 宿主重启结果 + 门禁实测 → 三代 Step 0 → 交接说明 v2 → 本盘点
2. docs/OPS-CC-CHAIN.md（208 行）：组件/状态文件/不变量/闭环守卫/运行手册/主 agent 步收口/失败分类/已知边界/宿主重启
3. docs/main-agent-lessons.json：68 条（本会话新增 L-2026-0914-060 … L-2026-0915-068 共 9 条）
4. 巡检：node "D:\\dsh relay test\\cc-doctor.mjs"｜回归：node "D:\\dsh relay test\\regression-post-restart.mjs"
5. 仓库：HEAD ${head.split(' ')[0]}，工作树干净，未推送 ${unpushed.length} 个提交（是否 push 由用户决定）
`;
fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size, '| HEAD =', head.split(' ')[0], '| 未推送 =', unpushed.length);
