// 第 12 轮（末轮）交接记录：写入权威轨迹（node 写 UTF-8）
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const REPO = 'D:\\dsh-web-relay';

const unpushed = String(spawnSync('git', ['-C', REPO, 'log', '--oneline', 'origin/main..HEAD'], { encoding: 'utf8' }).stdout || '').trim();
const head = String(spawnSync('git', ['-C', REPO, 'log', '--oneline', '-1'], { encoding: 'utf8' }).stdout || '').trim();
const dirty = String(spawnSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }).stdout || '').trim();
const tags = String(spawnSync('git', ['-C', REPO, 'tag'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean);

const stamp = new Date().toISOString();
const body = `
## [主 agent] ${stamp}

【交接说明（goal 第 12 轮末；目标 (1) 已达成，目标 (2) 已就绪并挂载自动推进）】

一、已完成并可复核
- 目标 (1) 四项要求（守护常驻可自愈 / 派发前探活 / 端到端可验证 / 失败分类与降级可审计）
  证据包见本轨迹上一节「目标 (1) 收口证据包」，全部为现跑输出，可复跑。
- 通道级修复两批：探针 fail-open + 专用心跳（watchdog.heartbeat 每轮 touch）+ 配额/权限/超时失败分类与已知耗尽短路（提交 1113494）；
  cc-stats 分类桶（提交 cd42b6b）；自治链条与体检/验收/自愈测试工具链；运维手册 docs/OPS-CC-CHAIN.md（提交 9afa576）。
- 权威计划 7 步已按可行性审计改正并落盘（3 处被证伪前提：V1-2 落盘已实现、V2-1 案例库已存在、V2-2 lessons-inject 已接线）；
  5 份步骤规格（v1-1/v1-2/v2-1/v2-2/v3-1）全部通过派发前门控；V1 Step 0 建模（审计后版）已入轨迹。

二、已挂载的自动推进（不依赖本会话存活）
- 计划任务 dsh-cc-chain-v1v3：2026-09-14 10:22 起每 20 分钟触发，持续 8 小时（10:22-18:22）；
  执行 cc-chain.mjs → 按 v1-v3 链条顺序派发 5 步（V1-1 → V1-2 → V2-1 → V2-2 → V3-1）；
  每步：额度探针 → 派发 → 等结算 → verify-cc-task 五项机械验收 → 暂定提交 → 续派；
  撞额度（errorCode=cc-quota-exhausted）即暂停并存断点，下次触发自动续跑；跑完产出 chain-review-needed.md 待审清单。
- 当前断点：chain index=0，V1-1 状态 quota-paused（额度 10:20 恢复）。
- 不变量：链条**不代批**（不调 /steps/update、不写 approve）；提交是暂定的（打回走 /steps/rollback）。

三、主 agent 待办（链条不覆盖，必须人/主 agent 收口）
1. 协议审核：对链条产出的每一步执行 /steps/update start→complete（带证据）+ /steps/auto-review（独立审核）；
   高价值步骤（high + review=true）禁止自审自批。
2. 版间门（计划第 3 步）：V1 两步 approved 后校验版间门与突破度审计字段。
3. finalAcceptance 声明：V1-2 落地 /steps/declare 后，用轨迹中的 finalAcceptance 草案正式声明；
   当前 steps.json 仍为 iterations=3 / autoDecision=false / finalAcceptance=null（半状态）。
4. 三版端到端终验（计划第 7 步）。
5. 宿主重启使插件 lib/ 新代码在运行中生效（当前仅文件已同步，进程未重载）。

四、仓库与同步现状
- HEAD：${head}${dirty ? `\n- 工作树非干净：${dirty.split('\n').length} 处改动（需处理）` : '\n- 工作树干净'}
- 未推送提交 ${unpushed.split('\n').filter(Boolean).length} 个（本会话）：
${unpushed.split('\n').filter(Boolean).map((l) => '  - ' + l).join('\n')}
- 本地 tag ${tags.length} 个（按纪律不推实验标签）：${tags.join(', ')}
- 三副本同步：lib/cc-channel.js、lib/index.js、lib/cc-stats.mjs、docs/CC-HYBRID.md、docs/OPS-CC-CHAIN.md、package.json 哈希一致（含运行副本）。

五、一键复核命令
  node "D:\\dsh relay test\\cc-doctor.mjs"                      # 通道体检（10 项）
  node "D:\\dsh relay test\\cc-chain.mjs" "cc-chains/v1-v3.mjs"  # 手动推进链条（额度可用时才实际派发）
  node "D:\\dsh relay test\\verify-cc-task.mjs" <taskId>         # 单任务五项验收
  wsl.exe -e bash /mnt/d/cc-tasks/restart-test.sh               # 自愈测试（队列必须为空）

六、已知边界（不得当作已解决）
- 宿主重启才生效；计划任务 Interactive only；订阅额度与交互式共享，耗尽只能等窗口；
- 机械验收只证明范围/语法/测试/覆盖/编码，不证明「实现符合意图」；意图层靠审核环节；
- cc 通道认证为 OAuth 订阅（非 API 计费），额度是硬约束。
`;
fs.appendFileSync(trace, body, 'utf8');
console.log('  交接记录已写入轨迹，追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现有字节 =', fs.statSync(trace).size);
console.log('  未推送提交 =', unpushed.split('\n').filter(Boolean).length, '| 本地 tag =', tags.length, '| 工作树 =', dirty ? '脏' : '干净');
