// v1.8 frontend smoke: static marker assertions + isolated-VM execution of
// D:\DSH\dsh-web-relay\lib\client.js (mirrors relay-smoke-test.js pattern:
// mock window.__ModuleLoader__ + mock react, NO Node module/exports globals —
// reproduces browser-only ReferenceErrors).
// Usage: node verify-v18-frontend.mjs
import fs from 'node:fs'
import vm from 'node:vm'

const bundlePath = 'D:\\DSH\\dsh-web-relay\\lib\\client.js'
const code = fs.readFileSync(bundlePath, 'utf8')

// ---- a) static marker assertions (v1.8 protocol support) ----
const required = [
  'protoV18Directive',
  'v1.8',
  'reviewerMainagent',
  'steps/restructure',
  'atomicRejected',
  'batchAtomicReject',
  'restructureBtn',
  'restructurePlaceholder',
  'restructureApply',
  'restructureResult',
  'tmplNA',
  'protocolV18',
  'protoV18',
  "value: 'v1.8'",
  "s.reviewedBy === 'mainagent'",
  'rgba(74,222,128,.5)',
  'dsh-web-relay:protocol-version',
  "if (v === 'v1.6' || v === 'v1.7' || v === 'v1.8' || v === 'v1.9') return v",
  'v1.8 混合模式',
  'v1.8 Hybrid',
  'restructureOpen',
  'applyRestructure',
]
const missing = required.filter((m) => !code.includes(m))
if (missing.length > 0) {
  console.log('FAIL: missing markers ->', JSON.stringify(missing, null, 2))
  process.exit(1)
}
console.log('STATIC MARKERS OK (' + required.length + ' markers present)')

// factory 开头必须是浏览器 bundle 自备 module/exports 的样板
if (!code.includes('var module = { exports: {} }; var exports = module.exports;')) {
  console.log('FAIL: factory does not start with the browser module/exports boilerplate')
  process.exit(1)
}
// 只用小写 react 绑定（禁止 react/jsx-runtime、禁止 import from 'react'）
if (code.includes("require('react/jsx-runtime')") || /\bfrom\s+'react'/.test(code)) {
  console.log('FAIL: JSX runtime or ESM react import detected (must stay lowercase require react)')
  process.exit(1)
}
console.log('FACTORY HEADER OK (browser boilerplate + lowercase react only)')

// ---- b) isolated-VM execution (relay-smoke-test.js pattern) ----
let loaded = null
const recorded = { injects: [], styles: [] }

const mockReact = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  createElement: () => ({ __vnode: true }),
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  CustomEvent: function CustomEvent(type) { this.type = type },
  document: {
    addEventListener() {}, removeEventListener() {},
    getElementById() { return null },
    querySelector: () => null,
    head: { append: (el) => recorded.styles.push(el && el.textContent ? el.textContent : '') },
    createElement: () => ({ dataset: {}, textContent: '' }),
    documentElement: { removeAttribute() {}, setAttribute() {}, style: { removeProperty() {}, setProperty() {} } },
    body: { style: {} },
  },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  navigator: {},
  location: { href: 'http://127.0.0.1:3080' },
  URL,
  InputEvent: function InputEvent() {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
}
sandbox.window = sandbox
sandbox.window.__ModuleLoader__ = { load: (mod) => { loaded = mod } }
sandbox.window.addEventListener = () => {}
sandbox.window.removeEventListener = () => {}
sandbox.window.dispatchEvent = () => true
sandbox.window.innerWidth = 1600
sandbox.globalThis = sandbox
vm.createContext(sandbox)

try {
  vm.runInContext(code, sandbox, { filename: 'client.js' })
} catch (e) {
  console.log('FAIL at bundle top-level:', (e && e.stack ? e.stack.split('\n')[0] : e))
  process.exit(1)
}

if (!loaded || !loaded.factory) {
  console.log('FAIL: bundle did not call __ModuleLoader__.load with a factory')
  process.exit(1)
}
if (loaded.id !== 'dsh-web-relay') {
  console.log('FAIL: bundle id mismatch (must equal package name):', loaded.id)
  process.exit(1)
}

// requireMock 只允许小写 react；出现任何其它模块（jsx-runtime / Node builtin）即视为失败
const requireMock = (name) => {
  if (name === 'react') return mockReact
  throw new Error('bundle required an unexpected module: ' + name)
}

let mod
try {
  mod = loaded.factory(requireMock)
} catch (e) {
  console.log('FAIL at factory execution:', (e && e.stack ? e.stack.split('\n')[0] : e))
  process.exit(1)
}

if (!mod || typeof mod.apply !== 'function' || !Array.isArray(mod.inject)) {
  console.log('FAIL: module.exports missing inject/apply')
  process.exit(1)
}

const slots = {
  inject: (name, fn) => recorded.injects.push({ name, hasFn: typeof fn === 'function' }),
}
const ctx = { get: (k) => (k === 'slots' ? slots : undefined) }
try {
  mod.apply(ctx)
} catch (e) {
  console.log('FAIL at apply:', (e && e.stack ? e.stack.split('\n')[0] : e))
  process.exit(1)
}

const injectNames = recorded.injects.map((i) => i.name)
const okInject = injectNames.includes('sidebar.footer.action') && injectNames.includes('shell.overlay')
const okCss = recorded.styles.some((s) => s.includes('data-dwr-docked') && s.includes('.dwr-splitter') && s.includes('.dwr-rail'))
if (!okInject || !okCss) {
  console.log('FAIL: slot injections or DOCK_CSS missing ->', JSON.stringify({ injectNames, okCss }))
  process.exit(1)
}

console.log('PASS: id=' + loaded.id + ' injects=' + JSON.stringify(injectNames))
console.log('  DOCK_CSS 注入: OK (' + (recorded.styles[0] ? recorded.styles[0].length : 0) + ' chars)')
console.log('  module.exports: inject=' + JSON.stringify(mod.inject) + ' apply=function')
console.log('SMOKE PASS (v1.8 frontend markers + VM execution, no ReferenceError)')
