// V1 前端验证：多模型下钻 + 缓存指标 UI（静态断言 + VM 冒烟）
import fs from 'node:fs'
import vm from 'node:vm'
const code = fs.readFileSync('D:/dsh relay test/step-value/lib/client.js', 'utf8')

// a) 静态断言：v0.4.0 新 UI 元素
const must = [
  'byModel:', 'modelShare:', 'perTurnAvg:', 'cacheHits:', 'parseMs:', 'cached:',
  'summary.perModel',
  'share = summary.totalCostUSD > 0',
  'summary.stats',
  'T.cached + \': \' + fmtInt(summary.stats.diskHits)',
  'T.perTurnAvg',
]
const missing = must.filter((m) => !code.includes(m))
if (missing.length) { console.log('FAIL missing:', missing); process.exit(1) }
console.log('静态断言 OK：多模型下钻（perModel 占比条）+ 缓存指标（stats）+ i18n 6 键')

// b) i18n 对称断言（zh/en 键集合一致）
const zhKeys = [...code.matchAll(/zh: \{([\s\S]*?)\n\s*\},/g)].map((m) => [...m[1].matchAll(/^(\w+):/gm)].map((x) => x[1]))
const enKeys = [...code.matchAll(/en: \{([\s\S]*?)\n\s*\}/g)].map((m) => [...m[1].matchAll(/^(\w+):/gm)].map((x) => x[1]))
const zh = zhKeys[0] || [], en = enKeys[0] || []
const sym = zh.length === en.length && zh.every((k) => en.includes(k))
console.log('i18n 对称:', zh.length + ' zh / ' + en.length + ' en', sym ? '✓' : '✗')
if (!sym) { console.log('FAIL i18n 不对称'); process.exit(1) }

// c) VM 冒烟（mock __ModuleLoader__ + react，无 Node module/exports）
let loaded = null
const mockReact = { useState: (i) => [typeof i === 'function' ? i() : i, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), createElement: () => ({ __vnode: true }) }
const sandbox = {
  console, setTimeout, clearTimeout,
  CustomEvent: function CustomEvent(t) { this.type = t },
  document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, head: { append: () => {} }, createElement: () => ({ dataset: {}, textContent: '' }), documentElement: { style: {} }, body: { style: {} } },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  localStorage: { getItem: () => null, setItem: () => {} },
  navigator: {}, location: { href: 'http://127.0.0.1:3080' }, URL,
  InputEvent: function InputEvent() {}, requestAnimationFrame: (f) => setTimeout(f, 0),
}
sandbox.window = sandbox
sandbox.window.__ModuleLoader__ = { load: (m) => { loaded = m } }
sandbox.window.addEventListener = () => {}
sandbox.window.removeEventListener = () => {}
sandbox.window.dispatchEvent = () => true
sandbox.window.innerWidth = 1600
sandbox.globalThis = sandbox
vm.createContext(sandbox)
try { vm.runInContext(code, sandbox, { filename: 'client.js' }) } catch (e) { console.log('FAIL top-level:', e && e.message); process.exit(1) }
if (!loaded || loaded.id !== 'step-value' || typeof loaded.factory !== 'function') { console.log('FAIL load'); process.exit(1) }
const requireMock = (n) => (n === 'react' ? mockReact : (() => { throw new Error('unexpected ' + n) })())
let mod
try { mod = loaded.factory(requireMock) } catch (e) { console.log('FAIL factory:', e && e.message); process.exit(1) }
const slots = { inject: (n, f) => {} }
try { mod.apply({ get: (k) => (k === 'slots' ? slots : undefined) }) } catch (e) { console.log('FAIL apply:', e && e.message); process.exit(1) }
console.log('VM 冒烟 OK：id=' + loaded.id + ' inject/apply 正常，无 ReferenceError')
console.log('V1-UI 验证 PASS')
