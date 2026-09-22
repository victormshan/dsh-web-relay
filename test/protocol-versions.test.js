// ccfeat-20260922-protoversion: 协议版本选择器接地回归。
// 断言：后端 PROTOCOL_VERSIONS_META 单一来源齐全且自洽；每个 contentKey 都能在模拟
// /context payload 里取到非空正文；前端 resolveProtocolVersion（真实实现，从 lib/client.js
// 提取执行，不是重写一份镜像）满足四条语义；反向用例证明旧世界缺陷确实存在、新世界已修复；
// 源码级断言前端不再有整串硬编码版本列表 / localStorage 白名单，且逐版本字面量比较 ≤2 次。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PROTOCOL_VERSIONS_META } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const clientSrc = fs.readFileSync(join(root, 'lib', 'client.js'), 'utf8')

// 从真实 lib/client.js 里跑出工厂函数拿到 module.exports.resolveProtocolVersion——
// 断言的是实际交付的实现，不是测试自己重写的一份镜像逻辑。
function loadClientExports() {
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (mod) => { captured = mod } } },
    console
  }
  vm.createContext(sandbox)
  vm.runInContext(clientSrc, sandbox, { filename: 'lib/client.js' })
  const fakeReact = {
    createElement: () => null,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v })
  }
  const fakeRequire = (name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require in client.js sandbox: ' + name)
  }
  return captured.factory(fakeRequire)
}

// ---------- 旧世界解析（缺陷本体，仅供反向验证——白名单只认 v1.6-v1.9，其余静默回落 v1.5） ----------
const legacyResolve = (stored) =>
  (stored === 'v1.6' || stored === 'v1.7' || stored === 'v1.8' || stored === 'v1.9') ? stored : 'v1.5'

test('① 元数据六版齐全、version 唯一、并发档恰为 v1.6-v2.0（v1.5 非并发）', () => {
  assert.equal(PROTOCOL_VERSIONS_META.length, 6, '应覆盖 v1.5..v2.0 共六版')
  const versions = PROTOCOL_VERSIONS_META.map((m) => m.version)
  assert.deepEqual(versions, ['v1.5', 'v1.6', 'v1.7', 'v1.8', 'v1.9', 'v2.0'], '版本顺序应从旧到新')
  assert.equal(new Set(versions).size, versions.length, 'version 不得重复')
  for (const m of PROTOCOL_VERSIONS_META) {
    assert.ok(m.contentKey && typeof m.contentKey === 'string', `${m.version} 应有 contentKey`)
    assert.ok(m.label && typeof m.label === 'string', `${m.version} 应有 label`)
  }
  const concurrent = PROTOCOL_VERSIONS_META.filter((m) => m.concurrent).map((m) => m.version)
  assert.deepEqual(concurrent, ['v1.6', 'v1.7', 'v1.8', 'v1.9', 'v2.0'], '并发档应恰为 v1.6-v2.0')
  assert.equal(PROTOCOL_VERSIONS_META.find((m) => m.version === 'v1.5').concurrent, false, 'v1.5 非并发')
})

test('② 元数据每个 contentKey 都能在一个模拟的 /context payload 里取到非空正文', () => {
  // 模拟 lib/index.js contextHandler 实际下发的形状：顶层按 contentKey 挂 { version, text, skill }
  const mockContext = {
    ok: true,
    protocolVersions: PROTOCOL_VERSIONS_META
  }
  for (const m of PROTOCOL_VERSIONS_META) {
    mockContext[m.contentKey] = { version: m.version, text: `协议 ${m.version} 正文占位`, skill: { text: 'skill' } }
  }
  for (const m of PROTOCOL_VERSIONS_META) {
    const entry = mockContext[m.contentKey]
    assert.ok(entry, `contentKey ${m.contentKey}（${m.version}）应在 /context payload 中存在`)
    assert.ok(entry.text && entry.text.length > 0, `${m.contentKey} 正文不得为空`)
  }
})

