// 工作区侧独立校验器：协议版本接地（V1 / expr-2026-09-22_17-42-08）
//
// 与仓库内探针 probes/protocol-version-grounding-accept.mjs 的区别（两者都要通过，且**独立实现**）：
//   · 仓库探针面向 cc runner 的 acceptanceScript（跑在仓库侧、可被任务门控消费）；
//   · 本校验器面向主 agent 工作区（可登记进工具清单、纳入 regression/audit 复跑），
//     走**线上 HTTP 实测 + 运行副本哈希**两条独立证据链，不读仓库源码做静态判断
//     （避免"读的是我改的那份"这种自证）。
//
// 判据：
//   G1 /health-check 可读，loadedFrom 指向 profiles\web\node_modules\dsh-web-relay\lib
//   G2 /context 含 protocolVersions[]，长度 ≥6，含 v2.0 且 concurrent=true，v1.5 concurrent=false
//   G3 每个元数据 contentKey 在 /context 中都有非空正文（新增版本只需改一处）
//   G4 并发档集合恰为「除 v1.5 外全部」（后端唯一分叉：线性 vs 并发）
//   G5 /protocol 与 /context 的 protocolVersions 完全一致（两个构造点不得漂移）
//   G6 运行副本 lib/index.js、lib/client.js 与仓库 sha256 逐一致（交付接地）
//   G7 既有 expr 读回不被破坏（protocolVersion=v2.0 且 steps 数不变）
//
// 退出码：0 全通过 / 1 有 FAIL / 3 仪器错误（宿主不可达）/ 4 未验证（SKIP 项存在且无 FAIL）
// 用法: node verify-protocol-grounding.mjs [--selftest]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.DSH_RELAY_BASE || 'http://127.0.0.1:3080'
const REPO = 'D:\\dsh-web-relay'
const LOADED = path.join(process.env.USERPROFILE || 'C:\\Users\\Administrator', '.dsh', 'profiles', 'web', 'node_modules', 'dsh-web-relay')
const EXPR = process.env.DSH_EXPR || 'expr-2026-09-22_17-42-08'
const WS = 'D:\\dsh relay test'

const results = []
const check = (id, label, cond, detail = '') => {
  results.push({ id, ok: cond === true, skip: false })
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${id} ${label}${detail ? ' — ' + detail : ''}`)
}
const skip = (id, label, detail = '') => {
  results.push({ id, ok: false, skip: true })
  console.log(`  [SKIP] ${id} ${label}${detail ? ' — ' + detail : ''}`)
}

// ---------- 纯判定助手（可自检，防"永真探针"） ----------
export const concurrentSet = (meta) => (Array.isArray(meta) ? meta.filter((m) => m && m.concurrent).map((m) => m.version) : [])
export const isExactlyAllButLinear = (meta) => {
  const list = Array.isArray(meta) ? meta : []
  if (list.length < 2) return false
  const linear = list.filter((m) => !m.concurrent).map((m) => m.version)
  const conc = concurrentSet(list)
  return linear.length === 1 && linear[0] === list[0].version && conc.length === list.length - 1
}
export const contentKeysCovered = (meta, payload) => {
  const list = Array.isArray(meta) ? meta : []
  const missing = list.filter((m) => {
    const e = payload && payload[m.contentKey]
    return !(e && typeof e.text === 'string' && e.text.length > 0)
  })
  return { ok: missing.length === 0, missing: missing.map((m) => `${m.version}→${m.contentKey}`) }
}

if (process.argv.includes('--selftest')) {
  const good = [
    { version: 'v1.5', concurrent: false, contentKey: 'a' },
    { version: 'v1.6', concurrent: true, contentKey: 'b' },
    { version: 'v2.0', concurrent: true, contentKey: 'c' }
  ]
  const bad = [
    { version: 'v1.5', concurrent: true, contentKey: 'a' },
    { version: 'v1.6', concurrent: true, contentKey: 'b' }
  ]
  const cases = [
    ['[POS] 线性只在首位且其余全并发 → 真', isExactlyAllButLinear(good) === true],
    ['[NEG] v1.5 被判并发 → 假', isExactlyAllButLinear(bad) === false],
    ['[NEG] 空/单项 → 假', isExactlyAllButLinear([]) === false && isExactlyAllButLinear([good[0]]) === false],
    ['[POS] contentKey 全覆盖 → ok', contentKeysCovered(good, { a: { text: 'x' }, b: { text: 'y' }, c: { text: 'z' } }).ok === true],
    ['[NEG] 缺一个正文 → 不 ok 且列出缺项', contentKeysCovered(good, { a: { text: 'x' }, c: { text: 'z' } }).missing.join() === 'v1.6→b'],
    ['[NEG] 正文为空串 → 不 ok', contentKeysCovered(good, { a: { text: '' }, b: { text: 'y' }, c: { text: 'z' } }).ok === false]
  ]
  const fails = cases.filter((c) => !c[1]).length
  for (const [l, ok] of cases) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}`)
  console.log(`\nRESULT: ${cases.length - fails}/${cases.length} ${fails ? 'FAIL' : 'PASS'}`)
  process.exit(fails ? 1 : 0)
}

