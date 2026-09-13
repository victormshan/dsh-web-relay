# dsh-web-relay 宿主托管与重启续跑运维 SOP（OPS-RESTART-RESUME）

> 版本：4.9.2（AutoIteration 实验 V2 编写，expr-2026-09-05_13-58-07；v4.9.2 增补 §6 无介入续跑实证）
> 适用：watchdog 托管部署（DSH-WEB-Watchdog / DSH-Bridge-Watchdog 计划任务 + bin/watchdog.mjs v3.9.3+）

## 1. 架构总览

```
tailscale serve (--bg 持久, https://win10-dt... → 127.0.0.1:3080)
        │
DSH-WEB-Watchdog (计划任务 AtLogOn → wscript 隐藏 → dsh-web-watchdog.vbs → dsh-web-watchdog.cmd → bin/watchdog.mjs)
   ├─ 托管宿主 dsh web（3080，子进程；miss≥3→prepare→树杀→拉起；首检 2s；单例锁）
   ├─ env 补注入：GEMINI_API_KEY（注册表 User→Machine 回读）、DSH_WEB_ARGS(--trusted-host)、DSH_RELAY_WORKSPACE
   └─ 总守护桥接：8899 掉线且 DSH-Bridge-Watchdog 未运行 → 自动拉起
```

## 2. 重启续跑机制（v4.0）

- **bootId**：宿主进程唯一标识（`Date.now(36)-UUID8`），`/health-check` 暴露；stepState 每次写盘打戳 `bootId=CURRENT_BOOT_ID`。
- **续跑判定**：宿主启动（apply 尾 `bootResumeScan`）扫描 `web-relay/experiments/*.steps.json`——`executing/review/activeSteps 非空` **且** `bootId ≠ 当前宿主` → 判为跨重启中断。
- **动作**：`restartCount+1`；<2 → resume：trace `[system]` 留痕 + `wakeMainAgent(sessionId)` 自动唤醒原会话续跑（无 sessionId → 降级留痕，等用户「继续」）；≥2 → **paused 熔断**（stopReason「重启续跑熔断…」）。
- **跨重启保持**：`rejectStreak` / `iterationBaseCommit` / `incrementalStreak` 不重置。
- 手动触发：`POST /dsh-web-relay/admin/resume-scan {workspacePath?}`（运维/E2E）。

## 3. 面板徽标含义（v4.1）

| 徽标 | 含义 |
|---|---|
| `boot:xxxxxxxx`（灰 mono） | 宿主进程标识末 8 位；重启前后变化=宿主换代 |
| 琥珀「优雅停机准备中」 | /health-check.preparing=true（prepare-restart 已触发，停收新任务） |
| `↻ 重启续接 N · 宿主已重启·自动续跑`（紫） | stepState.restartCount>0，任务跨宿主重启自动续跑中 |
| `⛔ 重启续跑熔断·已跨重启 N`（红） | status=paused 且 stopReason 含「重启续跑熔断」——需人工介入 |
| `⚠ 非 git 降级` / `回滚基线` / `已回滚到…` | rollbackDegraded / iterationBaseCommit / rollback 历史 |

## 4. 应急手动恢复 SOP

1. **宿主不在（3080 无响应）**：查 watchdog 日志 `C:\Users\Administrator\.dsh\logs\dsh-web-watchdog.log` → 若 watchdog 未运行：`Start-ScheduledTask DSH-WEB-Watchdog`（会自动拉起宿主）；仍失败 → 手动 `dsh web`（勿双开，先确认无 watchdog）。
2. **任务中断未续**：查该 expr steps.json `restartCount/bootId` 与 trace `[system] 宿主重启续跑` → 手动 `POST /admin/resume-scan {workspacePath}`；或面板对相关 expr 点「开始/重开」。
3. **熔断 paused**：查 stopReason；确认根因（崩溃步骤/无限重启）后修复代码 → 面板 resume 或改 restartCount 后重扫。
4. **gemini=false**：确认宿主 env 含 GEMINI_API_KEY（注册表 User/Machine）——watchdog 拉起时会自动补注入；手动启动需自行设置。
5. **远程 ts.net 失效**：`tailscale serve status`（应显示 proxy 3080）；无则 `tailscale serve --bg --https=443 http://127.0.0.1:3080`。

## 5. 常用验证命令

```powershell
# 托管状态
Get-ScheduledTask DSH-WEB-Watchdog | Select State
(Invoke-RestMethod 'http://127.0.0.1:3080/dsh-web-relay/health-check') | ConvertTo-Json  # bootId/preparing
# 续跑扫描（手动）
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3080/dsh-web-relay/admin/resume-scan' -ContentType 'application/json' -Body '{"workspacePath":"D:\\dsh relay test"}'
# watchdog 日志（UTF8 读取——日志文件为 UTF-8，避免 GBK 控制台乱码）
Get-Content 'C:\Users\Administrator\.dsh\logs\dsh-web-watchdog.log' -Tail 20 -Encoding UTF8
```

