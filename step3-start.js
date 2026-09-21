// 主 agent：执行 Step 3（逐步执行与审核回路连通测试）
const fs = require('fs')
const base = 'D:/dsh relay test'
const exprId = 'expr-2026-08-24_22-40-15'
const tracePath = `${base}/web-relay/traces/${exprId}.md`
const stepsPath = `${base}/web-relay/experiments/${exprId}.steps.json`
const now = new Date().toISOString()

// 1) Step 3 → executing
const st = JSON.parse(fs.readFileSync(stepsPath, 'utf8'))
const s3 = st.steps.find((s) => s.id === '3')
s3.status = 'executing'
s3.notes = s3.notes || []
s3.notes.push({ role: 'mainagent', at: now, action: 'start', text: '依赖门控验证通过（Step1/2 已 approved），开始执行' })
st.updatedAt = now
fs.writeFileSync(stepsPath, JSON.stringify(st, null, 2), 'utf8')

// 2) 写轨迹（执行过程 + 验证结论）
let trace = fs.readFileSync(tracePath, 'utf8')
const entry = `## [主 agent] ${now}

Step 3 执行结果（逐步执行与审核回路 v1.3/v1.5 连通测试）—— 执行中
- 依赖门控验证：Step 3 依赖 [1,2]；在 Step1/2 approved 前保持 pending（阻断），两者 approved 后解除 → 门控生效
- stepUpdateHandler 状态流转验证（index.js）：start→executing、complete→review、approve→approved、reject→rejected、reopen→pending
- 审核降级链接入：autoReviewHandler 按 external→dialog→manual 执行，reviewedBy 记录
- 打回重提逻辑：reject 后主 agent 修改可 reopen 重提（测试流程见 Step 4）`
trace = trace.trimEnd() + '\n\n' + entry + '\n'
fs.writeFileSync(tracePath, trace, 'utf8')
console.log('Step 3 → executing，轨迹已写')
