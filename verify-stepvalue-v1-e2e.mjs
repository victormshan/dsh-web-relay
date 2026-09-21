// V1 Step 4：端到端验证与基准性能测试（真实会话日志，源码层）
// ① 首次解析（冷磁盘缓存）耗时  ② 缓存命中耗时  ③ summary 新字段  ④ 模型计价
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cacheDir = path.join(os.homedir(), '.dsh', 'step-value-cache')
// 清空磁盘缓存模拟冷启动
try { fs.rmSync(cacheDir, { recursive: true, force: true }) } catch {}

const mod = await import('file:///D:/dsh relay test/step-value/lib/index.js')
const root = mod.SESSIONS_ROOT

const t0 = Date.now()
const summary1 = await mod.buildSummary(root)
const firstMs = Date.now() - t0

const t1 = Date.now()
const summary2 = await mod.buildSummary(root)
const hitMs = Date.now() - t1

console.log('SESSIONS_ROOT:', root)
console.log('工作区数:', summary1.workspaces.length, '| 总 turn:', summary1.totalTurns, '| 总成本 $', summary1.totalCostUSD)
console.log('① 首次解析（冷缓存）:', firstMs, 'ms', firstMs < 10000 ? '✓ <10s' : '✗ >10s')
console.log('② 缓存命中:', hitMs, 'ms', hitMs < 500 ? '✓ <500ms' : '✗ >=500ms')
console.log('③ 新字段: avgCostPerTurn =', summary1.avgCostPerTurn, '| perModel keys =', Object.keys(summary1.perModel || {}).join(',') || '(空)')
console.log('④ 磁盘缓存文件数:', (() => { try { return fs.readdirSync(cacheDir).length } catch { return 0 } })())

let fail = 0
if (firstMs >= 10000) { console.log('FAIL 首次解析超 10s'); fail++ }
if (hitMs >= 500) { console.log('FAIL 缓存命中超 500ms'); fail++ }
if (!('avgCostPerTurn' in summary1) || !summary1.perModel) { console.log('FAIL summary 新字段缺失'); fail++ }
if (fail) { console.log('V1-E2E FAIL'); process.exit(1) }
console.log('V1-E2E PASS（首次<10s ✓ 缓存<500ms ✓ 新字段 ✓）')
