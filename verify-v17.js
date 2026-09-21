// v1.7 acceptance: verify features in both files
const fs = require('fs')
const i = fs.readFileSync('D:/DSH/dsh-web-relay/lib/index.js', 'utf8')
const c = fs.readFileSync('D:/DSH/dsh-web-relay/lib/client.js', 'utf8')
const ik = {
  V17: i.includes('WEB_RELAY_PROTOCOL_VERSION_V17'),
  alt: i.includes('alternatives'),
  imp: i.includes('importance'),
  batch: i.includes('batchStepIds'),
  artWarn: i.includes('artifactsWarning'),
  protoV17: i.includes('protocolV17'),
  reviewOne: i.includes('reviewOneStep'),
}
const ck = {
  impBadge: c.includes('importanceHigh'),
  batchBtn: c.includes('batchAutoReview'),
  altShow: c.includes('alternatives'),
  artWarnUI: c.includes('artifactsWarning'),
  tmpl: c.includes('tmplDataSchema'),
  v17sel: c.includes('protoV17') || c.includes("'v1.7'"),
}
console.log('后端:', JSON.stringify(ik, null, 1))
console.log('前端:', JSON.stringify(ck, null, 1))
console.log('index.js 行数:', i.split('\n').length, '| client.js 行数:', c.split('\n').length)
const all = Object.values(ik).every(Boolean) && Object.values(ck).every(Boolean)
console.log(all ? 'ALL PASS' : 'MISSING')
process.exit(all ? 0 : 1)
