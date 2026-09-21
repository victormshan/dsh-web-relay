// 归档宿主重启结果 + 运行中门禁实测证据
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();
const body = `
## [主 agent] ${now}

【宿主重启结果 + 运行中门禁实测（用户授权后执行）】

重启已发生并生效（前快照 → 后实测）：
- bootId：mu00fi5u-ac150922 → **mu1jg0z6-f86aa1cc**（换新宿主；新宿主进程 01:50:04 启动）
- /health-check：**新增 ccWatchdogWarning: null**（心跳新鲜故无告警）→ 证明运行副本新代码已被加载
- 重启请求信号文件已被 watchdog 消费并清理；boot 恢复扫描 17:50:25Z、心跳 17:50:40Z 正常
- 通道审计面：bridge=true、dialogFallbackRate { sample:33, dialogRatio:0, level:ok, "外部通道成功 33 步" }、worker { authState:OK, isReady:true }
  → 外部审核通道健康，链条闭环的强度门（web-gemini）可满足

**运行中门禁实测（V1-1 的端到端证据，此前只有单测+静态取证）**：
POST /dsh-web-relay/steps/restructure（payload = 当前计划 7 步，内容等价）返回：
    {"ok":false,"error":"breakthrough-gate","gatePassed":false,"requiredType":"structural","consecutiveIncremental":0,
     "reasons":["本版未声明任何突破度类型，无法判定；请由规划方补 breakthrough_type（incremental/structural/paradigm）"]}
→ 门禁在真实宿主上**按设计保守拦截**（本计划 7 步 breakthrough_type 全为 null）；且计划未被改动（步骤数 7、状态 approved,pending×6、incrementalStreak=0 保持不变）。

操作提示（复述，避免踩坑）：对本计划做任何 restructure 都必须先为步骤声明 breakthrough_type，或设 DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED=1；
否则会收到 400 breakthrough-gate。这是设计意图（防门禁无输入静默失效），不是故障。

链条不受重启影响：index=1，V1-2 quota-paused；计划任务 dsh-cc-chain-v1v3-b Last Result=3（额度暂停）、Next Run 每 20 分钟；
额度实测 resets 3:20am —— 恢复后自动续跑 V1-2 → V2-1 → V2-2 → V3-1（含闭环收口）。
`;
fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
