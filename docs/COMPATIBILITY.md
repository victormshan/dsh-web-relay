# dsh-web-relay 兼容的 dsh（DeepSeek Harness）版本

> 目的：把「本插件能跑在哪个 dsh 版本线上」写成**单一事实来源**，避免升级 dsh 之后插件静默失效、甚至把宿主带崩。
> 维护规则：每次发布、或每次 dsh 版本线变动，都要改本文件的兼容矩阵 + `README.md` 的「兼容的 dsh 版本」小节。

## 1. 兼容矩阵

| dsh-web-relay | 可用 dsh 版本 | 依赖的服务 | 实测证据 |
|---|---|---|---|
| **4.9.2**（dsh 升级前的最后一版） | **0.1.0-rc.7 线** | `apiProxy`（由 `@deepseek-ai/dsh-host-apiproxy` 提供）+ `webServer` / `fs` / `sandboxPolicy` / `agentDefaultModel` | 2026-09-13 在 0.1.0-rc.7 宿主实测：`GET /dsh-web-relay/status` → `apiProxyAvailable:true` |

> 版本号说明：本仓库 `package.json` 的 `version` 停在 `4.9.2`，而提交信息已推进到 `v4.9.6`（claude 通道前置条件可视化 / 僵尸 expr 收口等）。
> 也就是说 **4.9.2 这一版号跨了多次改动**；上表的「4.9.2」指 `package.json version = 4.9.2` 且 `lib/index.js` sha256 前缀 `AAFC6C8C8B547E75` 的那份代码（= dsh 升级前运行时副本与工作副本一致的版本）。

## 2. 关键约束：`apiProxy` 是**硬注入**

`lib/index.js` 中：

```js
export const inject = ['webServer', 'fs', 'sandboxPolicy', 'apiProxy', 'agentDefaultModel']
```

`apiProxy` 没有降级路径（源码注释亦写明 "apiProxy must be a HARD inject"）——服务缺失时该 cordis entry 会**永久 pending**。因此：

- **0.1.0-rc.7 线**：宿主自带 `@deepseek-ai/dsh-host-apiproxy` → 直接可用。
- **0.1.5+（新线）**：该包被整包移除（新装全树 grep `apiProxy` 零命中）→ boot 断言失败：

  ```
  Error: dsh: 2 entries did not activate
  dsh-side-window: pending (waiting for service: apiProxy)
  dsh-web-relay:   pending (waiting for service: apiProxy)
  ```

  后果：`dsh web` 直接起不来。应急是在 profile 的 `cordis.patch.yml` 里把对应 insert 注释掉——插件功能整体停用（relay 面板/路由、side-window 全没）。
  2026-09-13 实测：注释掉 4 个 insert 后宿主可正常启动，`GET /dsh-web-relay/health-check` 返回 **404**（路由确实不存在），证明插件处于停用态。

## 3. 新线（0.1.5+）适配

两条路，任选其一：

1. **回 rc.7**（最快）：`npm i -g --prefix <prefix> @deepseek-ai/dsh@0.1.0-rc.7`，并把 `~/.dsh/.credentials.yaml` 改回扁平布局（**注意方向性**：v1 布局是单向迁移，回退需手改；`records.client-connection/browser-session` 那条浏览器信任 grant 在扁平布局下无法表达）。
2. **装 `dsh-apiproxy-shim`**（保新线）：该 shim 注册 `apiProxy` 服务，把

   ```js
   apiProxy.sessions.prompt({ rpcId, payload: { sessionId, mode: 'queue', content: [{ type: 'text', text }] } })
   ```

   桥接到新线宿主服务 `sessionController.prompt({ requestId, sessionId, mode, content })`（成功 `{accepted:true}`，失败抛 `RemoteError(code,message)`；错误码原样回填到 `result.error`）。
   契约来源：`lib/index.js`（本仓库）与 side-window 的调用点 `await apiProxy.sessions.prompt({ rpcId: randomUUID(), payload: {...} })`。

## 4. 自检（当前宿主到底能不能用本插件）

```powershell
# TOKEN = CLI 启动时打印的 ?token=…（在 ~/.dsh/.credentials.yaml 的 browser-session secret 亦可用于 API 路由）
curl.exe -s "http://127.0.0.1:3080/dsh-web-relay/status?token=<TOKEN>"
```

| 观测 | 判定 |
|---|---|
| `apiProxyAvailable:true` | 本插件在该宿主上可用 |
| `apiProxyAvailable:false` | 宿主版本线不匹配，插件实际停用 |
| boot 输出含 `did not activate` / `waiting for service: apiProxy` | 已命中本约束（插件在拖宿主启动） |

## 5. 相关文档

- 安装与部署：`README.md` → 安装 / 宿主托管与 env
- Linux 迁移：`docs/LINUX-PORT.md`
- 新环境安装：`docs/INSTALL-NEW-ENV.md`
