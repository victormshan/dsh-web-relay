// V2 Step 2/3 验证：UI 边界防护 + 状态清理
import fs from 'node:fs'
import vm from 'node:vm'
const code = fs.readFileSync('D:/dsh relay test/step-value/lib/client.js', 'utf8')

// a) 静态断言
const must = [
  // 边界防护
  'textOverflow: \'ellipsis\', whiteSpace: \'nowrap\'',   // 长模型名省略
  'share > 0 && h(\'div\'',                                    // 占比 0 不渲染
  'Math.max(2, Math.min(100, share))',                        // 最小 2% 条
  // 状态清理
  'setExpandedTurns({})',
  'setDetails({})',
  // 既有容错保持
  'summary.totalCostUSD > 0 ? (v.costUSD / summary.totalCostUSD) * 100 : 0',
  'v.costUSD / (v.turns || 1)',
]
const missing = must.filter((m) => !code.includes(m))
if (missing.length) { console.log('FAIL missing:', missing); process.exit(1) }
console.log('静态断言 OK：长模型名省略 / 占比 0 保护 / 最小条 / 会话切换清理')

// b) 边界逻辑复测
const shareOf = (cost, total) => (total > 0 ? (cost / total) * 100 : 0)
const barWidth = (share) => (share > 0 ? Math.max(2, Math.min(100, share)) : 0)
const cases = [
  [1, 100, 1, 2],      // 微小占比 → 最小 2%
  [50, 100, 50, 50],
  [0, 100, 0, 0],      // 0 成本 → 不渲染
  [100, 0, 0, 0],      // 总成本 0 → 0
]
for (const [cost, total, shareWant, widthWant] of cases) {
  const share = shareOf(cost, total)
  if (share !== shareWant || barWidth(share) !== widthWant) { console.log('FAIL', cost, total, share, barWidth(share)); process.exit(1) }
}
console.log('占比条逻辑复测 OK（4 用例：最小 2%/正常/0 不渲染/总成本 0）')

// c) VM 冒烟
let loaded = null
const mockReact = { useState: (i) => [typeof i === 'function' ? i() : i, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), createElement: () => ({}) }
const sandbox = {
  console, setTimeout, clearTimeout, CustomEvent: function CustomEvent(t) { this.type = t },
  document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, head: { append: () => {} }, createElement: () => ({}), documentElement: { style: {} }, body: { style: {} } },
  fetch: async () => ({ ok: true, json: async () => ({}) }), localStorage: { getItem: () => null, setItem: () => {} },
  navigator: {}, location: { href: 'http://127.0.0.1:3080' }, URL, InputEvent: function InputEvent() {}, requestAnimationFrame: (f) => setTimeout(f, 0),
}
sandbox.window = sandbox
sandbox.window.__ModuleLoader__ = { load: (m) => { loaded = m } }
sandbox.window.addEventListener = () => {}
sandbox.window.removeEventListener = () => {}
sandbox.window.dispatchEvent = () => true
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })
const mod = loaded.factory((n) => (n === 'react' ? mockReact : (() => { throw new Error('x') })()))
mod.apply({ get: (k) => (k === 'slots' ? { inject: () => {} } : undefined) })
console.log('VM 冒烟 OK：无 ReferenceError')

console.log('V2-STEP2/3 UI 防护与状态清理验证 PASS')
