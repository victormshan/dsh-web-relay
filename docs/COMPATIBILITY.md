# dsh-web-relay 兼容的 dsh（DeepSeek Harness）版本

> 目的：把「本插件能跑在哪个 dsh 版本线上」写成**单一事实来源**，避免升级 dsh 之后插件静默失效、甚至把宿主带崩。
> 维护规则：每次发布、或每次 dsh 版本线变动，都要改本文件的兼容矩阵 + `README.md` 的「兼容的 dsh 版本」小节。

## 1. 兼容矩阵

| dsh-web-relay | 可用 dsh 版本 | 依赖 | 实测证据 |
|---|---|---|---|
| **4.12.1** | **0.1.0-rc.7 线** 与 **0.1.5+（新线）** | 同 4.12.0 的两条版本线；**安装链路修复**：两个一键脚本补 shim 安装与注册（新线必需，此前缺失导致装完启动失败）、离线复制补齐 shim/skills/docs/scripts、package.json `files` 补 5 个被文档引用的脚本、README/INSTALL-NEW-ENV 标注"未发布 npm"并新增 §2c shim 必装节。 |
| **4.12.0** | **0.1.0-rc.7 线** 与 **0.1.5+（新线）** | 同 4.11.1 的两条版本线；**结构性修复**：唤醒合并/去重——同一逻辑目标（会话+expr+步骤+动作）在冷却窗内重复触发不再追加整回合，消除「同一步骤反复触发导致会话队列线性堆积」（实测峰值 54 条）；另修终态实验上 reopen 已 approved 步骤产生「请执行」交接。 |
| **4.11.1** | **0.1.0-rc.7 线** 与 **0.1.5+（新线）** | 同 4.11.0 的两条版本线；修复：终态实验上 reopen/start 已 approved 步骤不再产生「请执行」交接唤醒（避免陈旧回合堆叠，见 L-2026-0922-100）。 |
| **4.11.0**（协议版本收口版） | **0.1.0-rc.7 线** 与 **0.1.5+（新线）** | 同 4.10.0 的两条版本线；新增协议版本元数据单一来源、只读端点 `/protocol/versions`、影子门禁仓库根解析修复（候选须同时是 git 根且 `package.json.name === 'dsh-web-relay'`，防止误判宿主工作区为插件仓库根）、`/ask` body 声明冲突显式拒绝。 |
| **4.10.0**（审计扩层版） | **0.1.0-rc.7 线** 与 **0.1.5+（新线）** | 同 4.9.7 的两条版本线；新增审计层 ⑨「唤醒通路实际发生」⑩「迭代状态机」⑪「事件路径演练」、熔断登记 needs-human、版间门 iterationGates 落盘、统一任务身份 `lib/task-ref.mjs`、单写者锁与信号写入守卫。 |
| **4.9.7**（新线兼容版） | **0.1.0-rc.7 线** 与 **0.1.5+（新线）** | rc.7：宿主自带 `apiProxy`；新线：需随包 `shim/dsh-apiproxy-shim`。两者均需 `webServer` / `fs` / `sandboxPolicy` / `agentDefaultModel` | 2026-09-13 在 **0.1.5-rc.1** 宿主实测：boot 无 `did not activate`；`GET /dsh-web-relay/status` → `apiProxyAvailable:true`；`/dsh-web-relay/health-check` → `ok:true` |
| **4.9.2**（dsh 升级前的最后一版） | **0.1.0-rc.7 线** | 硬依赖 `apiProxy`（由 `@deepseek-ai/dsh-host-apiproxy` 提供） | 2026-09-13 在 0.1.0-rc.7 宿主实测：`apiProxyAvailable:true` |

> 版本号说明：`package.json` 的 `version` 长期停在 `4.9.2`，而提交信息已推进到 `v4.9.6`（claude 通道前置条件可视化 / 僵尸 expr 收口等）。
> 因此 **4.9.2 这一版号跨越了多次改动**：上表「4.9.2」指 `package.json version = 4.9.2` 且 `lib/index.js` sha256 前缀 `AAFC6C8C8B547E75` 的那份代码（= dsh 升级前运行时副本与工作副本一致的版本）。**4.9.7** 是把版本号补回提交信息线、并正式声明新线兼容与携带 shim 的版本。

## 2. 关键约束：`apiProxy` 是**硬注入**

`lib/index.js` 中：

```js
export const inject = ['webServer', 'fs', 'sandboxPolicy', 'apiProxy', 'agentDefaultModel']
```

`apiProxy` 没有降级路径（源码注释亦写明 "apiProxy must be a HARD inject"）——服务缺失时该 cordis entry 会**永久 pending**。因此：

- **0.1.0-rc.7 线**：宿主自带 `@deepseek-ai/dsh-host-apiproxy` → 直接可用。
- **0.1.5+（新线）**：该包被整包移除（新装全树 grep `apiProxy` 零命中）→ 未装 shim 时 boot 断言失败：

  ```
  Error: dsh: 2 entries did not activate
  dsh-side-window: pending (waiting for service: apiProxy)
  dsh-web-relay:   pending (waiting for service: apiProxy)
  ```

  后果：`dsh web` 直接起不来。应急是在 profile 的 `cordis.patch.yml` 里把对应 insert 注释掉——插件功能整体停用（relay 面板/路由、side-window 全没）。
  2026-09-13 实测：注释掉 4 个 insert 后宿主可正常启动，`GET /dsh-web-relay/health-check` 返回 **404**（路由确实不存在），证明插件处于停用态。