## 6. 无介入续跑实证（v4.9.2，2026-09-07）

### 6.1 背景与问题
- 续跑分两层：**①状态机续跑**（bootResumeScan：resumed + restartCount + bootId 打戳 + trace 留痕）——宿主重启后**必然自动**；
  **②agent 回合续接**（wakeMainAgent 注入新回合）——依赖 expr 有 `sessionId` 且宿主能访问注入通道。
- 空等事故（lesson 036）：早期 expr `sessionId=null`（面板拿不到主会话 ID）→ ②不触发；harness goal 自动轮在会话恢复后被
  disarm（仅用户可 rearm）→ 重启实证成功后 6 小时无任何推进，直到用户提问。根因 = ②的 sessionId 缺失，非状态机缺陷。

### 6.2 机制落地（commit 6808a3f，tag v4.9.2）
- **sessionId 来源**：harness 环境变量 `DSH_SESSION_ID`（形如 `session-3da39db3-…`，agent 工具进程 env 可见）。
- **expr 落盘**：主 agent 创建/更新 expr 时把 `$env:DSH_SESSION_ID` 写入 steps.json `sessionId` 字段（skill §5 固化流程）。
- **双回退唤醒**：lib resume 分支 `wakeSid = expr.sessionId ‖ process.env.DSH_SESSION_ID`——expr 已落盘用之；
  否则宿主 env 有 `DSH_SESSION_ID`（watchdog childEnv 透传 / launcher 注入）时也自动唤醒。
- 注入通道：`wakeMainAgent → apiProxy.sessions.prompt({ sessionId, mode:'queue' })`——消息排入该会话队列，
  主 agent 自动收到「【主 agent 请协助】…」新回合（含装配注入）。

### 6.3 实证事件链（2026-09-07，零用户输入）
```
01:41  /ask manual + sessionId=DSH_SESSION_ID → agentWoken=true（注入通道验证）
01:43  建验证 expr expr-2026-09-07_07-00-00（busy executing, sessionId 落盘, isTest=true）
       → kill-host（bin/watchdog.mjs kill-host）树杀宿主
01:43  宿主自愈拉起（新 bootId）→ bootResumeScan: resumed=1（expr-07-00-00）
       → restartCount 0→1 → wakeMainAgent(sessionId) → resumeQueuedAt 打标
       →「宿主自愈重启·自动续跑」唤醒消息自动到达主 agent 会话（零输入）
       → 主 agent 按续跑协议接管：git 检查残改 → 收口/清理验证载体
```
- 证据位：`/health-check → resumed{at,checked,resumed,resumedExprs}`；expr steps.json `restartCount/resumeQueuedAt/bootId`；
  watchdog 日志 `Session wake queued for <sid> (expr: …) @ <ts>`。

### 6.4 操作流程（保证未来 expr 无介入续跑）
1. 主 agent 新建 expr（steps.json 首次落盘）时把 `sessionId: process.env.DSH_SESSION_ID` 一并写入（ask/execute 带 sessionId 或直接写状态文件）。
2. 宿主重启（kill-host / restart-now / 崩溃）→ bootResumeScan 自动续跑并注入唤醒。
3. 若宿主 env 无 DSH_SESSION_ID 且 expr 未落盘 → 退化为 trace 留痕（无注入）；届时手工 `POST /admin/resume-scan` 或用户触发。

### 6.5 平台边界（如实记录）
- 机制 b（goal 自动 rearm / harness 心跳）属 harness 平台能力，插件不可改；机制 a 已绕开该依赖。
- `DSH_SESSION_ID` 为会话级标识：同一 workspace 会话持久；若 harness 新会话更换 ID，旧 expr 落盘的 sessionId 注入会失败
  （mode=queue 投递到不存在会话 → 宿主日志记 wake 失败，trace 留痕，不影响状态机）。
- 注入消息由 harness 消费时机决定（queue 模式）：通常下一回合出现；极端情况可能延迟，此时查 `resumeQueuedAt` 是否打标区分
  「已排队」vs「harness 未消费」。


---

## 附：宿主周期停顿排查（2026-09-11 实测方法论 + 结论）

### 背景
watchdog 探针（`/dsh-web-relay/health-check`）曾间歇超时 → 连续 3 次判"宿主失联" → kill+拉起 →
风暴（当日拉起 18 次/判定 37 次）。修掉探针端点耗时（TTL 缓存）后，探针仍偶发超时，
于是用**对照法**定位到底是谁在慢。

