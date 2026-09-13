# dsh-web-relay

> DeepSeek Harness (`dsh`) 三方协作协议插件 —— 把「用户 / 主 agent / 外部 AI」的协作固化为可执行协议，并接入 Claude Code 混合审核链与无介入续跑。

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English intro: a protocol-driven collaboration layer for DeepSeek Harness — three-party coordination (user / main agent / external AI), a machine-readable Step List state machine, a five-tier review chain (external → web-gemini → claude-code → dialog → manual), alternatives adjudication, cross-restart resume with heartbeat, and a capability-persistence system.

## 功能简介与能力矩阵

| 能力 | 说明 |
|---|---|
| **三方协作协议 v2.0** | 用户定调 → 外部 AI 规划（json:agent-action + 机器可读 steps）→ 主 agent 带证据执行 → 五级通道审核 → 收口发布 |
| **Step List 状态机** | pending/executing/review/approved/rejected + DAG 依赖门控 + importance 分工 + 原子打回 + restructure + AutoIteration 版间门 |
| **五级审核链** | `external(Gemini) → web-gemini → claude-code(本地 Claude Code) → dialog → manual`；reviewedBy 全程审计；Swarm 双角色盲审可叠加 |
| **混合架构** | 经 `D:\cc-tasks`（Linux: `~/cc-tasks`）派发 Claude Code（implement/review/understand），失败自动降级回三方链 |
| **alternatives 裁决** | 多方案打分择优 → `step.decision` + 轨迹（6 段模板）|
| **无介入续跑** | 重启事件驱动（sessionId 注入）+ 心跳时间驱动（15min）双保险，watchdog 自愈托管（Windows 计划任务 / Linux systemd）|
| **能力持久化** | lessons 37 / registry 17 / skills 3 / runbook——跨会话可检索，裸会话 skill 加载 |
| **协议版本** | v1.5→v2.0 全量（面板可选），外部 AI 每次调用注入协议语境 |

## 安装

### 插件（dsh web profile）
```sh
# 从 Git 源（推荐，本仓库即源）
dsh plugin --profile web add git+https://github.com/victormshan/dsh-web-relay.git
# 或发布 npm 后
dsh plugin --profile web add dsh-web-relay
# 离线：复制 lib/bin/package/cordis.patch.yml 到 profile node_modules + cordis.patch.yml 追加插件行（或 scripts/install-new-env.ps1/.sh）
```
安装后**重启 dsh web**（Host half 启动加载；仅改 client.js 走浏览器 HMR 热更）。

### 能力包（主 agent 语境能力：docs/skills/lessons）
```sh
# 解压 dist/dsh-relay-capability-pack-<ver>.tar.gz → docs/skills/scripts 参照 + skills 同步 ~/.dsh/skills
# 或一键：scripts/install-new-env.ps1 -CapabilityPack dist/….tar.gz（Windows）/ install-new-env.sh -c …（Linux）
```

### 宿主托管与 env（可选但推荐）
- watchdog：Windows 计划任务 / Linux systemd（scripts/install-new-env.* 自动注册）
- env：`DSH_RELAY_REPO`（装配指针）/ `DSH_CC_TASKS_ROOT`（cc 派发目录）/ `GEMINI_API_KEY`（Linux 写 `~/.dsh/env`，Windows 注册表）/ `DSH_SESSION_ID`（无介入续跑注入）

## 兼容的 dsh 版本

> 单一事实来源：`docs/COMPATIBILITY.md`（**升级 dsh 前先看这里**）。

| 本插件版本 | 可用 dsh 版本 | 依赖 |
|---|---|---|
| **4.9.7**（新线兼容版） | **0.1.0-rc.7 线** 与 **0.1.5+（新线）** | rc.7：宿主自带 `apiProxy`；新线：需随包 [`shim/dsh-apiproxy-shim`](shim/README.md)。两者均需 `webServer` / `fs` / `sandboxPolicy` / `agentDefaultModel` |
| **4.9.2**（dsh 升级前的最后一版） | **0.1.0-rc.7 线** | 硬依赖 `apiProxy` 服务（rc.7 由 `@deepseek-ai/dsh-host-apiproxy` 提供） |

⚠ **4.9.2 及更早版本与 0.1.5+（新线）不兼容**：新线已移除 `apiProxy` 服务，`dsh-web-relay` / `dsh-side-window` 会停在 `pending (waiting for service: apiProxy)`，使 `dsh web` 以
`Error: dsh: 2 entries did not activate` **启动失败**（2026-09-13 实测）。两条出路：① 装随包 shim（见 [`shim/README.md`](shim/README.md)）；② 应急在 profile 的 `cordis.patch.yml` 里注释掉这两行 insert 停用插件（宿主可起，`/dsh-web-relay/*` 返回 404）。

自检：`curl.exe -s "http://127.0.0.1:3080/dsh-web-relay/status?token=<TOKEN>"` → 看 `apiProxyAvailable`。

## 权限与安全说明

