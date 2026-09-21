// V3 Step 1：端到端最终验收（真实会话全量 API + 性能 + 新字段 + step-details 定位）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const cacheDir = path.join(os.homedir(), '.dsh', 'step-value-cache')
try { fs.rmSync(cacheDir, { recursive: true, force: true }) } catch {}
const mod = await import('file:///D:/dsh relay test/step-value/lib/index.js')
const root = mod.SESSIONS_ROOT

let fail = 0
// ① /summary 性能 + 新字段
const t0 = Date.now()
const sum1 = await mod.buildSummary(root)
const first = Date.now() - t0
const t1 = Date.now()
const sum2 = await mod.buildSummary(root)
const hit = Date.now() - t1
console.log('① /summary 首次:', first, 'ms', first < 10000 ? '✓' : '✗', '| 缓存:', hit, 'ms', hit < 500 ? '✓' : '✗')
if (first >= 10000 || hit >= 500) fail++
if (!('avgCostPerTurn' in sum1) || !sum1.perModel || !sum1.workspaces.every((w) => 'perModel' in w)) { console.log('✗ 新字段缺失'); fail++ }
console.log('   新字段: avgCostPerTurn=' + sum1.avgCostPerTurn, '| perModel=' + Object.keys(sum1.perModel).join(','))

// ② /tree
const tree = await mod.buildTree(root)
const wsCount = tree.workspaces.length
const sesCount = tree.workspaces.reduce((a, w) => a + w.sessions.length, 0)
console.log('② /tree:', wsCount, '工作区 /', sesCount, '会话 ✓')
if (wsCount === 0) fail++

// ③ /step-details 定位（取第一个会话的第一个 turn）
let details = { error: 'no session' }
if (tree.workspaces[0] && tree.workspaces[0].sessions[0]) {
  const w = tree.workspaces[0]
  const ses = w.sessions[0]
  details = await mod.findTurn(root, w.dir, ses.id || ses.dir, ses.turnsList[0].turn, ses.turnsList[0].step)
}
console.log('③ /step-details:', details.error ? '✗ ' + details.error : '✓ turn=' + details.turn.turn + ' model=' + details.turn.model + ' costUSD=' + details.turn.costUSD)
if (details.error) fail++

if (fail) { console.log('V3-E2E FAIL'); process.exit(1) }
console.log('V3-E2E PASS（summary 性能+新字段 / tree / step-details 全通）')