const get = async (p) => {
  const r = await fetch(`${BASE}/dsh-web-relay${p}`, { signal: AbortSignal.timeout(10000) })
  return await r.json()
}

let health = null
let ctx = null
let proto = null
try {
  health = await get('/health-check')
  ctx = await get('/context')
} catch (e) {
  console.log(`  [INSTRUMENT] 宿主不可达：${(e && e.message) || e}`)
  process.exit(3)
}
try { proto = await get('/protocol') } catch (e) { /* 下面记 SKIP */ }

check('G1', '/health-check loadedFrom 指向运行副本', typeof health.loadedFrom === 'string' && /profiles[\\/]web[\\/]node_modules[\\/]dsh-web-relay/.test(health.loadedFrom),
  `loadedFrom=${health.loadedFrom} version=${health.version}`)

const meta = Array.isArray(ctx.protocolVersions) ? ctx.protocolVersions : null
check('G2', '/context.protocolVersions[] 可用且含 v2.0 并发档', Array.isArray(meta) && meta.length >= 6
  && meta.some((m) => m.version === 'v2.0' && m.concurrent === true)
  && meta.some((m) => m.version === 'v1.5' && m.concurrent === false),
  meta ? `${meta.length} 项: ${meta.map((m) => m.version).join(',')}` : '缺失/非数组')

if (meta) {
  const cov = contentKeysCovered(meta, ctx)
  check('G3', '每个 contentKey 在 /context 均有非空正文', cov.ok, cov.ok ? `${meta.length} 版全覆盖` : `缺 ${cov.missing.join(', ')}`)
  check('G4', '并发档恰为「除 v1.5 外全部」', isExactlyAllButLinear(meta), `并发: ${concurrentSet(meta).join(',')}`)
} else {
  skip('G3', '每个 contentKey 在 /context 均有非空正文', 'G2 未通过')
  skip('G4', '并发档恰为「除 v1.5 外全部」', 'G2 未通过')
}

if (proto && Array.isArray(proto.protocolVersions) && meta) {
  check('G5', '/protocol 与 /context 的 protocolVersions 一致', JSON.stringify(proto.protocolVersions) === JSON.stringify(meta))
} else {
  skip('G5', '/protocol 与 /context 的 protocolVersions 一致', proto ? '一侧无元数据' : '/protocol 不可达')
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
for (const rel of ['lib/index.js', 'lib/client.js']) {
  const a = path.join(REPO, rel.split('/').join(path.sep))
  const b = path.join(LOADED, rel.split('/').join(path.sep))
  if (!fs.existsSync(a) || !fs.existsSync(b)) { skip('G6', `运行副本接地 ${rel}`, '文件缺失'); continue }
  const [ha, hb] = [sha(a), sha(b)]
  check('G6', `运行副本接地 ${rel}`, ha === hb, ha === hb ? ha.slice(0, 12) : `repo=${ha.slice(0, 12)} loaded=${hb.slice(0, 12)}`)
}

try {
  const st = await get(`/steps?cwd=${encodeURIComponent(WS)}&id=${encodeURIComponent(EXPR)}`)
  check('G7', `既有 expr 读回不被破坏（${EXPR}）`, st && st.protocolVersion === 'v2.0' && Array.isArray(st.steps) && st.steps.length > 0,
    `protocolVersion=${st && st.protocolVersion} steps=${st && (st.steps || []).length}`)
} catch (e) {
  skip('G7', '既有 expr 读回不被破坏', String((e && e.message) || e))
}

const failed = results.filter((r) => !r.skip && !r.ok)
const skipped = results.filter((r) => r.skip)
const passed = results.filter((r) => !r.skip && r.ok)
console.log(`\nRESULT: ${passed.length}/${results.length - skipped.length} PASS, ${skipped.length} SKIP, ${failed.length} FAIL`)
if (failed.length) { for (const f of failed) console.log(`  FAIL: ${f.id}`); process.exit(1) }
if (skipped.length) { for (const s of skipped) console.log(`  未验证: ${s.id}`); process.exit(4) }
process.exit(0)
