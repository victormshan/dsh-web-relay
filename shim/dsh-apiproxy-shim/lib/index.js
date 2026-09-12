// dsh-apiproxy-shim — 新线(harnes 0.1.5+)兼容层（Host half，cordis 静态插件）。
// ===========================================================================
// 背景
//   rc.7 时代由 @deepseek-ai/dsh-host-apiproxy 提供 cordis 服务 `apiProxy`；
//   新线 0.1.5 整包移除该服务（全树 grep `apiProxy` 零命中），于是：
//     dsh-side-window 0.5.0  inject=[...,'apiProxy']  → pending
//     dsh-web-relay   4.9.2  inject=[...,'apiProxy']  → pending
//   boot 断言 "2 entries did not activate" 使 dsh web 起不来。
//
// 契约（对侧真实调用点实测）
//   dsh-web-relay   lib/index.js L1738 / dsh-side-window lib/index.js L404：
//     const resp = await apiProxy.sessions.prompt({
//       rpcId: randomUUID(),
//       payload: { sessionId, mode: 'queue', content: [{ type: 'text', text }] }
//     })
//     resp.result.ok === true                  → 已受理
//     resp.result.error = { code, message }    → 拒绝
//
// 新线等价实现（本 shim 的桥接目标）
//   ctx.get('sessionController') 是 dsh-api-session-controller 的 TypertRemoteService
//   （constructor: super(ctx, "sessionController", { namespace: "session" })），其
//   async prompt(request) 接受 { requestId, sessionId, mode:'queue'|'steer', content }，
//   成功返回 { accepted: true }，失败抛 RemoteError(code, message)。
//
// 依赖服务（已逐一在新线确认同名存在）
//   sessionController ← @deepseek-ai/dsh-api-session-controller（本 shim 硬注入）
//   webServer/fs/llm/agentDefaultModel/sandboxPolicy ← 由新线各包 super(ctx, ...) 提供，
//   供 relay / side-window 自身的 inject 列表使用，无需本 shim 处理。
// ===========================================================================

import { randomUUID } from 'node:crypto'

export const name = 'dsh-apiproxy-shim'
export const inject = ['sessionController']

const okEnvelope = (rpcId, value) => ({
  rpcId,
  result: value === undefined ? { ok: true } : { ok: true, value }
})

const errEnvelope = (rpcId, code, message) => ({
  rpcId,
  result: { ok: false, error: { code, message } }
})

const hasText = (content) =>
  Array.isArray(content) &&
  content.some((part) => part && part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0)

/**
 * 用给定的 sessionController 构造 apiProxy 兼容对象。
 * 抽成工厂函数是为了能在 cordis 之外做单元自测（见 test/selftest.mjs）。
 * @param controller 新线宿主服务 sessionController（需具备 prompt(request)）
 */
export function makeApiProxy(controller) {
  async function prompt(request) {
    const rpcId = (request && request.rpcId) || randomUUID()
    const payload = (request && request.payload) || {}
    const { sessionId } = payload
    const mode = payload.mode === 'steer' ? 'steer' : 'queue'
    const content = Array.isArray(payload.content) ? payload.content : []

    if (!sessionId) {
      return errEnvelope(rpcId, 'session/not-found', 'payload.sessionId 缺失（面板未拿到当前主会话 ID）')
    }
    if (!hasText(content)) {
      return errEnvelope(rpcId, 'gateway/bad-request', 'prompt content 需要包含非空文本')
    }
    if (typeof controller?.prompt !== 'function') {
      return errEnvelope(rpcId, 'gateway/internal', 'sessionController.prompt 不可用（新线服务未就绪）')
    }

    try {
      const result = await controller.prompt({ requestId: rpcId, sessionId, mode, content })
      if (result && result.accepted === true) return okEnvelope(rpcId, { accepted: true })
      return errEnvelope(rpcId, 'session/agent-busy', `prompt 未被受理：${JSON.stringify(result)}`)
    } catch (error) {
      const code = error && typeof error.code === 'string' && error.code ? error.code : 'gateway/internal'
      const message = String((error && error.message) || error)
      return errEnvelope(rpcId, code, message)
    }
  }

  return {
    __apiproxyShim: { version: 1, line: '0.1.5+', target: 'sessionController.prompt' },
    sessions: { prompt }
  }
}

export function apply(ctx) {
  const controller = ctx.get('sessionController')
  const apiProxy = makeApiProxy(controller)
  ctx.provide('apiProxy', apiProxy)

  const message =
    '[dsh-apiproxy-shim] apiProxy 已注册：sessions.prompt → sessionController.prompt（新线兼容层）'
  try {
    if (ctx.logger?.info) ctx.logger.info(message)
    else console.log(message)
  } catch {
    /* 记录失败不影响服务注册 */
  }
}
