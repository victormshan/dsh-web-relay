# dsh-web-relay 新环境安装指引（INSTALL-NEW-ENV）

> 版本：v4.12.1（cap-persist 2026-09-07，外部 AI 协定 expr-2026-09-07_14-02-38，排位 A→C→B→D；
> v4.12.1 补 §2c shim 必装步骤与一键脚本的 shim 支持——此前两者都缺，导致新线装完启动失败）
> 适用：把 dsh-web-relay 及其**主 agent 能力持久化体系**装到新 harness / 新机器。

## 0. 两载体的职责（先分清）

| 载体 | 内容 | 作用 | 安装方式 |
|---|---|---|---|
| **插件包**（package.json `files`，npm/离线）| `lib/`（运行时代码全量，含 cc-channel/heartbeat-scan 等）、`bin/watchdog.mjs`、3 个 skill、registry.yaml、docs 关键件、verify 脚本 | 运行时功能 + 技能索引 | `dsh plugin --profile web add dsh-web-relay`（在线）或 offline 复制 + cordis.patch（本文件 §2）|
| **能力包**（dist/dsh-relay-capability-pack-<ver>.tar.gz）| `docs/` + `skills/` + `scripts/` 全量（lessons/runbook/CC-HYBRID/OPS/registry…）| 主 agent 语境能力（37 lessons/17 registry/runbook §2.7）| 解压到目标 repo 或同步 skills 到 `~/.dsh/skills`（§3）|
| **环境件**（本文件 §4）| watchdog 计划任务、D:\cc-tasks 混合架构执行器、env（DSH_RELAY_REPO 等）| 宿主托管 / 无介入续跑 / 混合架构 | §4 手动或 install-new-env.ps1 |

## 1. 前置

- Node ≥ 18；dsh web profile 已初始化（`dsh --profile web` 可运行）。
- （混合架构可选）WSL Ubuntu + Claude Code 登录（`claude auth status` loggedIn），D:\cc-tasks 由 cc-watchdog.sh 常驻轮询（runner.sh timeout 900 claude -p）。
- （可选）GEMINI_API_KEY 注册表 User/Machine（watchdog childEnv 自动补注入）；Chrome dsh-web-gemini-ext（web-gemini 通道）。

## 2. 插件安装（二选一，勿混用）

### 2a. 在线（发布到 npm 后）
```powershell
dsh plugin --profile web add dsh-web-relay
```

### 2b. 离线（有源码包/插件目录时）
```powershell
# 目标 profile 的 node_modules
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-web-relay"
Copy-Item <plugin根>\lib,<plugin根>\bin -Recurse $dst\ -Force
Copy-Item <plugin根>\package.json,<plugin根>\cordis.patch.yml $dst\ -Force
# cordis.patch.yml 追加插件行（若不存在，幂等）
$patch = "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"
if (-not (Select-String -Path $patch -Pattern 'dsh-web-relay' -Quiet)) {
  Add-Content $patch "`n- insert:`n  - id: dsh-web-relay`n    name: dsh-web-relay"
}
```
> 或直接运行 `scripts/install-new-env.ps1 -PluginSource <根> -WhatIf`（§5）。
> 安装后**重启 dsh web**（Host half 启动时加载）；仅改 client.js 时浏览器 bundle 走 HMR 自动热更（见 static-plugin-development skill）。

### 2c. shim 必须一起装（dsh 0.1.5+ 线**必需**）

> 2026-09-23 实测补记（v4.12.1）：**只装插件、不装 shim，在 dsh 0.1.5+ 上起不来**。
> 原因：新线整包移除了 `apiProxy` 服务，而本插件 `inject=[..., 'apiProxy']` 会停在 `pending`，
> 宿主 boot 断言失败（`N entries did not activate`）。此前的安装脚本与本文档都没有这一步
> （`grep shim` 命中 0 次），是"照文档装完却启动失败"的根因。

```powershell
# shim 与插件同级装在 profile 的 node_modules 下
$shimSrc = "<插件源>\shim\dsh-apiproxy-shim"
$shimDst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-apiproxy-shim"
New-Item -ItemType Directory -Force -Path $shimDst | Out-Null
Copy-Item "$shimSrc\lib","$shimSrc\test" $shimDst\ -Recurse -Force
Copy-Item "$shimSrc\package.json" $shimDst\ -Force

