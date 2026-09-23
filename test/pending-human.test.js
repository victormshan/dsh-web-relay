// ccfeat-20260918-pendinghuman: 「链条停下等人 → 唤醒主 agent」纯函数单测（真实模块 lib/pending-human.mjs）
// 运行：node --test test/pending-human.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parsePendingHuman, decidePendingHuman, pendingHandoffText, resolveWakeSessionId, buildPendingHumanWrite } from '../lib/pending-human.mjs'

const goodEntry = { id: 'chain-abc|too-many-attempts', chainId: 'chain-abc', reason: 'too-many-attempts', taskId: 'ccfix-1', detail: '连续 3 次失败', acknowledgedAt: null }

// ---------- parsePendingHuman ----------

test('parsePendingHuman：合法 JSON → ok=true 且 entry 字段完整', () => {
  const r = parsePendingHuman(JSON.stringify(goodEntry))
  assert.equal(r.ok, true)
  assert.equal(r.error, null)
  assert.equal(r.entry.id, goodEntry.id)
  assert.equal(r.entry.chainId, goodEntry.chainId)
})

test('parsePendingHuman：带 BOM 也能解析（容错）', () => {
  const r = parsePendingHuman('﻿' + JSON.stringify(goodEntry))
  assert.equal(r.ok, true)
  assert.equal(r.entry.chainId, goodEntry.chainId)
})

test('parsePendingHuman：坏 JSON → ok=false 且绝不抛异常', () => {
  assert.doesNotThrow(() => {
    const r = parsePendingHuman('{ this is not json')
    assert.equal(r.ok, false)
    assert.equal(r.entry, null)
    assert.ok(r.error)
  })
})

test('parsePendingHuman：缺 id/chainId/reason → ok=false（不能拿半个信号去唤醒）', () => {
  assert.equal(parsePendingHuman(JSON.stringify({ reason: 'review-needed' })).ok, false)
  assert.equal(parsePendingHuman(JSON.stringify({ id: 'x', reason: 'review-needed' })).ok, false)
  assert.equal(parsePendingHuman(JSON.stringify({ id: 'x', chainId: 'c' })).ok, false)
})

test('parsePendingHuman：空字符串/非字符串输入 → ok=false 且不抛', () => {
  assert.equal(parsePendingHuman('').ok, false)
  assert.equal(parsePendingHuman('   ').ok, false)
  assert.equal(parsePendingHuman(undefined).ok, false)
  assert.equal(parsePendingHuman(null).ok, false)
})

test('parsePendingHuman：解析结果是数组/非对象 → ok=false', () => {
  assert.equal(parsePendingHuman('[1,2,3]').ok, false)
  assert.equal(parsePendingHuman('"just a string"').ok, false)
})

// ---------- decidePendingHuman ----------

test('decidePendingHuman：无效条目（null / 缺字段）→ none', () => {
  assert.equal(decidePendingHuman(null, { notifiedIds: [] }).decision, 'none')
  assert.equal(decidePendingHuman({ id: 'x' }, { notifiedIds: [] }).decision, 'none')
  assert.equal(decidePendingHuman(undefined, { notifiedIds: new Set() }).decision, 'none')
})

test('decidePendingHuman：已销账（acknowledgedAt 非空）→ none', () => {
  const d = decidePendingHuman({ ...goodEntry, acknowledgedAt: '2026-09-18T00:00:00Z' }, { notifiedIds: [] })
  assert.equal(d.decision, 'none')
})

test('decidePendingHuman：同 id 已在 notifiedIds → none（去重，防每 15 分钟吵一次）', () => {
  const d1 = decidePendingHuman({ ...goodEntry }, { notifiedIds: new Set([goodEntry.id]) })
  assert.equal(d1.decision, 'none')
  const d2 = decidePendingHuman({ ...goodEntry }, { notifiedIds: [goodEntry.id] })
  assert.equal(d2.decision, 'none')
})

test('decidePendingHuman：dryRun === true → would-wake（判定需要但不真唤醒）', () => {
  const d = decidePendingHuman({ ...goodEntry, dryRun: true }, { notifiedIds: [] })
  assert.equal(d.decision, 'would-wake')
})

test('decidePendingHuman：正常新条目 → wake', () => {
  const d = decidePendingHuman({ ...goodEntry }, { notifiedIds: [] })
  assert.equal(d.decision, 'wake')
})

test('decidePendingHuman：notifiedIds 缺省（未传）也不抛，视为空集合', () => {
  assert.doesNotThrow(() => {
    const d = decidePendingHuman({ ...goodEntry })
    assert.equal(d.decision, 'wake')
  })
})

