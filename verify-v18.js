// v1.8 acceptance: verify mixed-mode features in backend + frontend + docs
const fs = require('fs')
const path = require('path')
const i = fs.readFileSync('D:/DSH/dsh-web-relay/lib/index.js', 'utf8')
const c = fs.readFileSync('D:/DSH/dsh-web-relay/lib/client.js', 'utf8')
const docs = fs.readFileSync('D:/DSH/dsh-web-relay/docs/dsh-web-relay-说明书.md', 'utf8')
const readme = fs.readFileSync('D:/DSH/dsh-web-relay/README.md', 'utf8')
const pkg = JSON.parse(fs.readFileSync('D:/DSH/dsh-web-relay/package.json', 'utf8'))

const ik = {
  V18: i.includes('WEB_RELAY_PROTOCOL_VERSION_V18'),
  protoV18: i.includes('protocolV18'),
  isConcurrent: i.includes('isConcurrent'),
  reviewSpecified: i.includes('reviewSpecified'),
  mainagent: i.includes("'mainagent'"),
  restructure: i.includes('steps/restructure'),
  atomicRejected: i.includes('atomicRejected'),
  statusVersion: i.includes("version: '1.2.0'") || i.includes("version: '1.2.1'") || i.includes("version: '1.3.0'"),
  // 协议文本含 v1.8 混合模式条目
  protoTextV18: /v1\.8/.test(i) && /importance/.test(i) && /review\s*:\s*false/.test(i),
}
const ck = {
  v18Directive: c.includes('protoV18Directive'),
  reviewerMainagent: c.includes('reviewerMainagent'),
  restructureBtn: c.includes('restructureBtn'),
  atomic: c.includes('atomicRejected'),
  tmplNA: c.includes('tmplNA'),
  v18sel: c.includes("'v1.8'"),
  fiveSectionV18: c.includes("protocolVersion === 'v1.7' || protocolVersion === 'v1.8'") || c.includes("'v1.7' || protocolVersion === 'v1.8'"),
}
const dk = {
  v18: docs.includes('v1.8'),
  mixedMode: docs.includes('3.16') || docs.includes('混合模式与分工'),
  v120: docs.includes('4.10'),
  guide: docs.includes('5.15'),
  readme120: readme.includes('1.2.1') || readme.includes('1.2.0'),
  pkg120: pkg.version === '1.2.0' || pkg.version === '1.2.1' || pkg.version === '1.3.0',
}
console.log('后端:', JSON.stringify(ik, null, 1))
console.log('前端:', JSON.stringify(ck, null, 1))
console.log('文档:', JSON.stringify(dk, null, 1))
console.log('index.js 行数:', i.split('\n').length, '| client.js 行数:', c.split('\n').length, '| package.json version:', pkg.version)

// 动态 import index.js 校验协议常量与文本（ESM）
;(async () => {
  try {
    const mod = await import('file:///D:/DSH/dsh-web-relay/lib/index.js')
    console.log('导出常量: V18 =', mod.WEB_RELAY_PROTOCOL_VERSION_V18)
    const protoText = Array.isArray(mod.WEB_RELAY_PROTOCOL) ? mod.WEB_RELAY_PROTOCOL.join('\n') : String(mod.WEB_RELAY_PROTOCOL)
    const hasMixed = /v1\.8[\s\S]{0,400}importance/.test(protoText)
    console.log('协议文本含 v1.8 importance 分工条目:', hasMixed)
    const all = Object.values(ik).every(Boolean) && Object.values(ck).every(Boolean) && Object.values(dk).every(Boolean) && mod.WEB_RELAY_PROTOCOL_VERSION_V18 === 'v1.8'
    console.log(all ? 'ALL PASS' : 'MISSING')
    process.exit(all ? 0 : 1)
  } catch (e) {
    console.log('import 失败:', e && e.message)
    process.exit(1)
  }
})()
