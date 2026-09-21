// 追加本轮「无人值守链条装填 + 两处静默缺陷修复」的轨迹记录（node 写 UTF-8，避免 PowerShell 编码坑）
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — 无人值守链条装填与静默缺陷修复（目标外收尾）

【背景】目标已 complete（rev 20），本轮属目标外延续：把「人工缺席下的自动版本演化」从「机制存在」推进到「真的会触发」。
起因：计划任务 dsh-cc-chain-v1v3-b 上一版触发器是「一次性 + 8h 时长窗口」，窗口于 2026-09-15 16:25 到期 →
定时器实际已死，自动演化静默停摆（无告警，表现为「配置齐全但从不发生」）。

【动作与证据】

1) 调度器恢复（已端到端验证）
- 重建触发器：Daily + /RI 20 分钟 + /DU 24:00（自续期，Until=None），Next Run 已滚动。
- 手动触发实测：\`run-chain start\` → 链条日志 → \`run-chain exit=0\`，Last Result 0，queue 无派发、chain-state 未被破坏。
- 根因留档：旧的「一次性 + 时长窗口」触发器到期后 schtasks 不会自我续期，是本次停摆的唯一原因。

2) 修复缺陷 A：收口器链条定义硬编码（protocol-close-step.mjs）
- 原状：chainDefPath 写死 \`cc-chains/v1-v3.mjs\`；任何新链条收口时 defItem=null →
  既取不到 taskId，又**绕过**「链条项在 chain-state 中无记录则拒绝收口」这条前置守卫（静默降级）。
- 修复：新增 chain-def-resolve.mjs（纯函数 + 13 例自检；优先级 env DSH_CC_CHAIN_DEF → run-chain.cmd 实际引用 → 回退 v1-v3）。
- 验证：verify-chain-def-resolve.mjs 8/8（含 3 项**变异测试**，证明守卫不是「对变异仍全绿」的假守卫）；
  verify-close-step-chaindef.mjs 7/7，用桩服务器走真实执行路径并给出 before/after 对照：
  同一场景修复前放行（exit 0）、修复后 exit 3 命中「在 chain-state 中无记录」。

3) 修复缺陷 B：链条状态未按 chainId 隔离（cc-chain.mjs）— 会让「装填」静默空转
- 原状：状态文件 D:\\cc-tasks\\chain-state.json 为全局单文件，且无条件 \`state.chainId = chain.id\`。
  把调度器指向新链条时，旧链条的 index/completedAt 被继承 —— v1-v3 完成后 index=5，
  指向仅 1 项的 v4 会命中已完成守卫（5 >= 1）打印「链条已于 … 完成，本次跳过」并 exit 0：**永不派发**。
- 修复：chainId 变化即视为换链条 → 旧状态另存 \`chain-state.<oldId>.json\` 备份后重开本链条状态。
- 验证：verify-arm-v4.mjs 14/14，含对照（禁用隔离 → 「已完成，本次跳过」exit 0；启用后 → 识别换链条、index=0、推进到额度门）。

4) 修复缺陷 C：探针已知耗尽却不落盘恢复时刻（cc-chain.mjs）
- 原状：state.quotaResetsAt 只在**真实派发失败**路径被写入，而额度耗尽期间不会真实派发 →
  「已知耗尽短路」永不生效 → 无人值守期间每 20 分钟白跑一次 90s 探针。
- 修复：探针确认耗尽时把 parseQuotaResetsAt 结果落盘（只向后推进，绝不改早；是否短路仍由既有 ≤6h 上限决定）。
- 验证：verify-quota-shortcut.mjs 19/19（① 走探针分支并落盘 ② 二次触发走短路分支且耗时骤降 ③ 状态未被改早）。

5) 修复缺陷 D（由 4 暴露，本轮自查发现）：诊断模式产生状态副作用
- \`--selftest-quota\` / \`--probe-only\` 都不传链条文件 → 默认落 v1-v3 → 触发「换链条」写出多余备份；
  更严重的是 --probe-only 会走 quotaAvailable()，而 4) 新增的 save() 会把**被换掉的空状态**写进 chain-state.json
  —— 足以抹掉活跃链条进度。修复：诊断模式跳过换链条。验证见 verify-quota-shortcut.mjs ④（4 项）。

6) 装填链条 v4（不伪造协议状态）
- 权威计划 expr-2026-09-13_17-36-07 已 finalized=true / status=done（7 步全 approved）。
  给它补塞步骤会造成「已收口却有待办步」的不一致状态，故**不**走 restructure。
- 新建 cc-chains/v4-a4.mjs：单项 A4a，**故意不挂 planStepId** → cc-chain L383 不做协议收口，
  项在「实现→验收→提交」后停在 accepted-awaiting-review 并产出待审清单：无人值守只推进实现与提交，
  审批仍归主 agent/人工，符合「高价值步骤禁止自审自批」。run-chain.cmd 相应去掉 --close-after-accept
  （避免 L410 把未收口项标成 approved-and-closed 的既有标注缺陷；该缺陷已记录未修，待有真实 accepted 项时再修并验证）。
- 真实调度路径 E2E：手动触发 → \`链条 v4-a4 启动，共 1 项，当前 index=0\` → 命中额度短路
  \`已知额度耗尽（预计 2026-09-15T23:00:00.000Z 恢复，≤6h 内短路），跳过探针与派发\` → Last Result 3（quota-paused，非故障）。
- 装填状态：chain-state.chainId=v4-a4、index=0、项 quota-paused、quotaResetsAt=2026-09-15T23:00:00.000Z（本地 07:00）。
  预计本地 07:00–07:20 的触发即为**首次无人值守派发**（短路条件 known > now 在该时刻自然失效，转为探针后派发）。

7) 一致性核对
- run-chain.cmd 引用 = cc-chains/v4-a4.mjs；收口器解析 = cc-chains/v4-a4.mjs（二者一致，缺陷 A 的修复在此闭环）。
- 无临时/变异文件残留；queue 空；链条锁已释放；A4a 目标 taskId（-a 后缀）无目录 → 不会与失败残留 ccfeat-20260916-chainstats 误判重复。

【诚实边界】
- 真正的无人值守**派发**无法在 07:00 前验证（额度被挡在派发边界之前），已验证到派发边界为止。
- 本轮装填的是 A4a 单项。链条跑完即再次 completedAt；要继续演化需再装填下一项（这是设计如此，非缺陷）。
- 缺陷 D 的标注问题：无 planStepId 时若仍传 --close-after-accept，L410 会标 approved-and-closed（与事实不符）。
  本轮以运行配置规避（不传该开关），代码层未修。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
