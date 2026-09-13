// dsh-apiproxy-shim — 新线(harness 0.1.5+)兼容层（Host half，cordis 静态插件）。
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
//   （super(ctx,"sessionController",{namespace:"session"})），其 prompt(request[,signal])
//   成功返回 { accepted: true }，失败抛 RemoteError(code, message)。
//
// 依赖服务（已逐一在新线确认同名存在）
//   sessionController ← @deepseek-ai/dsh-api-session-controller（本 shim 硬注入）
//   webServer/fs/llm/agentDefaultModel/sandboxPolicy ← 新线各包 super(ctx, ...) 提供
//
// v0.2.0（2026-09-13 现场排障：面板唤醒报 "reading 'throwIfAborted'"）：
//   * 新线 typert gateway 调用 Remote 方法时，若方法声明最后一个形参名为 `signal`，
//     会自动补 AbortSignal（dsh-api-gateway/lib/index.js L397 + L746：
//     `if (descriptor.cancellation !== void 0) args.push(request.signal ?? NEVER_ABORTED_SIGNAL)`）。
//     直连服务（不经 gateway）时必须自己补，否则下游对 undefined signal 调
//     `.throwIfAborted()` → TypeError: Cannot read properties of undefined (reading 'throwIfAborted')。
//     本版按 `controller.prompt.length` 自适应补参（>=2 补永不 abort 的 signal）。
//   * 失败时在 message 尾部追加诊断（声明元数 + 栈帧前 4 行），便于现场定位。
// ===========================================================================

import { randomUUID } from 'node:crypto'

export const name = 'dsh-apiproxy-shim'
export const inject = ['sessionController']

const NEVER_ABORTED = new AbortController().signal

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

function diagnose(error, declaredArity) {
  const head = String((error && error.message) || error)
  const frames = (error && typeof error.stack === 'string' ? error.stack.split('\n').slice(1, 5) : [])
    .map((l) => l.trim().replace(/^at\s+/, ''))
  return [`[shim: prompt.length=${declaredArity}${declaredArity >= 2 ? ' (signal appended)' : ''}]`, ...frames, head]
    .filter(Boolean)
    .join(' | ')
}

/**
 * 用给定的 sessionController 构造 apiProxy 兼容对象。
 * 抽成工厂函数是为了能在 cordis 之外做单元自测（见 test/selftest.mjs）。
 * @param controller 新线宿主服务 sessionController（需具备 prompt(request[, signal])）
 */
export function makeApiProxy(controller) {
  const declaredArity = typeof controller?.prompt === 'function' ? controller.prompt.length : -1

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

    const args = [{ requestId: rpcId, sessionId, mode, content }]
    if (declaredArity >= 2) args.push(NEVER_ABORTED) // 对齐 gateway 的 signal 补参
    if (declaredArity >= 3) args.push(undefined)

    try {
      const result = await controller.prompt(...args)
      if (result && result.accepted === true) return okEnvelope(rpcId, { accepted: true })
      return errEnvelope(rpcId, 'session/agent-busy', `prompt 未被受理：${JSON.stringify(result)}`)
    } catch (error) {
      const code = error && typeof error.code === 'string' && error.code ? error.code : 'gateway/internal'
      return errEnvelope(rpcId, code, diagnose(error, declaredArity))
    }
  }

  return {
    __apiproxyShim: { version: 2, line: '0.1.5+', target: 'sessionController.prompt', declaredArity },
    sessions: { prompt }
  }
}

export function apply(ctx) {
  const controller = ctx.get('sessionController')
  const apiProxy = makeApiProxy(controller)
  ctx.provide('apiProxy', apiProxy)

  const message =
    '[dsh-apiproxy-shim v0.2.0] apiProxy 已注册：sessions.prompt → sessionController.prompt' +
    `（新线兼容层；prompt.length=${apiProxy.__apiproxyShim.declaredArity}）`
  try {
    if (ctx.logger?.info) ctx.logger.info(message)
    else console.log(message)
  } catch {
    /* 记录失败不影响服务注册 */
  }
}