// ---------- pendingHandoffText ----------

test('pendingHandoffText：非空且含 chainId / reason / taskId / 处理指引', () => {
  const txt = pendingHandoffText({ id: 'x', chainId: 'chain-xyz', reason: 'instrument-error', taskId: 'ccfix-9', detail: '验收脚本抛出异常' })
  assert.ok(txt.length > 0)
  assert.ok(txt.includes('chain-xyz'))
  assert.ok(txt.includes('instrument-error'))
  assert.ok(txt.includes('ccfix-9'))
  assert.ok(txt.includes('验收脚本抛出异常'))
  assert.match(txt, /销账|acknowledgeHumanSignal/)
})

test('pendingHandoffText：字段缺失时仍返回非空文本（占位说明，不抛）', () => {
  assert.doesNotThrow(() => {
    const txt = pendingHandoffText({})
    assert.ok(txt.length > 0)
  })
  assert.doesNotThrow(() => {
    const txt = pendingHandoffText(null)
    assert.ok(txt.length > 0)
  })
})

// ---------- resolveWakeSessionId（2026-09-18：唤醒目标解析回退——这台机器的宿主启动器
// 没有注入 DSH_SESSION_ID，没有回退「判定成立」就永远等于「仅记录，不唤醒」）----------

test('resolveWakeSessionId：env 有值 → 用 env，source=env', () => {
  const r = resolveWakeSessionId({ env: 'sess-env', recentExprSessionId: 'sess-recent' })
  assert.equal(r.sessionId, 'sess-env')
  assert.equal(r.source, 'env')
})

test('resolveWakeSessionId：env 空、recentExprSessionId 有值 → 回退到 recent，source=recent-expr（关键缺口）', () => {
  const r = resolveWakeSessionId({ env: null, recentExprSessionId: 'sess-recent' })
  assert.equal(r.sessionId, 'sess-recent')
  assert.equal(r.source, 'recent-expr')
})

test('resolveWakeSessionId：两者都空 → sessionId=null，source=none（不凭空造目标）', () => {
  const r = resolveWakeSessionId({ env: null, recentExprSessionId: null })
  assert.equal(r.sessionId, null)
  assert.equal(r.source, 'none')
})

test('resolveWakeSessionId：source 取值仅限 env/recent-expr/none 三者之一，且不抛异常', () => {
  assert.doesNotThrow(() => {
    assert.equal(resolveWakeSessionId({ env: 'x', recentExprSessionId: null }).source, 'env')
    assert.equal(resolveWakeSessionId({ env: '', recentExprSessionId: 'y' }).source, 'recent-expr')
    assert.equal(resolveWakeSessionId({}).source, 'none')
    assert.equal(resolveWakeSessionId().source, 'none')
  })
})

test('resolveWakeSessionId：有值时绝不返回 null（env 与 recent 都非空时优先 env，不丢弃已有目标）', () => {
  const r = resolveWakeSessionId({ env: 'sess-env', recentExprSessionId: 'sess-recent' })
  assert.notEqual(r.sessionId, null)
  assert.equal(r.sessionId, 'sess-env')
})

// ---------- ccfeat-20260920-waketarget：新增「最近活跃会话」档 ----------
// 事故背景：用户刷新后 GUI 换了新会话，而 expr 仍绑刷新前那个 → 旧逻辑把唤醒投给旧会话 → 两个"我"
// 并发写同一工作区（旧会话还用内联 PowerShell 正则把主槽信号文件写成 []）；见 lib/pending-human.mjs 注释。

test('resolveWakeSessionId：activeSessions 有值时优先于 history expr sessionId（刷新后投给新会话）', () => {
  const r = resolveWakeSessionId({ activeSessions: [{ id: 'sess-new', mtimeMs: 2000 }, { id: 'sess-old', mtimeMs: 1000 }], recentExprSessionId: 'sess-old' })
  assert.equal(r.sessionId, 'sess-new')
  assert.equal(r.source, 'active')
  // 断言**结构性事实**（note 存在且点名被切换掉的历史会话），不锁具体措辞——
  // 初版写 assert.match(note, /切换/) 而实现用的是"切到"，属于 L-087 那类"断言编码了偶然措辞"的脆断言。
  assert.ok(r.note && r.note.includes('sess-old'), `note 应点名被切换掉的历史会话，实得：${r.note}`)
})