test('③ resolveProtocolVersion（真实实现）四条语义：命中 / 未命中 / 缺失 / meta 空', () => {
  const exportsObj = loadClientExports()
  assert.equal(typeof exportsObj.resolveProtocolVersion, 'function', '应挂在 client 工厂导出的出口上')
  const resolveProtocolVersion = exportsObj.resolveProtocolVersion

  assert.equal(resolveProtocolVersion('v2.0', PROTOCOL_VERSIONS_META), 'v2.0', '命中元数据 → 返回该 version')
  assert.equal(resolveProtocolVersion('v9.9', PROTOCOL_VERSIONS_META), PROTOCOL_VERSIONS_META[0].version, '未命中 → 回落元数据首项')
  assert.equal(resolveProtocolVersion(undefined, PROTOCOL_VERSIONS_META), PROTOCOL_VERSIONS_META[0].version, '缺失 → 回落元数据首项')
  assert.equal(resolveProtocolVersion('v2.0', []), null, 'meta 为空 → 返回 null')

  // 不得硬编码 'v1.5' 作为回落值：换一份首项不是 v1.5 的元数据，回落也应跟着变。
  const altMeta = [{ version: 'vA', contentKey: 'a' }, { version: 'vB', contentKey: 'b' }]
  assert.equal(resolveProtocolVersion('unknown', altMeta), 'vA', '回落目标应取决于元数据首项，而非硬编码 v1.5')
})

test('④ 反向用例：旧世界白名单确实把 v2.0 判为不可用；新世界给出 v2.0', () => {
  assert.equal(legacyResolve('v2.0'), 'v1.5', '缺陷复现：旧白名单把活的 v2.0 静默降级为 v1.5')
  const exportsObj = loadClientExports()
  assert.equal(exportsObj.resolveProtocolVersion('v2.0', PROTOCOL_VERSIONS_META), 'v2.0', '新逻辑保持 v2.0')
  assert.equal(PROTOCOL_VERSIONS_META.find((m) => m.version === 'v2.0').concurrent, true, 'v2.0 并发语义为真')
})

test('⑤ 源码级：client.js 不再含整串硬编码版本列表 / localStorage 白名单，且逐版本比较 ≤2 次', () => {
  const legacyOptionList = /'v1\.5'[\s\S]{0,400}'v1\.9'/.test(clientSrc)
  assert.equal(legacyOptionList, false, '不得再出现旧世界整串版本下拉列表的机器签名')

  const legacyWhitelist = /===\s*'v1\.6'[\s\S]{0,120}'v1\.9'/.test(clientSrc)
  assert.equal(legacyWhitelist, false, '不得再有 localStorage 版本白名单（静默回落源头）')

  const branchMatches = clientSrc.match(/protocolVersion\s*===\s*'v1\.\d'/g) || []
  assert.ok(branchMatches.length <= 2, `protocolVersion === 'v1.x' 比较应 ≤2 次，实际 ${branchMatches.length} 次`)

  assert.match(clientSrc, /protocolVersions/, '前端应引用 protocolVersions 元数据')
  assert.match(clientSrc, /contentKey/, '前端正文取值应走 contentKey 映射')
})

test('⑥ isConcurrent 别名：每项存在且与 concurrent 同值（两者并存，不得只留其一）', () => {
  assert.equal(PROTOCOL_VERSIONS_META.length, 6)
  for (const m of PROTOCOL_VERSIONS_META) {
    assert.equal(typeof m.isConcurrent, 'boolean', `${m.version} 应有布尔 isConcurrent`)
    assert.equal(typeof m.concurrent, 'boolean', `${m.version} 应保留布尔 concurrent（前端仍按此消费）`)
    assert.equal(m.isConcurrent, m.concurrent, `${m.version} isConcurrent 必须与 concurrent 同值`)
  }
})

