// V2 Step 1 验证：i18n 全键对称与文案质量（VM 加载 bundle 拿真实字典）
import fs from 'node:fs'
import vm from 'node:vm'
const code = fs.readFileSync('D:/dsh relay test/step-value/lib/client.js', 'utf8')

let loaded = null
const mockReact = { useState: (i) => [typeof i === 'function' ? i() : i, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), createElement: () => ({}) }
const sandbox = {
  console, setTimeout, clearTimeout,
  CustomEvent: function CustomEvent(t) { this.type = t },
  document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, head: { append: () => {} }, createElement: () => ({}), documentElement: { style: {} }, body: { style: {} } },
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
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })
const mod = loaded.factory((n) => (n === 'react' ? mockReact : (() => { throw new Error('x') })()))
const i18n = mod.i18n
if (!i18n || !i18n.zh || !i18n.en) { console.log('FAIL i18n 缺失'); process.exit(1) }

const zhKeys = Object.keys(i18n.zh).sort()
const enKeys = Object.keys(i18n.en).sort()
console.log('zh keys:', zhKeys.length, '| en keys:', enKeys.length)
if (zhKeys.length !== enKeys.length) { console.log('FAIL 键数不一致'); process.exit(1) }
const asym = zhKeys.filter((k, i) => k !== enKeys[i])
if (asym.length) { console.log('FAIL 不对称键:', asym); process.exit(1) }
console.log('键集合完全对称 ✓（' + zhKeys.length + ' 键）')

// 文案非空 + 值类型
for (const k of zhKeys) {
  const z = i18n.zh[k], e = i18n.en[k]
  if (typeof z !== 'string' || !z.trim()) { console.log('FAIL zh 空文案:', k); process.exit(1) }
  if (typeof e !== 'string' || !e.trim()) { console.log('FAIL en 空文案:', k); process.exit(1) }
}
console.log('文案非空 ✓（' + zhKeys.length * 2 + ' 条）')
console.log('V2-STEP1 i18n 对称验证 PASS')