test('resolveWakeSessionId：env 仍最高优先（显式注入不被活跃会话覆盖）', () => {
  const r = resolveWakeSessionId({ env: 'sess-env', activeSessions: [{ id: 'sess-new', mtimeMs: 9999 }], recentExprSessionId: 'sess-old' })
  assert.equal(r.sessionId, 'sess-env')
  assert.equal(r.source, 'env')
})

test('resolveWakeSessionId：activeSessions 里与历史会话相同 → 不产生"已切换"note（避免噪声）', () => {
  const r = resolveWakeSessionId({ activeSessions: [{ id: 'sess-same', mtimeMs: 1 }], recentExprSessionId: 'sess-same' })
  assert.equal(r.source, 'active')
  assert.equal(r.note, undefined)
})

test('resolveWakeSessionId：畸形 activeSessions（缺 id / mtime 非数）被忽略并回退到 expr 历史会话', () => {
  const r = resolveWakeSessionId({ activeSessions: [{ id: '', mtimeMs: 5 }, { id: 'x' }, { mtimeMs: 5 }], recentExprSessionId: 'sess-recent' })
  assert.equal(r.sessionId, 'sess-recent')
  assert.equal(r.source, 'recent-expr')
})

test('resolveWakeSessionId：activeSessions 为空数组等价于未提供（回落旧行为，保持向后兼容）', () => {
  assert.equal(resolveWakeSessionId({ activeSessions: [], recentExprSessionId: 'y' }).source, 'recent-expr')
  assert.equal(resolveWakeSessionId({ activeSessions: null, recentExprSessionId: 'y' }).source, 'recent-expr')
})

// ---- ccfeat-20260923-synthetic: 合成夹具标记必须在**写入时**就带上 ----
// 背景：门禁/回归每次都会跑 verify-autoir-events，它走生产路径登记一条**形状逼真**的熔断信号
// （id 是真实时间戳，与真告警同形）。夹具被销账后仍留在主槽，而插件去重集随宿主重启重置
// ⇒ 同一夹具连续三次唤醒主 agent，每次都指向一条**不存在的 expr**。事后补标记已经太晚，故写入时即标记。
test('buildPendingHumanWrite：synthetic=true 时写入该字段（供插件唤醒路径识别）', () => {
  const r = buildPendingHumanWrite({ chainId: 'autoir-circuit', reason: 'too-many-attempts', stableKey: 'autoir-circuit-x', synthetic: true })
  assert.equal(r.ok, true)
  assert.equal(r.entry.synthetic, true, 'synthetic 必须落进条目')
})

test('[NEG] buildPendingHumanWrite：未传 synthetic 时**不得**产生该字段（防真实告警被当夹具）', () => {
  const r = buildPendingHumanWrite({ chainId: 'autoir-circuit', reason: 'too-many-attempts', stableKey: 'autoir-circuit-y' })
  assert.equal(r.ok, true)
  assert.equal(Object.prototype.hasOwnProperty.call(r.entry, 'synthetic'), false, '真实告警不得带 synthetic 字段')
  const r2 = buildPendingHumanWrite({ chainId: 'autoir-circuit', reason: 'too-many-attempts', stableKey: 'z', synthetic: false })
  assert.equal(Object.prototype.hasOwnProperty.call(r2.entry, 'synthetic'), false, 'synthetic=false 也不写字段')
})

test('parsePendingHuman 能读回 synthetic 标记（往返一致）', () => {
  const built = buildPendingHumanWrite({ chainId: 'autoir-circuit', reason: 'too-many-attempts', stableKey: 'autoir-circuit-r', synthetic: true })
  const back = parsePendingHuman(JSON.stringify(built.entry))
  assert.equal(back.ok, true)
  assert.equal(back.entry.synthetic, true)
})

test('源码契约：唤醒路径必须对 synthetic 条目短路（只留痕不唤醒），且判据在 decide 之前', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const i = src.indexOf('async function checkPendingHuman')
  assert.ok(i >= 0, '应能定位 checkPendingHuman')
  const body = src.slice(i, i + 6000)
  const synIdx = body.indexOf("entry.synthetic === true")
  const decIdx = body.indexOf('decidePendingHuman(entry')
  assert.ok(synIdx >= 0, 'checkPendingHuman 必须判定 synthetic')
  assert.ok(decIdx >= 0, '应仍有 decidePendingHuman 调用')
  assert.ok(synIdx < decIdx, 'synthetic 短路必须在 decide 之前（否则仍会唤醒）')
  assert.match(body, /synthetic-no-wake/, '短路时必须有可 grep 的留痕 reason')
})
