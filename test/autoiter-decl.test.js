// v3.3.2: extractAutoIterDecl 叙述式/中文声明解析修复测试（镜像函数，运行：node --test test/autoiter-decl.test.js）
// 背景：expr-2026-09-03_01-27-21 外部 AI 将声明写在叙述文本（"（配置：iterations: 3, autoDecision: true）"），
// 旧逻辑仅认严格 JSON 块 → stepState 落为 iterations:1/autoDecision:false（声称自动迭代未生效）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ---- 镜像：lib/index.js extractAutoIterDecl（v3.3.2 修复后）----
function extractAutoIterDecl(text) {
  const src = String(text || '')
  const decl = { iterations: 1, finalAcceptance: null, autoDecision: false }
  const clamp = (n) => (Number.isInteger(n) && n >= 1 && n <= 10 ? n : null)
  // 1) 严格 JSON 片段（协议推荐形态）
  const m = src.match(/\{\s*"iterations"\s*:\s*(\d+)\s*(?:,\s*"finalAcceptance"\s*:\s*"([^"]*)"\s*)?(?:,\s*"autoDecision"\s*:\s*(true|false)\s*)?\}/)
  if (m) {
    const n = clamp(parseInt(m[1], 10))
    if (n) decl.iterations = n
    if (m[2]) decl.finalAcceptance = m[2]
    if (m[3]) decl.autoDecision = m[3] === 'true'
    return decl
  }
  // 2) 叙述式声明兜底
  const n2 = src.match(/\biterations\s*[:：]\s*(\d+)/i)
  const ni = n2 && clamp(parseInt(n2[1], 10))
  if (!ni) {
    const mC = src.match(/(?:自动迭代|自动演进|迭代)\s*[:：]?\s*(\d{1,2})\s*(?:个|次|轮)?版本/)
    if (mC) { const n3 = clamp(parseInt(mC[1], 10)); if (n3) decl.iterations = n3 }
  } else decl.iterations = ni
  const ma = src.match(/autoDecision\s*[:：]\s*(true|false)/i)
  if (ma) decl.autoDecision = ma[1].toLowerCase() === 'true'
  const mf = src.match(/finalAcceptance\s*[:：]\s*["'“”‘’]([^"'“”‘’]+)["'“”‘’]/)
  if (mf) decl.finalAcceptance = mf[1]
  return decl
}

test('叙述式声明（expr-2026-09-03_01-27-21 实际形态）：iterations=3 / autoDecision=true', () => {
  const src = '对本插件自动迭代3个版本\n\n已开启 AutoIteration（配置：`iterations: 3`, `autoDecision: true`），将通过 V1/V2/V3 递进演进。'
  assert.deepEqual(extractAutoIterDecl(src), { iterations: 3, finalAcceptance: null, autoDecision: true })
})

test('中文 prompt「自动迭代3个版本」：iterations=3（autoDecision 缺省 false）', () => {
  assert.deepEqual(extractAutoIterDecl('对本插件自动迭代3个版本'), { iterations: 3, finalAcceptance: null, autoDecision: false })
})

test('严格 JSON 声明块仍优先命中（含 finalAcceptance）', () => {
  const src = '{"iterations": 2, "finalAcceptance": "E2E 全过", "autoDecision": true}'
  assert.deepEqual(extractAutoIterDecl(src), { iterations: 2, finalAcceptance: 'E2E 全过', autoDecision: true })
})

test('无声明文本 → 默认单轮向后兼容', () => {
  assert.deepEqual(extractAutoIterDecl('随便聊聊'), { iterations: 1, finalAcceptance: null, autoDecision: false })
})

test('「自动演进 5 次版本」语义命中 iterations=5', () => {
  assert.equal(extractAutoIterDecl('请对本插件自动演进 5 次版本').iterations, 5)
})

test('防误报：叙述含「版本迭代过程中」无数字 → 不命中', () => {
  assert.equal(extractAutoIterDecl('在版本迭代过程中增加功能').iterations, 1)
})

test('防误报：多轮迭代 3 个步骤（无“版本”计数）→ 不命中', () => {
  assert.equal(extractAutoIterDecl('对步骤做多轮迭代 3 个步骤的检查').iterations, 1)
})

test('越界保护：iterations 超过 10 按 1 处理', () => {
  assert.equal(extractAutoIterDecl('自动迭代 99 个版本').iterations, 1)
})

// ---------------------------------------------------------------------------
// v1-2: AutoIteration 声明契约完整性（半状态可见化）+ 机器生成能力清单 + 受控声明补全
// 以下测试直接 import 真实模块（lib/autoiter-decl.js），全部使用注入的 fake fs / 纯字符串入参，
// 不读写真实工作区外的路径、不发网络请求。
// ---------------------------------------------------------------------------
import {
  extractAutoIterDecl as extractAutoIterDeclReal,
  assessAutoIterDecl,
  generateCapabilitiesList,
  computeAutoIterDeclareUpdate
} from '../lib/autoiter-decl.js'

test('assessAutoIterDecl：iterations=3 + autoDecision=false → halfState:true，hint 含严格块示例', () => {
  const r = assessAutoIterDecl({ iterations: 3, autoDecision: false, finalAcceptance: null })
  assert.equal(r.halfState, true)
  assert.equal(r.complete, false)
  assert.ok(Array.isArray(r.reasons) && r.reasons.length > 0)
  assert.ok(typeof r.hint === 'string' && r.hint.includes('"iterations"') && r.hint.includes('autoDecision'))
})

test('assessAutoIterDecl：iterations=3 + autoDecision=true → 非半状态', () => {
  const r = assessAutoIterDecl({ iterations: 3, autoDecision: true, finalAcceptance: 'E2E 全过' })
  assert.deepEqual(r, { complete: true, halfState: false, reasons: [], hint: null })
})

test('assessAutoIterDecl：iterations=1 + autoDecision=false → 非半状态（单轮属正常）', () => {
  const r = assessAutoIterDecl({ iterations: 1, autoDecision: false, finalAcceptance: null })
  assert.deepEqual(r, { complete: true, halfState: false, reasons: [], hint: null })
})

test('assessAutoIterDecl：畸形入参（null / 字符串 / iterations 类型错）→ complete:false 且不抛错', () => {
  for (const bad of [null, undefined, 'x', 42, [], { iterations: '3', autoDecision: false }, { iterations: 3, autoDecision: 'true' }]) {
    assert.doesNotThrow(() => assessAutoIterDecl(bad))
    const r = assessAutoIterDecl(bad)
    assert.deepEqual(r, { complete: false, halfState: false, reasons: ['invalid-decl'], hint: null })
  }
})

test('严格块优先（真实模块 extractAutoIterDecl）：同一文本同时含叙述式与严格块 → 以严格块为准', () => {
  const src = '对本插件自动迭代5个版本，正式声明：{"iterations": 2, "autoDecision": true, "finalAcceptance": "E2E"}'
  assert.deepEqual(extractAutoIterDeclReal(src), { iterations: 2, finalAcceptance: 'E2E', autoDecision: true })
})

test('generateCapabilitiesList：正常 registry（fake fs）生成非空清单，含 registry 条目与 lib 导出，过滤 deprecated，≤2000 字符', () => {
  const fakeFs = {
    readdirSync: (dir) => (String(dir).endsWith('lib') ? ['mod-a.js', 'mod-b.mjs', 'skip.txt'] : []),
    readFileSync: (file) => {
      const f = String(file)
      if (f.endsWith('registry.yaml')) {
        return [
          '- id: foo-cap',
          '  name: Foo 能力',
          '  status: approved',
          '- id: bar-cap',
          '  name: Bar 能力（已废弃）',
          '  status: deprecated'
        ].join('\n')
      }
      if (f.endsWith('mod-a.js')) return 'export function alpha() {}\nexport const beta = 1\n'
      if (f.endsWith('mod-b.mjs')) return 'export class Gamma {}\n'
      throw new Error('ENOENT: ' + f)
    }
  }
  const list = generateCapabilitiesList({ repoRoot: '/fake/repo', fsImpl: fakeFs })
  assert.ok(list.length > 0)
  assert.ok(list.includes('foo-cap'))
  assert.ok(!list.includes('bar-cap'), 'deprecated 条目应被过滤')
  assert.ok(list.includes('mod-a.js'))
  assert.ok(list.length <= 2000)
})

test('generateCapabilitiesList：registry 缺失时优雅退化（仍返回 lib 导出部分），不抛错', () => {
  const fakeFs = {
    readdirSync: (dir) => (String(dir).endsWith('lib') ? ['mod-a.js'] : []),
    readFileSync: (file) => {
      const f = String(file)
      if (f.endsWith('registry.yaml')) throw new Error('ENOENT')
      if (f.endsWith('mod-a.js')) return 'export function alpha() {}\n'
      throw new Error('ENOENT: ' + f)
    }
  }
  assert.doesNotThrow(() => generateCapabilitiesList({ repoRoot: '/fake/repo', fsImpl: fakeFs }))
  const list = generateCapabilitiesList({ repoRoot: '/fake/repo', fsImpl: fakeFs })
  assert.ok(list.includes('mod-a.js'))
  assert.ok(!list.includes('registry.yaml'))
})

test('generateCapabilitiesList：registry 与 lib 均不可读 → 返回空字符串，不抛错', () => {
  const fakeFs = {
    readdirSync: () => { throw new Error('ENOENT') },
    readFileSync: () => { throw new Error('ENOENT') }
  }
  assert.doesNotThrow(() => generateCapabilitiesList({ repoRoot: '/fake/repo', fsImpl: fakeFs }))
  assert.equal(generateCapabilitiesList({ repoRoot: '/fake/repo', fsImpl: fakeFs }), '')
})

test('computeAutoIterDeclareUpdate：合法声明生效，留痕文本含前后值', () => {
  const cur = { iterations: 1, finalAcceptance: null, autoDecision: false }
  const r = computeAutoIterDeclareUpdate(cur, { iterations: 3, finalAcceptance: 'E2E 全过', autoDecision: true, reason: '外部AI补充严格声明' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.after, { iterations: 3, autoDecision: true, finalAcceptance: 'E2E 全过' })
  assert.ok(r.traceText.includes('iterations 1→3'))
  assert.ok(r.traceText.includes('autoDecision false→true'))
  assert.ok(r.traceText.includes('外部AI补充严格声明'))
})

test('computeAutoIterDeclareUpdate：非法 iterations（0 / 11 / 字符串）被拒，不产出 after', () => {
  const cur = { iterations: 2, finalAcceptance: 'x', autoDecision: true }
  for (const bad of [0, 11, '3']) {
    const r = computeAutoIterDeclareUpdate(cur, { iterations: bad })
    assert.equal(r.ok, false)
    assert.ok(typeof r.error === 'string' && r.error.length > 0)
    assert.ok(!('after' in r))
  }
})

test('computeAutoIterDeclareUpdate：未携带 autoDecision 时既有 true 不回退', () => {
  const cur = { iterations: 3, finalAcceptance: 'x', autoDecision: true }
  const r = computeAutoIterDeclareUpdate(cur, { iterations: 4 })
  assert.equal(r.ok, true)
  assert.equal(r.after.autoDecision, true)
})

// source 标记：确认 lib/index.js 侧的接线未回归为「只写文档没进外呼 payload」
import fs from 'node:fs'

test('source 标记：/ask 的 gemini-free 与 web-gemini guidedPrompt 均注入能力清单 + 严格声明样例（lib/index.js v1-2）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(src.includes('AUTO_ITER_STRICT_DECL_BLOCK = renderStrictDeclExample()'))
  assert.ok(src.includes('AUTO_ITER_CAPABILITIES_LIST = (() => {'))
  // 两处 guidedPrompt 组装都含注入（gemini-free 分支 + web-gemini 分支）
  const hits = src.split('AUTO_ITER_STRICT_DECL_BLOCK,').length - 1
  assert.ok(hits >= 2, `期望至少 2 处 guidedPrompt 注入 AUTO_ITER_STRICT_DECL_BLOCK，实测 ${hits} 处`)
  assert.ok(src.includes('AUTO_ITER_CAPABILITIES_LIST\n        ].join'))
})

test('source 标记：/ask 半状态可见化（console.warn + 响应体 autoIterDecl + steps.json autoIterDeclAudit）（lib/index.js v1-2）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(src.includes('askAutoIterDecl = assessAutoIterDecl('))
  assert.ok(src.includes('AutoIteration 声明不完整:'))
  assert.ok(src.includes('autoIterDecl: askAutoIterDecl'))
  assert.ok(src.includes('autoIterDeclAudit: askAutoIterDecl'))
  assert.ok(src.includes('autoIterDeclAudit: state.autoIterDeclAudit || null'))
  assert.ok(src.includes('autoIterDeclAudit: data.autoIterDeclAudit || null'))
})

test('source 标记：/dsh-web-relay/steps/declare 路由已注册且响应契约字段完整（lib/index.js v1-2）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(src.includes("'/dsh-web-relay/steps/declare'"))
  assert.ok(src.includes('stepsDeclareHandler'))
  assert.ok(src.includes('json(res, 200, { ok: true, stepState: updated, autoIterDecl })'))
  assert.ok(src.includes('computeAutoIterDeclareUpdate('))
})
