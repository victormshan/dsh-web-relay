// v4.9.7 shim 回归测试。
// 背景（lesson L-2026-0914-058）：新线 typert Remote 方法的尾参 signal 由 gateway 注入
// （dsh-api-gateway L397 NEVER_ABORTED_SIGNAL + L746 args.push(request.signal ?? NEVER_ABORTED_SIGNAL)）。
// 绕过 gateway 直连服务（本 shim 就是直连 sessionController）时必须自己补，否则
// `SessionController.prompt(request, signal)` 里的 `signal.throwIfAborted()` 抛
// TypeError: Cannot read properties of undefined (reading 'throwIfAborted')。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { makeApiProxy } from '../shim/dsh-apiproxy-shim/lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const shimSrc = readFileSync(join(__dirname, '..', 'shim', 'dsh-apiproxy-shim', 'lib', 'index.js'), 'utf8')
const text = (t) => [{ type: 'text', text: t }]

test('shim v0.2.0: 两参 prompt（新线契约）必须收到永不 abort 的 signal', async () => {
  let seenSignal = null
  const controller = {
    async prompt(request, signal) {
      seenSignal = signal
      return { accepted: true }
    }
  }
  const api = makeApiProxy(controller)
  assert.equal(api.__apiproxyShim.declaredArity, 2, '应识别出 prompt 声明两参')
  const resp = await api.sessions.prompt({ rpcId: 'r1', payload: { sessionId: 's1', content: text('x') } })
  assert.equal(resp.result.ok, true)
  assert.equal(typeof seenSignal?.throwIfAborted, 'function', 'signal 必须是真实 AbortSignal')
  assert.equal(seenSignal.aborted, false, 'signal 必须永不 abort')
})

test('shim v0.2.0: 源码级接线——按声明元数自适应补参（防漏参回归）', () => {
  assert.match(shimSrc, /controller\?\.prompt === 'function' \? controller\.prompt\.length/, '应按 prompt.length 判定声明元数')
  assert.match(shimSrc, /if \(declaredArity >= 2\) args\.push\(NEVER_ABORTED\)/, 'declaredArity>=2 必须补 signal')
  assert.match(shimSrc, /new AbortController\(\)\.signal/, '应使用永不 abort 的 signal（对齐 gateway NEVER_ABORTED_SIGNAL）')
})

test('shim v0.2.0: 失败信封保留错误码并附诊断（prompt.length + 栈帧）', async () => {
  const controller = {
    async prompt() {
      throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
    }
  }
  const api = makeApiProxy(controller)
  const resp = await api.sessions.prompt({ rpcId: 'r2', payload: { sessionId: 's1', content: text('x') } })
  assert.equal(resp.result.ok, false)
  assert.equal(resp.result.error.code, 'gateway/internal', '无 code 的普通错误回落 gateway/internal')
  assert.match(resp.result.error.message, /shim: prompt\.length=\d/, '诊断应含声明元数')
  assert.match(resp.result.error.message, /throwIfAborted/, '诊断应含原始错误信息')
})

test('shim v0.2.0: manifest 版本锚点与代码 banner 一致', async () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', 'shim', 'dsh-apiproxy-shim', 'package.json'), 'utf8')
  )
  assert.equal(pkg.version, '0.2.0', 'shim package.json 版本应为 0.2.0')
  assert.match(shimSrc, /dsh-apiproxy-shim v0\.2\.0/, 'banner 版本应与 manifest 一致')
})
