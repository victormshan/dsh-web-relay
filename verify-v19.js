// v1.9 acceptance: AutoIteration + full-role fallback + protocol exposure
const fs = require('fs')
const i = fs.readFileSync('D:/DSH/dsh-web-relay/lib/index.js', 'utf8')
const c = fs.readFileSync('D:/DSH/dsh-web-relay/lib/client.js', 'utf8')
const docs = fs.readFileSync('D:/DSH/dsh-web-relay/docs/dsh-web-relay-说明书.md', 'utf8')
const readme = fs.readFileSync('D:/DSH/dsh-web-relay/README.md', 'utf8')
const pkg = JSON.parse(fs.readFileSync('D:/DSH/dsh-web-relay/package.json', 'utf8'))

const ik = {
  V19: i.includes('WEB_RELAY_PROTOCOL_VERSION_V19'),
  protoV19: i.includes('protocolV19'),
  autoIter: i.includes('extractAutoIterDecl') && i.includes('rejectStreak') && i.includes("state.status = 'paused'"),
  fallback: i.includes('askChannel = degraded ? \'dialog-fallback\'') && i.includes("providerLabel = '对话模型（降级）'"),
  isConc19: i.includes("v === 'v1.9'"),
  status130: i.includes("version: '1.3.0'"),
  protoTextV19: i.includes('自动迭代协议（v1.9') && i.includes('全角色降级链（v1.9'),
}
const ck = {
  protoV19: c.includes('protoV19Directive'),
  sel19: c.includes("value: 'v1.9'") && c.includes("if (v === 'v1.6' || v === 'v1.7' || v === 'v1.8' || v === 'v1.9')"),
  tmpl19: c.includes("protocolVersion === 'v1.7' || protocolVersion === 'v1.8' || protocolVersion === 'v1.9'"),
  v19state: c.includes("v19: d.protocolV19 || null"),
}
const dk = {
  docV19: docs.includes('3.17') && docs.includes('4.12') && docs.includes('v1.9 自动迭代'),
  readme130: readme.includes('1.3.0'),
  pkg130: pkg.version === '1.3.0',
}
console.log('后端:', JSON.stringify(ik, null, 1))
console.log('前端:', JSON.stringify(ck, null, 1))
console.log('文档:', JSON.stringify(dk, null, 1))
console.log('index.js 行数:', i.split('\n').length, '| client.js 行数:', c.split('\n').length, '| package.json:', pkg.version)

;(async () => {
  try {
    const mod = await import('file:///D:/DSH/dsh-web-relay/lib/index.js')
    console.log('导出常量 V19 =', mod.WEB_RELAY_PROTOCOL_VERSION_V19)
    const all = Object.values(ik).every(Boolean) && Object.values(ck).every(Boolean) && Object.values(dk).every(Boolean) && mod.WEB_RELAY_PROTOCOL_VERSION_V19 === 'v1.9'
    console.log(all ? 'ALL PASS' : 'MISSING')
    process.exit(all ? 0 : 1)
  } catch (e) {
    console.log('import 失败:', e && e.message)
    process.exit(1)
  }
})()
