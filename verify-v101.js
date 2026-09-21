// Verify all 6 v1.0.1 fixes in index.js
const fs = require('fs')
const t = fs.readFileSync('D:/DSH/dsh-web-relay/lib/index.js', 'utf8')
const c = {
  fix1_version100: t.includes("version: '1.0.0'"),
  fix2_dedupe: t.includes('幂等去重') && t.includes('seen.has'),
  fix3_createdKeep: t.includes('保留初始创建时间'),
  fix4_intent: t.includes('intentFinal') && t.includes('intent: payload && payload.intent'),
  fix5_activeSteps: t.includes('activeSteps'),
  fix6_v16Wait: t.includes('暂无就绪步骤（依赖未满足）'),
}
console.log(JSON.stringify(c, null, 1))
console.log('all fixes:', Object.values(c).every(Boolean) ? 'YES' : 'NO')
process.exit(Object.values(c).every(Boolean) ? 0 : 1)
