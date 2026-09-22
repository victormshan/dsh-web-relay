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
  computeAutoIterDeclareUpdate,
  buildAutoIterDeclAudit,
  detectAskBodyDeclConflict
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

// ---------------------------------------------------------------------------
// v4.11.0 步9: /ask body 显式声明与文本声明冲突 → 显式拒绝（不合并、不静默忽略）
// ---------------------------------------------------------------------------
test('detectAskBodyDeclConflict：body 不带 iterations/finalAcceptance/autoDecision 任一字段 → 不冲突（向后兼容，行为与此前完全一致）', () => {
  const textDecl = { iterations: 1, finalAcceptance: null, autoDecision: false }
  assert.deepEqual(detectAskBodyDeclConflict({}, textDecl), { conflict: false })
  assert.deepEqual(detectAskBodyDeclConflict({ provider: 'manual', prompt: 'x' }, textDecl), { conflict: false })
})

test('detectAskBodyDeclConflict：body 与文本解析结果一致 → 不冲突（通过）', () => {
  const textDecl = { iterations: 3, finalAcceptance: 'E2E 全过', autoDecision: true }
  const r = detectAskBodyDeclConflict({ iterations: 3, finalAcceptance: 'E2E 全过', autoDecision: true }, textDecl)
  assert.deepEqual(r, { conflict: false })
})

test('detectAskBodyDeclConflict：body 显式传 iterations 与文本不一致（含"文本未声明→落为默认值 1"的情形）→ 冲突，说明性错误', () => {
  const textDecl = { iterations: 1, finalAcceptance: null, autoDecision: false } // 文本未声明，落为默认值
  const r = detectAskBodyDeclConflict({ iterations: 2 }, textDecl)
  assert.equal(r.conflict, true)
  assert.ok(typeof r.error === 'string' && r.error.length > 0)
  assert.ok(r.error.includes('不一致') || r.error.includes('文本未声明'))
  assert.ok(r.error.includes('iterations'))
})

test('detectAskBodyDeclConflict：body 显式传 autoDecision:true 而文本未声明（默认 false）→ 冲突', () => {
  const textDecl = { iterations: 1, finalAcceptance: null, autoDecision: false }
  const r = detectAskBodyDeclConflict({ autoDecision: true }, textDecl)
  assert.equal(r.conflict, true)
  assert.ok(r.error.includes('autoDecision'))
})

test('detectAskBodyDeclConflict：body 显式传 finalAcceptance 而文本未声明（默认 null）→ 冲突', () => {
  const textDecl = { iterations: 1, finalAcceptance: null, autoDecision: false }
  const r = detectAskBodyDeclConflict({ finalAcceptance: '验收标准 X' }, textDecl)
  assert.equal(r.conflict, true)
  assert.ok(r.error.includes('finalAcceptance'))
})

test('detectAskBodyDeclConflict：多字段同时冲突 → 全部列出，不只报第一个', () => {
  const textDecl = { iterations: 1, finalAcceptance: null, autoDecision: false }
  const r = detectAskBodyDeclConflict({ iterations: 5, autoDecision: true }, textDecl)
  assert.equal(r.conflict, true)
  assert.ok(r.error.includes('iterations') && r.error.includes('autoDecision'))
})

test('detectAskBodyDeclConflict：只做检测拒绝，不做合并——不返回 merged/after 之类的合并结果字段', () => {
  const textDecl = { iterations: 1, finalAcceptance: null, autoDecision: false }
  const r = detectAskBodyDeclConflict({ iterations: 2 }, textDecl)
  assert.ok(!('merged' in r))
  assert.ok(!('after' in r))
})

test('detectAskBodyDeclConflict：畸形入参（null/数组/非对象）不抛错，按空对象处理', () => {
  const textDecl = { iterations: 1, finalAcceptance: null, autoDecision: false }
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.doesNotThrow(() => detectAskBodyDeclConflict(bad, textDecl))
    assert.deepEqual(detectAskBodyDeclConflict(bad, textDecl), { conflict: false })
  }
})

