// ccfix-20260915-swarmparse: parseRoleReview 语义修正专项测试
// 缺陷回顾：原 parseRoleReview 在 JSON.parse 失败且宽松正则也匹配不到 verdict 时，
// 静默默认返回 rejected（且 findings/suggestion 均空）→ 造成「空打回」（无意见、不可整改）。
// 本文件覆盖：合法 JSON / 宽松匹配 / 完全不可解析 → unknown / unknown 的 consensus 处置 / 原始输出保留。
// 运行：node --test test/swarm-prompts.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoleReview, swarmConsensus } from '../lib/swarm-prompts.js'

test('parseRoleReview：合法 JSON → verdict/findings/suggestion 原样返回，并带 raw', () => {
  const approved = parseRoleReview('{"verdict":"approved","findings":[],"suggestion":""}')
  assert.equal(approved.verdict, 'approved')
  assert.deepEqual(approved.findings, [])
  assert.equal(approved.suggestion, '')
  assert.ok(typeof approved.raw === 'string' && approved.raw.length > 0)

  const rejected = parseRoleReview('{"verdict":"rejected","findings":["越权读写","资源泄露"],"suggestion":"补充白名单校验"}')
  assert.equal(rejected.verdict, 'rejected')
  assert.deepEqual(rejected.findings, ['越权读写', '资源泄露'])
  assert.equal(rejected.suggestion, '补充白名单校验')
})

test('parseRoleReview：合法 JSON 但 verdict 为非法值（如 LGTM）→ unknown 且保留 raw', () => {
  const r = parseRoleReview('{"verdict":"LGTM","findings":["顺手一提"],"suggestion":"无关紧要"}')
  assert.equal(r.verdict, 'unknown')
  // 非法 verdict 时仍尽力保留 findings/suggestion（而不是像旧实现一样直接丢弃/默认 rejected）
  assert.deepEqual(r.findings, ['顺手一提'])
  assert.equal(r.suggestion, '无关紧要')
  assert.ok(r.raw.includes('LGTM'))
})

test('parseRoleReview：宽松正则匹配（JSON 解析失败但文本含 "verdict":"approved|rejected"）', () => {
  // 故意构造非法 JSON（末尾多一个逗号），但仍可被宽松正则命中 verdict
  const broken = '{"verdict":"rejected","findings":["路径越界",],}'
  const r = parseRoleReview(broken)
  assert.equal(r.verdict, 'rejected')
  assert.ok(r.raw.length > 0)
})

test('parseRoleReview：完全不可解析文本 → unknown 且 raw 非空（不再静默默认 rejected）', () => {
  const r = parseRoleReview('审核员超时未按格式回复，纯自然语言说明……')
  assert.equal(r.verdict, 'unknown')
  assert.ok(r.raw.length > 0)
  assert.deepEqual(r.findings, [])
  assert.equal(r.suggestion, '')
})

test('parseRoleReview：raw 截断 ≤500 字（避免裁决上下文无限膨胀）', () => {
  const longText = 'x'.repeat(2000)
  const r = parseRoleReview(longText)
  assert.equal(r.verdict, 'unknown')
  assert.ok(r.raw.length <= 500)
})

test('swarmConsensus：一角色 unknown + 一角色 approved → 不判 rejected（返回可区分的 unknown 结果）', () => {
  const r1 = swarmConsensus('unknown', 'approved')
  assert.equal(r1.result, 'unknown')
  assert.notEqual(r1.result, 'rejected')
  assert.ok(r1.summary.includes('Security-Auditor'))

  const r2 = swarmConsensus('approved', 'unknown')
  assert.equal(r2.result, 'unknown')
  assert.notEqual(r2.result, 'rejected')
  assert.ok(r2.summary.includes('Refactoring-Architect'))

  // 双 unknown 同样不得判 rejected
  const r3 = swarmConsensus('unknown', 'unknown')
  assert.equal(r3.result, 'unknown')
})

test('swarmConsensus：双显式 rejected → rejected，且既有单打回/双通过矩阵不变', () => {
  const r = swarmConsensus('rejected', 'rejected')
  assert.equal(r.result, 'rejected')
  assert.ok(r.summary.includes('双角色均打回'))
  // 既有矩阵行为保持不变（回归）
  assert.equal(swarmConsensus('approved', 'approved').result, 'approved')
  assert.equal(swarmConsensus('approved', 'rejected').result, 'rejected')
})

test('打回可执行：双角色显式 rejected 时 findings/suggestion/raw 均可从 parseRoleReview 结果中取得', () => {
  const sec = parseRoleReview('{"verdict":"rejected","findings":["命令注入风险"],"suggestion":"改用参数化调用"}')
  const ref = parseRoleReview('{"verdict":"rejected","findings":["异常被静默吞掉"],"suggestion":"补 try/catch 并上抛"}')
  assert.equal(swarmConsensus(sec.verdict, ref.verdict).result, 'rejected')
  // 打回意见必须可执行：findings/suggestion 非空，raw 可追溯原始输出
  for (const review of [sec, ref]) {
    assert.ok(review.findings.length > 0)
    assert.ok(review.suggestion.length > 0)
    assert.ok(review.raw.length > 0)
  }
})
