// 触发 watchdog 重启宿主（用它自己的信号文件机制，不直接 kill，避免把本工具进程一起杀掉）
// 同时把本次事故与修复追加到三方轨迹（重启会终止主 agent 会话，故先落盘再触发）。
import fs from 'node:fs';

const TRACE = 'D:\\dsh relay test\\web-relay\\traces\\expr-2026-09-13_17-36-07.md';
const REQ = 'D:\\dsh-web-relay\\bin\\restart.request.json';

const body = `
【宿主卡死/tab 泛滥事故：定位、修复与恢复（提交 34c0ce5）】

一、用户实测现象
宿主页面不再响应、刷新失败；手工 \`dsh web\` 报
\`plugin tree failed to load ... listen EADDRINUSE 127.0.0.1:3080\`；期间浏览器 tab 被反复打开；
最终用户 \`taskkill /IM node.exe /F\` 才恢复。

二、watchdog 日志给出的时间线（决定性证据）
- 12:18:56Z 连续 miss 6 次（≥6）→ 重启宿主（err=timeout）→ 触发 prepare-restart → 宿主退出(code=1) → 2000ms 后重探
- 紧接 \`dsh web: opening the default browser; pass --no-open to disable\` ← **tab 就是这里来的**
- 新宿主 bootId=mu2n22lm-3c21fa77；12:19:16Z miss 4/6(timeout) → 12:19:19Z 宿主恢复
- 此后直到 20:51 我重启 watchdog 前**无任何日志** → 即 watchdog 全程判定宿主「健康」

三、三个现象各自的真因（不是同一个故障）
1. **tab 反复打开**：\`dsh web\` 默认打开浏览器；watchdog 每次重拉都再开一个。
   —— 修复：\`hostArgv()\` 固化 \`--no-open\`（\`DSH_WEB_NO_OPEN=0\` 可关）。
2. **手工 dsh web 报 EADDRINUSE**：当时**已有宿主活着占着 3080**（主 agent 在 20:28、20:41 均从它取得应答），
   同端口起第二个宿主必然撞车 —— 是碰撞而非崩溃。**注意归因**：本次 EADDRINUSE 的直接原因不是 watchdog，
   但 \`doRestart()\` 原「盲等 2s 即 spawn」是**同签名的潜在缺陷**（端口未释放就拉起 → 新宿主 boot 期即退 →
   重拉死循环 + 每次多开 tab），已一并修复。
3. **页面刷不出来**：两候选未定性 —— (a) 20:18:56 重启后 token/SPA 外壳变更（日志新 token \`?token=OO6FnZ…\`），
   旧 tab 持旧凭据连不上，即教训 L-2026-0913-057 记录的现象；(b) 宿主当时确有抖动（探针 err=timeout，miss 4/6）。

四、修复内容（提交 34c0ce5，主 agent 直改 + 单测）
- \`hostArgv()\`：固化 \`--no-open\`；守卫式补 \`--trusted-host\`（已存在不重复追加）。
- \`doRestart()\`：新增 \`scheduleSpawnAfterPortFree()\` —— 轮询 \`findPortPid()\` 直到端口空出才 spawn；
  超时（默认 15s）仍被占则**拒绝本次 spawn**并记录占用 PID，交后续 tick 与防风暴门处理。
- 决策抽纯函数 \`decidePortWait({holder, elapsedMs, waitMs})\` → 'spawn'|'wait'|'refuse'，可单测。
- 测试：\`test/watchdog.test.js\` 15 → 18 例；全量 535 → **538/538**。

五、主 agent 的两处自我更正（留痕）
- 先前报「watchdog/bridge 已自动回来、自愈在线」**是错的**：该查询把自身命令行文本也匹配（参数里含 watchdog.mjs）。
  真实情况：用户 taskkill 后 watchdog 一直未起（计划任务 DSH-WEB-Watchdog 为 **At logon**，不会自愈），
  **自愈中断约 10 分钟**；已由主 agent 用 \`schtasks /Run\` 拉起（PID 16356，锁从死 PID 20296 回收）。
- 先前据「心跳停在 20:19」推断宿主半挂死**也是错的**：心跳本就是 15 分钟周期任务，停 9 分钟属正常。
- 另澄清：启动器 \`dsh-web-watchdog.cmd\` 本就设 \`DSH_WEB_ARGS=web --trusted-host win10-dt.taile618c2.ts.net\`，
  故 watchdog 拉起的宿主**一直带 --trusted-host**；先前「自愈路径缺 --trusted-host」的说法不准确，真正缺的只有 --no-open。

六、本次动作：经用户确认，由 watchdog 接管重启一次宿主
目的：① 让宿主拿到 \`--trusted-host\`（用户走 tailscale/手机访问所必需；现宿主为用户 20:40 手工启动，缺该参数）；
② 端到端验证新「等端口释放」逻辑与 \`--no-open\`（重启后**不应**再新开 tab）。
方式：写 signal 文件 \`bin/restart.request.json\`（延迟 60s），由常驻 watchdog 在后续 tick 执行 —— 
避免直接 kill 把主 agent 的工具进程一起杀掉（L-2026-0913 同类根因，v4.9.3 已改信号文件机制）。
`;

fs.appendFileSync(TRACE, `\n## [主agent] ${new Date().toISOString()}\n\n${body.trimEnd()}\n`, 'utf8');
console.log(`[trace] 已追加 ${Buffer.byteLength(body, 'utf8')} 字节 → 轨迹共 ${fs.statSync(TRACE).size} 字节`);

const delaySecs = 60;
const requestedAt = Date.now();
const req = {
  at: requestedAt + delaySecs * 1000,
  requestedAt,
  delaySecs,
  reason: '主 agent：用户确认由 watchdog 接管重启，使宿主取得 --trusted-host 并验证 --no-open/等端口释放',
  by: 'pid:' + process.pid,
};
fs.writeFileSync(REQ, JSON.stringify(req, null, 2), 'utf8');
console.log(`[restart] 已写重启信号 → ${REQ}`);
console.log(`[restart] 计划执行于 ${new Date(req.at).toLocaleTimeString()}（${delaySecs}s 后，由 watchdog 在下一 tick 执行）`);
console.log('[restart] 预期：prep→杀旧宿主→等 3080 释放→拉起新宿主（带 --no-open --trusted-host）');