### 方法论：同机第二服务做对照（一次实验定性）
同一时刻并行采样两个本地服务：
- 宿主 `http://127.0.0.1:3080/`（静态首页，最轻的端点）
- bridge `http://127.0.0.1:8899/__token`（独立进程）

| 目标 | 中位数 | P90 | 慢(>800ms)占比 |
|---|---|---|---|
| 宿主 3080 | 248ms | **1908ms** | **21/90（23%）** |
| bridge 8899 | **3ms** | **4ms** | 0 |

慢样本明细里宿主 2503ms 时 bridge 仅 11ms → **不是机器/磁盘/网络，而是宿主进程内部的停顿**。
（对照法比"看 CPU/磁盘计数器"快得多：CPU 3-24%、磁盘 ~0% 时完全看不出问题。）

### 排除项（都实测过，无收益即回滚）
1. **Windows Defender 实时扫描**：为工作目录加 `Add-MpPreference -ExclusionPath`（6 个目录），
   前后对比 >800ms 占比 8.5% → **9%**（无改善）→ 已 `Remove-MpPreference` 全量还原
   （不拿安全成本换不到的收益）。教训：排除类改动必须前后测量。
2. **税友（Servyou）税务软件** `C:\Servyou\gsfwzx\yqzsZxzx.exe`：累计 CPU 1144s（全机第三），
   但停顿窗口内 CPU 并不高 → 非主因（仍建议不用时报税退出）。
3. **宿主内存/GC**：宿主工作集 ~1000MB、13 线程；停顿占比随会话变长而升高（8.5% → 23%），
   空闲窗口 40 次采样全部 23–90ms（0 慢样本）→ 指向**宿主在消息/回合处理期的周期性内部工作**
   （会话记录与日志落盘、压缩、V8 GC），属宿主固有行为，非插件缺陷。

### 结论与建议
- 插件侧已修：`/health-check` 加 15s TTL 缓存 + 后台刷新；watchdog 阈值放宽为 **miss ≥ 6 / 超时 4000ms**。
  两者叠加后，即使宿主偶发 2.5s 停顿也**不会再触发重启**（实测 20:47 起零重启、零 miss 行）。
- 宿主侧停顿属环境固有，若观感变差：① 长会话换新会话（堆与会话日志更小）；② 直接重启宿主；
  ③ 需要时再按上面的"对照法"复测，先定性再动手。

---

## 7. 宿主切换/换版后的访问核查清单（2026-09-13 实测沉淀）

> 触发场景：换 dsh 版本线、换端口、换访问 authority（loopback ↔ Tailscale 域名）、或改了 profile 插件集之后。
> 目标：避免"服务端全好、浏览器白屏"这类假故障，也避免手机/Tailscale 侧漏配。

按顺序核对（每步都有可判定量）：

| # | 检查项 | 判定量 / 命令 | 常见故障与修法 |
|---|---|---|---|
| 1 | relay 是否随宿主起来 | `curl.exe -s http://127.0.0.1:<port>/dsh-web-relay/health-check` → `{"ok":true,…}` | 无响应/404 → 插件被注释或 boot 断言失败（见 `docs/COMPATIBILITY.md`） |
| 2 | 宿主端口与 serve 指向是否一致 | `tailscale serve status` 应显示 `proxy http://127.0.0.1:<port>` | 不一致 → 手机侧连不上；`tailscale serve --bg --https=443 http://127.0.0.1:<port>` |
| 3 | 非 loopback 访问是否带信任域名 | 宿主命令行需含 `--trusted-host <authority>` | 漏带 → 浏览器 `/api/*` 返回 **403**（注意 `/dsh-web-relay/*` 仍 200，不能用它判断"网络正常"） |
| 4 | 首次链接的 token | `dsh web:` 打印的 `?token=`；watchdog 托管时在 `~/.dsh/logs/dsh-web-watchdog.log` | 换 authority 或清站点数据后，需重新用带 token 的链接打开一次（cookie 30 天、绑定 authority） |
| 5 | **浏览器侧缓存** | 用隐私标签 / 清该站点数据后是否恢复 | SPA 外壳无 cache-control（harness `dsh-host-frontend-static` L73 只写 content-type）→ 换版后旧外壳引用失配 → **白屏**；详见 lesson `L-2026-0913-057` |
| 6 | 静态资源可用性 | 带 cookie 取首页 200，且组合包 `/plugins/??…&rev=…` 200；ts.net 与本机取回字节数一致 | 只有 ts.net 失败 → serve/代理层；两边一致却仍白屏 → 回到第 5 项 |

**排查顺序铁律**：先看「传输与鉴权」(1–4)，再看「缓存」(5)，最后才怀疑 harness/插件代码。
2026-09-13 手机白屏实测即因跳过第 5 项，先在网络/端口上绕了一圈（`tx 17.9MB` 已证明包下完、serve 映射正确、trusted-host 已带，唯独漏了缓存）。
