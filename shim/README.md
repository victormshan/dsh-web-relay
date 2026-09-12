# shim/dsh-apiproxy-shim

**用途**：让本插件（及 `dsh-side-window`）能在 **dsh 0.1.5+（新线）** 上运行。

## 背景

新线 0.1.5 移除了 `@deepseek-ai/dsh-host-apiproxy`（它在 rc.7 线提供 cordis 服务 `apiProxy`），
而 `dsh-web-relay` / `dsh-side-window` 对 `apiProxy` 是**硬注入**，于是 cordis boot 断言失败：

```
Error: dsh: 2 entries did not activate
dsh-side-window: pending (waiting for service: apiProxy)
dsh-web-relay:   pending (waiting for service: apiProxy)
```

## 它做什么

注册 `apiProxy` 服务，把对侧真实调用点

```js
apiProxy.sessions.prompt({ rpcId, payload: { sessionId, mode: 'queue', content: [{ type: 'text', text }] } })
```

桥接到新线宿主服务

```js
sessionController.prompt({ requestId, sessionId, mode, content })   // → { accepted: true } / RemoteError(code, message)
```

错误码原样回填到 `result.error.code`，与 rc.7 的信封语义一致（`resp.result.ok === true` 判成功）。

## 安装（新线 profile）

```powershell
# 1) 复制到 profile 的 node_modules（包名必须叫 dsh-apiproxy-shim，insert 按名解析）
Copy-Item -Recurse shim\dsh-apiproxy-shim "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-apiproxy-shim"

# 2) 确认 profile 的 cordis.patch.yml 里有（与 dsh-web-relay / dsh-side-window 并列）
# - insert:
#     - id: apiproxy-shim
#       name: dsh-apiproxy-shim

# 3) 重启 dsh web（或该 profile 为 patchReload=live 时保存 patch 即热加载）
```

注意：`dsh-side-window` 同样硬注入 `apiProxy`，若不装本 shim，则必须把它也一并停用，否则宿主仍起不来。

## 自检

```powershell
curl.exe -s "http://127.0.0.1:3080/dsh-web-relay/status?token=<TOKEN>"   # → apiProxyAvailable:true
node shim/dsh-apiproxy-shim/test/selftest.mjs                            # → 8/8 passed
```

更完整说明见 `docs/COMPATIBILITY.md`。
