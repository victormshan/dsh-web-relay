// dsh-apiproxy-shim 自测：不依赖 cordis，用 mock controller 验证信封契约。
// 运行：node test/selftest.mjs
import assert from 'node:assert/strict'
import { makeApiProxy } from '../lib/index.js'

const calls = []
const mockController = {
  async prompt(request) {
    calls.push(request)
    if (request.sessionId === 'busy') return { accepted: false }
    if (request.sessionId === 'throw') {
      const err = new Error('no adapter serves provider "claude"')
      err.code = 'session/model-unavailable'
      throw err
    }
    return { accepted: true }
  }
}

const api = makeApiProxy(mockController)
const text = (t) => [{ type: 'text', text: t }]

// 1. 成功路径（relay 的真实形状：rpcId 在顶层，payload 内 sessionId/mode/content）
{
  const resp = await api.sessions.prompt({
    rpcId: 'rpc-1',
    payload: { sessionId: 's1', mode: 'queue', content: text('handoff') }
  })
  assert.equal(resp.rpcId, 'rpc-1')
  assert.equal(resp.result.ok, true)
  assert.deepEqual(calls.at(-1), {
    requestId: 'rpc-1',
    sessionId: 's1',
    mode: 'queue',
    content: text('handoff')
  })
}

// 2. mode 缺省 / 非法值 → 归一化为 queue
{
  await api.sessions.prompt({ rpcId: 'rpc-2', payload: { sessionId: 's1', content: text('x') } })
  assert.equal(calls.at(-1).mode, 'queue')
  await api.sessions.prompt({ rpcId: 'rpc-3', payload: { sessionId: 's1', mode: 'weird', content: text('x') } })
  assert.equal(calls.at(-1).mode, 'queue')
  await api.sessions.prompt({ rpcId: 'rpc-4', payload: { sessionId: 's1', mode: 'steer', content: text('x') } })
  assert.equal(calls.at(-1).mode, 'steer')
}

// 3. 缺少 sessionId → session/not-found，且不触达 controller
{
  const before = calls.length
  const resp = await api.sessions.prompt({ rpcId: 'rpc-5', payload: { content: text('x') } })
  assert.equal(resp.result.ok, false)
  assert.equal(resp.result.error.code, 'session/not-found')
  assert.equal(calls.length, before)
}

// 4. 空白 content → gateway/bad-request
{
  const resp = await api.sessions.prompt({ rpcId: 'rpc-6', payload: { sessionId: 's1', content: text('   ') } })
  assert.equal(resp.result.error.code, 'gateway/bad-request')
}

// 5. controller 抛 RemoteError → 原样透出 code/message
{
  const resp = await api.sessions.prompt({ rpcId: 'rpc-7', payload: { sessionId: 'throw', content: text('x') } })
  assert.equal(resp.result.ok, false)
  assert.equal(resp.result.error.code, 'session/model-unavailable')
  assert.match(resp.result.error.message, /no adapter serves provider/)
}

// 6. 未被受理 → session/agent-busy
{
  const resp = await api.sessions.prompt({ rpcId: 'rpc-8', payload: { sessionId: 'busy', content: text('x') } })
  assert.equal(resp.result.ok, false)
  assert.equal(resp.result.error.code, 'session/agent-busy')
}

// 7. 缺 rpcId → 自动补一个，信封仍完整
{
  const resp = await api.sessions.prompt({ payload: { sessionId: 's1', content: text('x') } })
  assert.equal(typeof resp.rpcId, 'string')
  assert.equal(resp.result.ok, true)
}

// 8. controller 缺失 → 明确报错而不是崩
{
  const broken = makeApiProxy(undefined)
  const resp = await broken.sessions.prompt({ rpcId: 'rpc-9', payload: { sessionId: 's1', content: text('x') } })
  assert.equal(resp.result.error.code, 'gateway/internal')
}

console.log(`dsh-apiproxy-shim selftest: 8/8 passed (controller calls: ${calls.length})`)