## 3. 新线（0.1.5+）适配

两条路，任选其一：

1. **装 `dsh-apiproxy-shim`**（推荐，保新线）：本仓库 **v4.9.7 起随包提供** `shim/dsh-apiproxy-shim`。它注册 `apiProxy` 服务，把

   ```js
   apiProxy.sessions.prompt({ rpcId, payload: { sessionId, mode: 'queue', content: [{ type: 'text', text }] } })
   ```

   桥接到新线宿主服务 `sessionController.prompt({ requestId, sessionId, mode, content })`（成功 `{accepted:true}`，失败抛 `RemoteError(code,message)`；错误码原样回填 `result.error`）。
   安装步骤见 `shim/README.md`；要点：复制到 profile 的 `node_modules/dsh-apiproxy-shim` + 在 `cordis.patch.yml` 里 insert `{ id: apiproxy-shim, name: dsh-apiproxy-shim }`。
2. **回 rc.7**（备选）：`npm i -g --prefix <prefix> @deepseek-ai/dsh@0.1.0-rc.7`，并把 `~/.dsh/.credentials.yaml` 改回扁平布局（**方向性警告**：v1 布局是单向迁移，回退需手改；`records.client-connection/browser-session` 那条浏览器信任 grant 在扁平布局下无法表达）。

> 只升 dsh、不装 shim 且不停用插件的组合**没有可行解**——这是硬注入语义决定的，不是配置问题。

## 4. 自检（当前宿主到底能不能用本插件）

```powershell
# TOKEN = CLI 启动时打印的 ?token=…（~/.dsh/.credentials.yaml 里 browser-session 的 secret 亦可用于 API 路由）
curl.exe -s "http://127.0.0.1:3080/dsh-web-relay/status?token=<TOKEN>"
```

| 观测 | 判定 |
|---|---|
| `apiProxyAvailable:true` | 本插件在该宿主上可用 |
| `apiProxyAvailable:false` | 宿主版本线不匹配，插件实际停用 |
| boot 输出含 `did not activate` / `waiting for service: apiProxy` | 已命中本约束（插件在拖宿主启动） |

## 5. 2026-09-13 实测记录（新线兼容版）

环境：Windows 原生 dsh `0.1.5-rc.1`（`C:\nvm4w\nodejs` → nvm v26.7.0），profile `~/.dsh/profiles/web`，插件 `dsh-web-relay 4.9.x` 代码 + `dsh-apiproxy-shim 0.2.0` + `dsh-side-window 0.5.0`。

| 观测点 | 结果 |
|---|---|
| boot 输出 | 无 `did not activate`；打印 `[dsh-web-relay] 心跳自查已启用：周期 15min` |
| bootResumeScan | `D:\dsh relay test(96)｜续跑 0（）｜熔断 0（）`（无 bootId 戳的历史 expr 不参与续跑） |
| `/dsh-web-relay/status` | `{"ok":true,"version":"4.9.2","apiProxyAvailable":true,...}` |
| `/dsh-web-relay/health-check` | `{"ok":true,"version":"4.9.2","resumed":{"checked":2,"resumed":0,"paused":0},...}` |
| 副作用 | 激活期间业务 workspace（`D:\dsh relay test\web-relay`）零写入 |

### 5.1 唤醒链路修复（shim v0.2.0，2026-09-13 实测）

面板「唤醒主 Agent」曾报 `gateway/internal: Cannot read properties of undefined (reading 'throwIfAborted')`。

- **根因**：新线 `SessionController.prompt(request, signal)`（`dsh-api-session-controller` L2920-2923）的**尾参 `signal` 由 typert gateway 注入**：`dsh-api-gateway` L397 `NEVER_ABORTED_SIGNAL` + L746 `args.push(request.signal ?? NEVER_ABORTED_SIGNAL)`——**仅当方法声明尾部形参为 `signal` 时**。shim 是**直连服务**，没有这层包装 → `undefined.throwIfAborted()` 抛 TypeError。
- **修法**（shim v0.2.0）：按 `controller.prompt.length >= 2` 自适应补一个永不 abort 的 `AbortSignal`，与 gateway 行为对齐；失败信封另附诊断（声明元数 + 栈帧前几行），因为这类错误没有 `.code`，现场只能靠 message 定位。
- **验证**：修复后 handoff 唤醒成功，注入内容包含【主 agent 装配】5 条能力文件清单 + lesson Top-K（实测 expr-2026-09-13_16-14-12，并据此完成 2/2 步收口）。
- **回归**：`shim/dsh-apiproxy-shim/test/selftest.mjs`（10/10）+ `test/apiproxy-shim.test.js`（源码级接线 + 两参 signal 行为断言）。

## 6. 相关文档

- shim 说明与安装：`shim/README.md`
- 安装与部署：`README.md` → 安装 / 宿主托管与 env
- Linux 迁移：`docs/LINUX-PORT.md`
- 新环境安装：`docs/INSTALL-NEW-ENV.md`
