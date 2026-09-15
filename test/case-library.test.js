// V2-1: 案例库解析/选择/渲染纯函数测试（镜像 lib/case-library.js，从 lib/index.js 抽出）
// 运行：node --test test/case-library.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCaseLibrary, dedupeCases, selectTopCases, renderCaseBlock } from '../lib/case-library.js'

const SAMPLE_MD = `# Prompt 案例库（V3.1 自动维护，finalize 时幂等追加）

## 案例 1
- exprId: expr-2026-09-01_00-00-00
- stepId: 2
- category: missing_artifact
- reason: artifacts 为空，缺少产物证据，请补挂
- recordedAt: 2026-09-01T00:00:00.000Z

## 案例 2
- exprId: expr-2026-09-02_00-00-00
- stepId: 3
- category: acceptance_gap
- reason: 未达到验收标准，缺少覆盖率报告
- recordedAt: 2026-09-02T00:00:00.000Z

## 案例 3
- exprId: expr-2026-09-03_00-00-00
- stepId: 1
- category: syntax_error
- reason: 语法错误 SyntaxError: Unexpected token
- recordedAt: 2026-09-03T00:00:00.000Z
`

test('parseCaseLibrary：正常条目解析出全部字段并 trim', () => {
  const cases = parseCaseLibrary(SAMPLE_MD)
  assert.equal(cases.length, 3)
  assert.deepEqual(cases[0], {
    seq: 1,
    exprId: 'expr-2026-09-01_00-00-00',
    stepId: '2',
    category: 'missing_artifact',
    reason: 'artifacts 为空，缺少产物证据，请补挂',
    recordedAt: '2026-09-01T00:00:00.000Z'
  })
})

test('parseCaseLibrary：缺字段/畸形条目被安全跳过（不抛错、不产出半条记录）', () => {
  const malformed = SAMPLE_MD + `
## 案例 4
- exprId: expr-2026-09-04_00-00-00
- stepId: 5
- category: path_issue
` // 缺 reason / recordedAt，正则要求的 6 个字段不全，不应匹配
  const cases = parseCaseLibrary(malformed)
  assert.equal(cases.length, 3) // 畸形的第 4 条不产出记录，其余 3 条不受影响
  assert.ok(!cases.some((c) => c.exprId === 'expr-2026-09-04_00-00-00'))
})

test('parseCaseLibrary：空文本/非字符串输入不抛错，返回空数组', () => {
  assert.deepEqual(parseCaseLibrary(''), [])
  assert.deepEqual(parseCaseLibrary(undefined), [])
  assert.deepEqual(parseCaseLibrary(null), [])
  assert.deepEqual(parseCaseLibrary('随便一段不含案例结构的文本'), [])
})

test('dedupeCases：同 exprId:stepId 幂等去重，后出现者覆盖先出现者', () => {
  const dup = SAMPLE_MD + `
## 案例 4
- exprId: expr-2026-09-01_00-00-00
- stepId: 2
- category: missing_artifact
- reason: 已补挂产物，问题修复（更新版本）
- recordedAt: 2026-09-05T00:00:00.000Z
`
  const cases = parseCaseLibrary(dup)
  assert.equal(cases.length, 3) // 第 1/4 条同键，去重后仍是 3 条
  const merged = cases.find((c) => c.exprId === 'expr-2026-09-01_00-00-00' && c.stepId === '2')
  assert.equal(merged.reason, '已补挂产物，问题修复（更新版本）') // 后出现者覆盖先出现者
})

test('dedupeCases：非数组/含空条目输入安全跳过', () => {
  assert.deepEqual(dedupeCases(null), [])
  assert.deepEqual(dedupeCases([null, undefined, { exprId: 'a' }]), []) // 缺 stepId 的条目跳过
})

test('selectTopCases：Top-K 硬上限 3，即便输入更多且 limit 显式设更大', () => {
  const items = [
    { exprId: 'e1', stepId: '1', category: 'missing_artifact', reason: 'artifacts 产物 缺失 产物证据' },
    { exprId: 'e2', stepId: '2', category: 'missing_artifact', reason: 'artifacts 产物 缺失' },
    { exprId: 'e3', stepId: '3', category: 'missing_artifact', reason: 'artifacts 产物' },
    { exprId: 'e4', stepId: '4', category: 'missing_artifact', reason: '产物 artifacts 缺失 挂载' },
    { exprId: 'e5', stepId: '5', category: 'missing_artifact', reason: '产物 挂载' }
  ]
  const picked = selectTopCases(items, { query: 'artifacts 产物 缺失 挂载 证据', limit: 10 })
  assert.ok(picked.length <= 3, `Top-K 不应超过硬上限 3，实际 ${picked.length}`)
})

test('selectTopCases：命中按 score 降序，词命中+category 命中生效', () => {
  const items = [
    { exprId: 'e1', stepId: '1', category: 'acceptance_gap', reason: '未达到验收标准 缺少覆盖率' },
    { exprId: 'e2', stepId: '2', category: 'path_issue', reason: '路径不存在' }
  ]
  const picked = selectTopCases(items, { query: '验收 acceptance_gap 覆盖率', limit: 3 })
  assert.equal(picked.length, 1)
  assert.equal(picked[0].exprId, 'e1') // category 命中 +2、词命中 +1，path_issue 完全不相关应被过滤
})

test('selectTopCases：不命中返回空数组', () => {
  const items = [{ exprId: 'e1', stepId: '1', category: 'syntax_error', reason: '语法错误' }]
  const picked = selectTopCases(items, { query: '影子沙盒 合并 diff 完全无关的主题' })
  assert.deepEqual(picked, [])
})

test('selectTopCases：空输入/空 query 不抛错', () => {
  assert.deepEqual(selectTopCases([], { query: 'x' }), [])
  assert.deepEqual(selectTopCases(null, { query: 'x' }), [])
  assert.deepEqual(selectTopCases([{ exprId: 'e1', stepId: '1', category: 'other', reason: 'x' }], {}), [])
})

test('renderCaseBlock：无命中/空数组 → 空串（不留空标题）', () => {
  assert.equal(renderCaseBlock([]), '')
  assert.equal(renderCaseBlock(null), '')
})

test('renderCaseBlock：渲染文本含案例 id、Step、reason（截 300）与编号', () => {
  const selected = [
    { exprId: 'expr-2026-09-01_00-00-00', stepId: '2', category: 'missing_artifact', reason: 'a'.repeat(400) }
  ]
  const block = renderCaseBlock(selected)
  assert.ok(block.startsWith('【历史拒收案例（V3.1 反思注入，Top-K≤3）】'))
  assert.ok(block.includes('1. [missing_artifact]'))
  assert.ok(block.includes('expr-2026-09-01_00-00-00 Step 2'))
  assert.ok(block.includes('a'.repeat(300)))
  assert.ok(!block.includes('a'.repeat(301))) // reason 截断到 300 字符
})

test('端到端：parseCaseLibrary → selectTopCases → renderCaseBlock 与旧实现语义等价（真实文本样例）', () => {
  const cases = parseCaseLibrary(SAMPLE_MD)
  const block = renderCaseBlock(selectTopCases(cases, { query: '验收标准 覆盖率 acceptance_gap' }))
  assert.ok(block.includes('未达到验收标准'))
  assert.ok(block.includes('expr-2026-09-02_00-00-00 Step 3'))
})