- **审核链审计**：每次 approved/rejected 记录 `reviewedBy / providerLabel / fallbackReason / channel`（frontmatter + steps notes），全程可溯源。
- **命令护栏**：主 agent 危险命令拦截、越界文件策略为运行时最高硬约束（协议 v1.8.1）；`review:false` 不能解除安全护栏。
- **混合架构边界**：Claude Code 经 `acceptEdits + allowedTools(Read,Write,Bash)` 白名单执行，`acceptEdits` ≠ 免批命令（权限分离）；runner 失败检测 + 主 agent 降级链兜底。
- **沙盒**：complete 触发 L1/L2 影子门禁（源码语法预检 / worktree 隔离校验）。
- 安装第三方插件即运行第三方代码——review 源码后再装（社区 disclaimer 同）。

## 文档索引

| 文档 | 内容 |
|---|---|
| **[THREE-PARTY-WALKTHROUGH.md](docs/THREE-PARTY-WALKTHROUGH.md)** | 一次完整三方协作回合走查（七回合：定调→规划→执行→审核→循环→收口→发布，真实案例）|
| **[AGENT-CAPABILITY-COMPARISON.md](docs/AGENT-CAPABILITY-COMPARISON.md)** | 能力对比：本体系 vs Claude Code（差距/超越/实现多样性，Claude 自述 + 外部 AI 评审）|
| [CC-HYBRID.md](docs/CC-HYBRID.md) | 混合架构（cc 派发/降级/验收协议 v1.0/协议化 §6）|
| [OPS-RESTART-RESUME.md](docs/OPS-RESTART-RESUME.md) | 宿主托管与重启续跑 SOP（含无介入续跑实证 §6）|
| [INSTALL-NEW-ENV.md](docs/INSTALL-NEW-ENV.md) | 新环境三步安装（插件/能力包/环境件 + 装后清单）|
| [LINUX-PORT.md](docs/LINUX-PORT.md) | WSL/Linux 移植（兼容矩阵/platform-ops 适配/限制）|
| **[COMPATIBILITY.md](docs/COMPATIBILITY.md)** | **可用 dsh 版本兼容矩阵**（升级 dsh 前必读：apiProxy 硬注入约束 / 新线不兼容症状 / 自检命令）|
| [shim/README.md](shim/README.md) | 新线（dsh 0.1.5+）适配 shim：`apiProxy` → `sessionController.prompt` 桥接，安装与自检 |
| [capabilities/registry.yaml](docs/capabilities/registry.yaml) | 能力索引 17 条（verification 自动校验）|
| [main-agent-lessons.json](docs/main-agent-lessons.json) | 37 条事故复盘（跨会话避坑）|
| [main-agent-runbook-v0.1.md](docs/main-agent-runbook-v0.1.md) | 主 agent 执行手册（纪律 §2.7 重启/续跑/回合闭环）|
| [dsh-web-relay-说明书.md](docs/dsh-web-relay-说明书.md) | 完整说明书（面板/协议/操作）|

## 版本历史

| 版本 | 协议 | 内容 |
|---|---|---|
| 4.9.7 | v2.0 | **dsh 版本线兼容声明 + 新线适配**：`dsh.compat` 元数据（rc.7 原生 / 0.1.5+ 需 shim）、随包 `shim/dsh-apiproxy-shim`（apiProxy → sessionController.prompt 桥接）、`docs/COMPATIBILITY.md` 兼容矩阵与自检、`test/compat-metadata.test.js` 回归；**shim v0.2.0 修复**：直连服务须自补 typert gateway 的尾参 `signal`（修面板「唤醒主 Agent」报 `throwIfAborted`），含 `test/apiproxy-shim.test.js` 回归；watchdog `bridgeRestartTimes` 回归修复；lesson 057–059 |
| 4.9.2 | v2.0 | 混合架构前端入口（claude-code 面板选项）、心跳双保险、无介入续跑实证、新环境可迁移（files/dist/INSTALL）、WSL/Linux 移植（platform-ops/install.sh）、能力对比与走查文档 |
| 4.9.1 | v2.0 | tailClip 审核上下文修复、kill-host 工具化、skill §5 重启/续跑纪律、lessons 035/036/037 |
| 4.9.0 | v2.0 | 协议演进四方向：claude-code 降级链 + alternatives 裁决 + 并发审核批（外部 AI 排位 C→A→B→D）|
| 4.8.0 | v1.9 | 能力持久化 4 条建议（skills frontmatter/装配 env/能力包导出/SKILL 导引）|
| … | | （更早见 git 历史）|

## 贡献与社区

- 本插件收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（`data/plugins/victormshan__dsh-web-relay.yml`）、[dsh-market](https://github.com/dsh-market/dsh-market)、[dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin)。
- 问题/建议：本仓库 Issues（或 awesome-dsh-plugin 插件页 Discussions 评论区）。
- 开发：协议/审核/混合架构演进按本仓库 docs 体系（先读 THREE-PARTY-WALKTHROUGH + CC-HYBRID + runbook §2.7）。