# cordis.patch.yml 追加 shim 行（幂等；同样要先删空数组占位 []）
$patch = "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"
if (-not (Select-String -Path $patch -Pattern 'dsh-apiproxy-shim' -Quiet)) {
  Add-Content $patch "`n- insert:`n  - id: dsh-apiproxy-shim`n    name: dsh-apiproxy-shim"
}

# 装后自检（当场可判，不必等重启）：期望 10/10 passed
node "$shimDst\test\selftest.mjs"
```

Linux/WSL 侧等价路径为 `~/.dsh/profiles/<profile>/node_modules/dsh-apiproxy-shim`，自检同为
`node <dst>/test/selftest.mjs`。两个一键脚本（§5）自 v4.12.1 起会自动完成本节全部步骤并跑自检。
> 0.1.0-rc.7 线装了也无害：shim 只 `provide('apiProxy')`，该线本来就有同名服务。

## 3. 能力包安装（主 agent 语境能力）

```powershell
# 1) skills 同步到 harness 热读位（裸会话即可 skill 加载 3 技能）
tar -xzf <能力包>.tar.gz -C <临时目录>        # 或直接解压
Copy-Item <临时>\skills\* $env:USERPROFILE\.dsh\skills\ -Recurse -Force

# 2) docs/scripts 参照到目标仓库（若有 git repo 则并入库）
Copy-Item <临时>\docs\* <repo>\docs\ -Recurse -Force
Copy-Item <临时>\scripts\* <repo>\scripts\ -Force

# 3) 验证
node scripts/verify-capabilities.mjs   # registry 17 条全绿
node scripts/verify-lessons.mjs        # lessons 37 条 error=0
```

## 4. 环境件（宿主托管 + 无介入续跑 + 混合架构）

1. **watchdog 计划任务**（自愈托管 3080；RestartOnFailure + ExecutionTimeLimit=0 + Hidden）：
   ```powershell
   $action = New-ScheduledTaskAction -Execute '<node.exe>' -Argument 'D:\<repo>\bin\watchdog.mjs' -WorkingDirectory 'D:\<repo>'
   Register-ScheduledTask -TaskName 'DSH-WEB-Watchdog' -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Force
   ```
2. **env**：`setx DSH_RELAY_REPO D:\<repo>`（User 级，装配 docs 指针）；watchdog 自动补注入 GEMINI_API_KEY（注册表）。
3. **续跑/心跳**：默认开启（15min 心跳 + 重启续跑扫描）；`DSH_RELAY_HEARTBEAT_MS=0` 可关。
4. **D:\cc-tasks**（混合架构执行器）：复制 runner.sh / cc-watchdog.sh，`nohup bash cc-watchdog.sh &`；WSL 侧 /mnt/d 直读。

## 5. 一键脚本

`scripts/install-new-env.ps1` 封装 §2b+§3+§4（幂等；先 `-WhatIf` 演练）：
```powershell
# 演练（只打印将执行的动作）
powershell -File scripts/install-new-env.ps1 -PluginSource D:\dsh-web-relay -CapabilityPack D:\dsh-web-relay\dist\dsh-relay-capability-pack-4.9.2.tar.gz -WhatIf
# 实装
powershell -ExecutionPolicy Bypass -File scripts/install-new-env.ps1 -PluginSource D:\dsh-web-relay -CapabilityPack D:\dsh-web-relay\dist\dsh-relay-capability-pack-4.9.2.tar.gz
```

## 6. 装后验证清单

- [ ] `dsh --profile web --dump-config` 含 dsh-web-relay 行；`/status version=4.12.1`
- [ ] **（dsh 0.1.5+ 必需）** `dsh --profile web --dump-config` 含 **dsh-apiproxy-shim** 行，
      且 `node ~/.dsh/profiles/web/node_modules/dsh-apiproxy-shim/test/selftest.mjs` → `10/10 passed`（§2c）
- [ ] `~/.dsh/skills/` 含 dsh-web-relay-main-agent / auto-iteration-modeling / agent-tool-troubleshooting（裸会话可 skill 加载）
- [ ] `verify-capabilities.mjs`（registry 17）+ `verify-lessons.mjs`（37, error=0）
- [ ] watchdog 在跑（计划任务 Running）；`/health-check` 有 bootId + heartbeat
- [ ] 重启宿主 → bootResumeScan resumed 可观测；expr 落盘 DSH_SESSION_ID 后唤醒消息自动到达（无介入续跑）
- [ ] （混合架构）`D:\cc-tasks` 心跳/queue 可派发；reviewChannel=claude-code 实弹
