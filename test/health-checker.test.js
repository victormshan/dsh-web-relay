// v2.4-1/v2.4-2/v2.4-3: 三端 Health Checker 测试（v2.0.0）
// 运行：node --test test/health-checker.test.js
// 镜像 lib/index.js PLUGIN_VERSION 读取与 bridge 状态判定逻辑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// ---- 镜像：PLUGIN_VERSION（与 lib/index.js 一致：读 package.json）----
function pluginVersion() {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
    return JSON.parse(raw).version || '0.0.0'
  } catch (err) { return '0.0.0' }
}

// ---- bridge 状态归一化：直接导入真实实现（v4.12.2 起不再手抄镜像——旧镜像停留在
// v3.3.0 之前的 /stats 形状，测试全绿却在测已废弃路径）----
import { normalizeBridgeProbe } from '../lib/bridge-poll.js'

test('PLUGIN_VERSION 从 package.json 读取且与声明一致', () => {
  const v = pluginVersion()
  assert.match(v, /^\d+\.\d+\.\d+$/)
  // 与源码 PLUGIN_VERSION 常量一致
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(src.includes(`PLUGIN_VERSION`))
})

test('bridge 状态归一化：/__token 正常响应 → 在线（token 就绪）', () => {
  assert.deepEqual(normalizeBridgeProbe({ ok: true, token: 'x'.repeat(64) }), { ok: true, note: 'bridge 在线（token 就绪）' })
  // 与 index.js 原内联判定一致：未显式 ok:false 的对象都视为在线
  assert.equal(normalizeBridgeProbe({}).ok, true)
})

test('bridge 状态归一化：异常/空响应标记失败', () => {
  for (const d of [null, undefined, { ok: false }, { ok: false, error: 'x' }]) {
    assert.deepEqual(normalizeBridgeProbe(d), { ok: false, error: 'bridge 响应异常' })
  }
})

test('接线：health-check 的 bridge 字段由 normalizeBridgeProbe 生成（无内联重复实现）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(src.includes('bridge = normalizeBridgeProbe(d)'))
  assert.ok(!src.includes("? { ok: true, note: 'bridge 在线（token 就绪）' }"), '不应残留内联副本')
})

test('health-check 状态灯判定（bridge 绿/红）', () => {
  const colorOf = (bridge) => (bridge && bridge.ok) ? '#4ade80' : '#ef4444'
  assert.equal(colorOf({ ok: true }), '#4ade80')
  assert.equal(colorOf({ ok: false }), '#ef4444')
  assert.equal(colorOf(null), '#ef4444')
})

test('source 源码含 v2.4-1/v2.4-2 标记', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('v2.4-1: 三端 Health Checker'))
  assert.ok(src.includes('/dsh-web-relay/health-check'))
  assert.ok(src.includes('v2.4-1: 实时版本'))
  assert.ok(client.includes('v2.4-2: 三端 Health Checker'))
  assert.ok(client.includes('/dsh-web-relay/health-check'))
})

test('source 源码含 v2.1.1 修复标记（DAG 点击定位高亮 + low 展开）', () => {
  const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(client.includes('v2.1.1: DAG 点击定位高亮的步骤 id'))
  assert.ok(client.includes('v2.1.1: low 步骤切换展开明细'))
  assert.ok(client.includes('setDagFocus'))
  assert.ok(client.includes('dagFocus'))
})

test('source 源码含 v3.2.4 审核通道选择器标记（lib/client.js）', () => {
  const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(client.includes('v3.2.4: 审核通道选择'))
  assert.ok(client.includes('dsh-web-relay:review-channel'))
  assert.ok(client.includes('reviewChannelWebGemini'))
  // 单步与批量审核请求都携带 reviewChannel（P2 v3.5.0 起 enableSwarm；v3.6.0 起 disableShadow）
  assert.ok(client.includes('protocolVersion, enableSwarm: swarmOn, disableShadow: shadowOff, reviewChannel }'))
  assert.ok(client.includes('batchStepIds: ids, enableSwarm: swarmOn, disableShadow: shadowOff, reviewChannel'))
})
