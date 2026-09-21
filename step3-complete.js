// 主 agent：Step 3 完成 → review
const fs = require('fs')
const base = 'D:/dsh relay test'
const exprId = 'expr-2026-08-24_22-40-15'
const tracePath = `${base}/web-relay/traces/${exprId}.md`
const stepsPath = `${base}/web-relay/experiments/${exprId}.steps.json`
const now = new Date().toISOString()

const st = JSON.parse(fs.readFileSync(stepsPath, 'utf8'))
const s3 = st.steps.find((s) => s.id === '3')
s3.status = 'review'
s3.notes = s3.notes || []
s3.notes.push({ role: 'mainagent', at: now, action: 'complete', text: '审核回路连通测试完成：状态机流转（start/complete/approve/reject/reopen）与依赖门控均验证通过' })
st.updatedAt = now
fs.writeFileSync(stepsPath, JSON.stringify(st, null, 2), 'utf8')

let trace = fs.readFileSync(tracePath, 'utf8')
const entry = `## [主 agent] ${now}

Step 3 执行完成（逐步执行与审核回路 v1.3/v1.5 连通测试）—— PASS
- 状态机流转：start→executing→complete→review→(approve|reject) 全链路代码验证通过
- 依赖门控：Step4/5 在 Step3 未 approved 时保持 pending（阻断）✓
- 现提交审核。`
trace = trace.trimEnd() + '\n\n' + entry + '\n'
fs.writeFileSync(tracePath, trace, 'utf8')
console.log('Step 3 → review，轨迹已写')
