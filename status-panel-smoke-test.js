// Smoke-test the dsh-status-panel browser bundle in an isolated VM.
// Mirrors the browser: window + __ModuleLoader__ + mock react, NO Node
// module/exports globals — reproduces browser-only ReferenceErrors.
// Usage: node status-panel-smoke-test.js <path-to-client.js>
const fs = require('fs')
const vm = require('vm')

const bundlePath = process.argv[2]
if (!bundlePath) { console.log('usage: node status-panel-smoke-test.js <client.js>'); process.exit(2) }
const code = fs.readFileSync(bundlePath, 'utf8')

let loaded = null
const recorded = { injects: [] }

const mockReact = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  createElement: () => ({ __vnode: true }),
  useSyncExternalStore: () => null,
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  CustomEvent: function CustomEvent(type) { this.type = type },
  document: { addEventListener() {}, removeEventListener() {}, getElementById() { return null } },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  navigator: {},
  location: { href: 'http://127.0.0.1:3080' },
  URL,
  InputEvent: function InputEvent() {},
}
sandbox.window = sandbox
sandbox.window.__ModuleLoader__ = { load: (mod) => { loaded = mod } }
sandbox.window.addEventListener = () => {}
sandbox.window.removeEventListener = () => {}
sandbox.window.dispatchEvent = () => true
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
if (loaded.id !== 'dsh-status-panel') {
  console.log('FAIL: bundle id mismatch (must equal package name):', loaded.id)
  process.exit(1)
}

const requireMock = (name) => {
  switch (name) {
    case 'react': return mockReact
    case 'react/jsx-runtime': return { jsx: () => ({}) }
    case '@deepseek-ai/cordis': return {}
    case '@deepseek-ai/dsh-client-ui-slots': return {}
    case '@deepseek-ai/dsh-client-web-react': return {}
    case '@deepseek-ai/dsh-client-ui-primitives': return {}
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

console.log('PASS: id=' + loaded.id + ' injects=' + JSON.stringify(recorded.injects))