test('source 标记：/ask 入口在 saveRecord 之前用 detectAskBodyDeclConflict 校验 body 与文本声明，冲突时 400（lib/index.js v4.11.0 步9）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(src.includes("detectAskBodyDeclConflict(payload, askDeclFromText)"))
  assert.ok(src.includes('if (bodyDeclConflict.conflict) return json(res, 400'))
  const idxConflict = src.indexOf('const bodyDeclConflict = detectAskBodyDeclConflict(')
  const idxSave = src.indexOf('const { id, relPath, fileTarget } = await saveRecord({\n        base, safePolicy, prompt, answer, channel: askChannel,')
  assert.ok(idxConflict > -1 && idxSave > -1, '两处代码都必须存在')
  assert.ok(idxConflict < idxSave, '冲突校验必须在 saveRecord 落盘之前短路返回，避免冲突请求也被落盘')
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
  assert.ok(src.includes('autoIterDeclAudit: askAutoIterDeclAudit'))
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

// ---------------------------------------------------------------------------
// ccfix-20260915-autoiteraudit: autoIterDeclAudit 从未落盘（先写盘、后计算）的回归修复
// 缺陷现场：stepsDeclareHandler 曾先 writeStepState(...{ ...state, ...plan.after })（不含判定结果），
// 再算 assessAutoIterDecl 只塞进响应体 —— steps.json 里的 autoIterDeclAudit 恒为 null。
// buildAutoIterDeclAudit 是 declare / ask 两个入口共用的唯一构造点，以下直接对其做纯函数验证；
// 并用 source 断言确认 lib/index.js 真正把它接在 writeStepState **之前**、且两个入口都在用它
// （而不是各自内联拼一份，那样字段结构会漂移）。
// ---------------------------------------------------------------------------
test('buildAutoIterDeclAudit：declare 完整声明（iterations>1 且 autoDecision=true）→ 结构完整、非 null、source=declare、verdict.complete=true', () => {
  const audit = buildAutoIterDeclAudit({ iterations: 3, autoDecision: true, finalAcceptance: 'E2E 全过' }, 'declare')
  assert.ok(audit && typeof audit === 'object')
  assert.equal(audit.source, 'declare')
  assert.ok(typeof audit.at === 'string' && !Number.isNaN(Date.parse(audit.at)), 'at 必须是可解析的 ISO 时间戳')
  assert.deepEqual(audit.decl, { iterations: 3, autoDecision: true, finalAcceptance: 'E2E 全过' })
  assert.equal(audit.verdict.complete, true)
  assert.equal(audit.verdict.halfState, false)
})

test('buildAutoIterDeclAudit：半状态声明（iterations>1 且 autoDecision!=true）→ verdict.halfState=true 且 reasons 非空', () => {
  const audit = buildAutoIterDeclAudit({ iterations: 4, autoDecision: false, finalAcceptance: null }, 'declare')
  assert.equal(audit.verdict.halfState, true)
  assert.equal(audit.verdict.complete, false)
  assert.ok(Array.isArray(audit.verdict.reasons) && audit.verdict.reasons.length > 0)
  assert.ok(typeof audit.verdict.hint === 'string' && audit.verdict.hint.length > 0)
})

test('buildAutoIterDeclAudit：source 按调用方透传（declare/ask 共用同一构造点，结构不漂移）', () => {
  const decl = { iterations: 2, autoDecision: true, finalAcceptance: 'ok' }
  const declareAudit = buildAutoIterDeclAudit(decl, 'declare')
  const askAudit = buildAutoIterDeclAudit(decl, 'ask')
  assert.equal(declareAudit.source, 'declare')
  assert.equal(askAudit.source, 'ask')
  // 除 source 外结构一致（同一构造函数产出，不允许两个入口各自漂出不同字段集）
  assert.deepEqual(Object.keys(declareAudit).sort(), Object.keys(askAudit).sort())
  assert.deepEqual(declareAudit.decl, askAudit.decl)
  assert.deepEqual(declareAudit.verdict, askAudit.verdict)
})

test('source 标记：stepsDeclareHandler 先算（buildAutoIterDeclAudit）后写（writeStepState），且 /ask 入口同样调用 buildAutoIterDeclAudit（不再各自内联拼字段）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const idxBuild = src.indexOf('const autoIterDeclAudit = buildAutoIterDeclAudit(plan.after')
  const idxWrite = src.indexOf('const updated = await writeStepState(base, exprId, { ...state, ...plan.after, autoIterDeclAudit }')
  assert.ok(idxBuild > -1 && idxWrite > -1, '两处代码都必须存在')
  assert.ok(idxBuild < idxWrite, '判定必须先算出来，再传入 writeStepState——不能反过来依赖 spread 旧 state 里的值')
  assert.ok(src.includes("buildAutoIterDeclAudit({ iterations: ai.iterations, autoDecision: ai.autoDecision, finalAcceptance: ai.finalAcceptance }, 'ask')"), '/ask 入口须与 declare 入口共用同一构造函数')
})

test('未声明/无声明字段时保持既有 null 语义：非法 declare 请求（plan.ok=false）在算审计字段之前就已 400 返回，不会落一个伪造的空对象冒充"已评估"', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const idxReject = src.indexOf("if (!plan.ok) return json(res, 400, { ok: false, error: plan.error })")
  const idxBuild = src.indexOf('const autoIterDeclAudit = buildAutoIterDeclAudit(plan.after')
  assert.ok(idxReject > -1 && idxBuild > -1)
  assert.ok(idxReject < idxBuild, 'plan.ok 校验失败必须在计算/落盘审计字段之前短路返回')
  // 读写白名单默认值仍是 null（未评估），不是凭空造的 {} 或其它假值
  assert.ok(src.includes('autoIterDeclAudit: data.autoIterDeclAudit || null'))
  assert.ok(src.includes('autoIterDeclAudit: state.autoIterDeclAudit || null'))
})
