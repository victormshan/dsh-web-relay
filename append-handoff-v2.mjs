// 交接说明 v2（当前状态快照）写入权威轨迹
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const REPO = 'D:\\dsh-web-relay';
const head = String(spawnSync('git', ['-C', REPO, 'log', '--oneline', '-1'], { encoding: 'utf8' }).stdout || '').trim();
const unpushed = String(spawnSync('git', ['-C', REPO, 'log', '--oneline', 'origin/main..HEAD'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean);
const dirty = String(spawnSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }).stdout || '').trim();
const now = new Date().toISOString();

const body = `
## [主 agent] ${now}

【交接说明 v2（goal 第 23 轮快照；替代第 12 轮那版）】

一、目标 (1)「Claude Code 编码通道稳定可靠」——四项要求均已达成并有现跑证据（见本轨迹「目标 (1) 收口证据包」）
- 守护常驻可自愈：systemd user 单元（enabled + Restart=always/5s）+ linger=yes + kill -9 实测（NRestarts 递增、心跳续跑）
- 派发前探活：ccWatchdogAlive fail-open（仅结构缺失阻塞）+ 专用心跳 watchdog.heartbeat（已装入运行脚本，每轮刷新）
- 端到端可验证：verify-cc-task.mjs 五项（范围/语法/全量测试/覆盖/编码卫生），含「改动可归属」判定
- 失败分类与降级可审计：runner 写 errorCode（quota/permission/timeout/failed/validate）+ classifyCcFailure + cc-stats 四桶 + /health-check 字段

二、目标 (2)「突破架构能力 + 人工缺席下的自动版本演化」——计划已审计改正，自动化闭环已武装
- 权威计划 7 步已按可行性审计改正（3 处被证伪前提：V1-2 落盘早已实现、V2-1 案例库已存在、V2-2 lessons-inject 已接线）
- 三代 Step 0 建模齐备（V1 含审计后修订版、V2、V3），V3-2 终验证据清单 7 条已固化
- 5 份步骤规格（v1-1/v1-2/v2-1/v2-2/v3-1）全部通过派发前门控；均含「可行性审计前置」与精确 file:line 锚点
- 自动链条 v1-v3（计划任务 dsh-cc-chain-v1v3-b，每 20 分钟，窗口至 08:20）：探针→派发→机械验收→暂定提交→**闭环收口（独立审核）**→续派
- 闭环守卫：min-reviewer=web-gemini 强度门、cc 自审守卫、未落地守卫、20 分钟收口超时、rejected 自动 reopen

三、进度与断点
- step 1（V1-1 突破度硬门禁）**已 approved**（reviewedBy=external，Swarm 双角色盲审），提交 4d43ea1
- 链条 index=1；step 2（V1-2）状态 quota-paused（额度 resets 3:20am），残留目录已可由 clearStaleAttempt 自动归档重跑
- 待跑：V1-2 → V2-1 → V2-2 → V3-1；随后 V1/V2/V3 版间门与 V3-2 终验（主 agent）

四、仓库与未推送
- HEAD：${head}${dirty ? `\n- 工作树非干净：${dirty.split('\n').length} 处（需处理）` : '\n- 工作树干净'}
- 未推送提交 ${unpushed.length} 个：${unpushed.map((l) => l.split(' ')[0]).join(', ')}

五、一件待你决策
- **宿主重启**（步骤已写入 OPS-CC-CHAIN §7）：让 relay 侧新代码生效（突破度门禁、/health-check 审计字段、/ask 审计注入）。
  不影响链条（走 WSL watchdog）。命令：node "D:\\dsh-web-relay\\bin\\watchdog.mjs" request-restart 5

六、每轮巡检一条命令
  node "D:\\dsh relay test\\cc-doctor.mjs"     # 通道 10 项 + 链条断点 + 计划进度
`;
fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
console.log('  HEAD =', head, '| 未推送 =', unpushed.length, '| 工作树 =', dirty ? '脏' : '干净');
