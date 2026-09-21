// goal 第 24 轮（末轮）最终盘点与证据索引
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const REPO = 'D:\\dsh-web-relay';
const head = String(spawnSync('git', ['-C', REPO, 'log', '--oneline', '-1'], { encoding: 'utf8' }).stdout || '').trim();
const unpushed = String(spawnSync('git', ['-C', REPO, 'log', '--oneline', 'origin/main..HEAD'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean);
const now = new Date().toISOString();

const body = `
## [主 agent] ${now}

【goal 末轮最终盘点（24/24）：逐条判定 + 证据索引】

■ 目标 (1)「Claude Code 编码通道稳定可靠」→ **判定：已达成**（四项要求均有现跑证据，见本轨迹「目标 (1) 收口证据包」）
| 要求 | 证据（可复跑） |
| --- | --- |
| 守护常驻可自愈 | systemd user 单元 enabled + Restart=always/5s + linger=yes；kill -9 实测 PID 更换、NRestarts 递增、心跳续跑（restart-test.sh） |
| 派发前探活 | ccWatchdogAlive fail-open（仅结构缺失阻塞）；专用心跳 watchdog.heartbeat 已装入 cc-watchdog.sh（每轮刷新）；真实目录三态实测 |
| 端到端可验证 | verify-cc-task.mjs 五项 + 改动可归属判定（最近 20 提交按 taskId 匹配）；冒烟 29s SUCCESS；V1-1 独立验收 7/7 |
| 失败分类与降级可审计 | runner 写 errorCode（quota/permission/timeout/failed/validate）+ classifyCcFailure + cc-stats 四桶 + cc-doctor 区分 recent/legacy + /health-check 字段（宿主重启后生效） |
通道治理附加：配额自愈派发（探针→恢复即入队）、链条断点续跑（clearStaleAttempt 归档残留）、watchdog 重复文件改入非 glob 目录、CRLF/退出码修复、自审守卫。

■ 目标 (2)「突破架构能力 + 人工缺席下的自动版本演化」→ **判定：能力已就位，执行受外部额度门控（进度 1/7）**
- 计划已按可行性审计改正（3 处被证伪前提：V1-2 落盘早已实现、V2-1 案例库已存在、V2-2 lessons-inject 已接线）
- 三代 Step 0 建模齐备；V3-2 终验证据清单 7 条固化；5 份步骤规格全部通过派发前门控（含语法前置门）
- 自动化闭环武装：链条（派发→机械验收→暂定提交→**协议收口含独立审核**→续派）+ 强度门（web-gemini）+ 自审守卫 + 未落地守卫 + 20 分钟超时 + rejected 自动 reopen
- 已完成：step 1（V1-1 突破度硬门禁）**approved，reviewedBy=external**（Swarm 双角色盲审），提交 4d43ea1，全量测试 473/473、*.test.js 333/333
- 待执行：V1-2 → V2-1 → V2-2 → V3-1（额度 3:20am 恢复后由计划任务 dsh-cc-chain-v1v3-b 自动推进）；随后 V1/V2/V3 版间门与 V3-2 终验（主 agent）

■ 为何不标 complete / 不标 blocked
- 不 complete：目标 (2) 尚有 6/7 步未执行，且 finalAcceptance 仍未声明（终验硬条件之一）。
- 不 blocked：该约束有明确时间界限（额度 resets 3:20am）且**已武装自动恢复机制**（每 20 分钟触发、断点续跑、失败具名停止态），并非无路可走；
  期间每轮均产出可验证改进（本会话新增工具 10 件、规格 8 份、教训 7 条 060–066、提交 17 个）。

■ 证据索引（接手时按此顺序读）
1. 本轨迹（824 行）：目标 (1) 收口证据包 → V1/V2/V3 Step 0 → 交接说明 v2 → 本条最终盘点
2. docs/OPS-CC-CHAIN.md：组件 / 状态文件 / 三条不变量 / 闭环与守卫 / 运行手册 / 失败分类 / 已知边界 / 宿主重启 §7
3. docs/main-agent-lessons.json：66 条（本会话新增 060–066）
4. 每轮巡检一条命令：node "D:\\dsh relay test\\cc-doctor.mjs"
5. 仓库：HEAD ${head.split(' ')[0]}，工作树干净；未推送 ${unpushed.length} 个提交（是否 push 由用户决定）

■ 唯一待用户决策项：宿主重启（OPS §7），使 relay 侧新代码（突破度门禁、/health-check 审计字段、/ask 审计注入）在运行中生效；不影响链条。
`;
fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size, '| HEAD =', head.split(' ')[0], '| 未推送 =', unpushed.length);
