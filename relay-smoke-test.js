// Smoke-test the dsh-web-relay v0.7.0+layout browser bundle in an isolated VM.
// Usage: node relay-smoke-test.js <path-to-client.js>
const fs = require('fs')
const vm = require('vm')

const bundlePath = process.argv[2]
if (!bundlePath) { console.log('usage: node relay-smoke-test.js <client.js>'); process.exit(2) }
const code = fs.readFileSync(bundlePath, 'utf8')

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

const requireMock = (name) => {
  switch (name) {
    case 'react': return mockReact
    default: throw new Error('bundle required an unexpected module: ' + name)
  }
}

let mod
try {
  mod = loaded.factory(requireMock)
} catch (e) {
  console.log('FAIL at factory execution:', (e && e.stack ? e.stack.split('\n')[0] : e))
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

// 断言
const injectNames = recorded.injects.map((i) => i.name)
const okInject = injectNames.includes('sidebar.footer.action') && injectNames.includes('shell.overlay')
const okCss = recorded.styles.some((s) => s.includes('data-dwr-docked') && s.includes('.dwr-splitter') && s.includes('.dwr-rail'))
console.log('PASS: id=' + loaded.id + ' injects=' + JSON.stringify(injectNames))
console.log('  DOCK_CSS 注入: ' + (okCss ? 'OK (' + recorded.styles[0].length + ' chars)' : 'FAIL'))
if (!okInject) { console.log('FAIL: missing slot injections'); process.exit(1) }
if (!okCss) { console.log('FAIL: DOCK_CSS not injected'); process.exit(1) }
console.log('SMOKE PASS')
