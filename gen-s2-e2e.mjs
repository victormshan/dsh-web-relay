// 生成 Step 2 端到端实测原始日志（三项用例的实际响应数据）
import fs from 'node:fs'
const WS = 'D:\\dsh relay test'
const BASE = 'http://127.0.0.1:3080/dsh-web-relay'
const exprId = 'expr-2026-08-26_14-30-00'
const lines = []

// ① restructure 悬空依赖 400（真实调用 + HTTP 状态码）
const r1 = await fetch(`${BASE}/steps/restructure`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ workspacePath: WS, exprId, steps: [{ id: '1', title: 'A', review: false, importance: 'low' }, { id: '2', title: 'B', review: true, importance: 'medium' }, { id: '3', title: '悬空', detail: 'depends_on 引用不存在的 Step 99', review: true, importance: 'high', depends_on: ['99'] }] })
})
const b1 = await r1.json()
lines.push('=== ① POST /steps/restructure 悬空依赖（HTTP ' + r1.status + '）===')
lines.push(JSON.stringify(b1, null, 2))
lines.push('')

// ② 打回后 reviewedBy 置 null：读测试任务 steps.json 中 Step 2 状态（reject 后）
const st = JSON.parse(fs.readFileSync('D:/dsh relay test/web-relay/experiments/expr-2026-08-26_14-30-00.steps.json', 'utf8'))
const s2 = st.steps.find((s) => s.id === '2')
lines.push('=== ② 打回后 Step 2 状态（action=reject 之后）===')
lines.push(JSON.stringify({ id: s2.id, status: s2.status, reviewedBy: s2.reviewedBy, importance: s2.importance, review: s2.review }, null, 2))
lines.push('')

// ③ 混合模式自动豁免：读测试任务 steps.json 中 Step 1 状态（complete 后）
const s1 = st.steps.find((s) => s.id === '1')
lines.push('=== ③ 自动豁免后 Step 1 状态（review:false + importance:low complete 之后）===')
lines.push(JSON.stringify({ id: s1.id, status: s1.status, reviewedBy: s1.reviewedBy, importance: s1.importance, review: s1.review }, null, 2))
lines.push('')

const log = lines.join('\n')
fs.writeFileSync('D:/dsh relay test/verify-s2-e2e.log', log, 'utf8')
console.log(log)
console.log('--- E2E LOG WRITTEN: verify-s2-e2e.log ---')