// 从真实 lib/index.js 里跑出 protocolVersionsHandler 本体（不是测试重写一份镜像逻辑）：
// 只读端点必须直接返回 PROTOCOL_VERSIONS_META 这一份常量，禁止在 handler 内重建数组。
const indexSrcForHandler = fs.readFileSync(join(root, 'lib', 'index.js'), 'utf8')

function loadProtocolVersionsHandler() {
  const m = indexSrcForHandler.match(/const protocolVersionsHandler = \(req, res\) => \{\n([\s\S]*?)\n  \}\n/)
  assert.ok(m, 'lib/index.js 应定义 protocolVersionsHandler')
  const body = m[1]
  // eslint-disable-next-line no-new-func
  return new Function('req', 'res', 'CORS', 'PROTOCOL_VERSIONS_META', 'json', body)
}

test('⑦ GET /dsh-web-relay/protocol/versions：路由已注册，OPTIONS 返回 204 + 既有 CORS 头', () => {
  assert.match(
    indexSrcForHandler,
    /webServer\.register\(\{ kind: 'exact', path: '\/dsh-web-relay\/protocol\/versions', handler: protocolVersionsHandler \}\)/,
    '应以 exact 路由注册 /dsh-web-relay/protocol/versions'
  )
  const CORS_MOCK = { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
  const handler = loadProtocolVersionsHandler()
  let written = null
  const res = { writeHead: (code, headers) => { written = { code, headers }; return res }, end: () => res }
  handler({ method: 'OPTIONS' }, res, CORS_MOCK, PROTOCOL_VERSIONS_META, () => { throw new Error('OPTIONS 不应调用 json()') })
  assert.deepEqual(written, { code: 204, headers: CORS_MOCK }, 'OPTIONS 应 204 + 既有只读端点同款 CORS 头')
})

test('⑧ /protocol/versions 直接复用 PROTOCOL_VERSIONS_META（同一份来源，非重建）：6 项且与 /context 顺序一致', () => {
  const handler = loadProtocolVersionsHandler()
  let jsonCall = null
  const res = {}
  handler({ method: 'GET' }, res, {}, PROTOCOL_VERSIONS_META, (r, code, payload) => { jsonCall = { res: r, code, payload } })
  assert.ok(jsonCall, 'GET 应调用 json() 输出响应')
  assert.equal(jsonCall.code, 200)
  assert.equal(jsonCall.res, res)
  assert.equal(jsonCall.payload.ok, true)
  // 身份相等：handler 传给 json() 的 versions 就是同一个 PROTOCOL_VERSIONS_META 引用，
  // 不是 handler 内另起的一份拷贝/重排——因此天然与 /context.protocolVersions 顺序一致。
  assert.equal(jsonCall.payload.versions, PROTOCOL_VERSIONS_META, 'versions 必须是同一个数组引用（禁止重建）')
  assert.equal(jsonCall.payload.versions.length, 6)
  assert.deepEqual(
    jsonCall.payload.versions.map((v) => v.version),
    ['v1.5', 'v1.6', 'v1.7', 'v1.8', 'v1.9', 'v2.0'],
    '应与 /context.protocolVersions（同一份 PROTOCOL_VERSIONS_META）顺序一致'
  )
})

test('回归：既有用例锚点——client.js 仍导出 resolveProtocolVersion，且 index.js isConcurrent 改读元数据（无手写版本链）', () => {
  const indexSrc = fs.readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  assert.match(indexSrc, /PROTOCOL_VERSIONS_META/, 'lib/index.js 应定义 PROTOCOL_VERSIONS_META')
  assert.doesNotMatch(
    indexSrc,
    /const isConcurrent = \(v\) => v === 'v1\.6' \|\| v === 'v1\.7'/,
    'isConcurrent 不得再手写 v1.6||v1.7||... 字面量链'
  )
  assert.match(clientSrc, /exports\.resolveProtocolVersion = resolveProtocolVersion/, 'resolveProtocolVersion 应挂在工厂导出出口上')
})
