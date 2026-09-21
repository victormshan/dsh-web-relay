// 主 agent：Step 3 完成 → review（补 artifacts + 轨迹）
const fs = require('fs')
const base = 'D:/dsh relay test'
const exprId = 'expr-2026-08-25_02-09-32'
const now = new Date().toISOString()

const p = `${base}/web-relay/experiments/${exprId}.steps.json`
const st = JSON.parse(fs.readFileSync(p, 'utf8'))
const s3 = st.steps.find((s) => s.id === '3')
s3.status = 'review'
s3.artifacts = [
  'step-value/lib/client.js（前端层级看板，465 行）',
  '验证：vm 冒烟通过（id=step-value、slots 注册 sidebar.footer.action + shell.overlay、STEP_VALUE_I18N zh/en 29 键对称）'
]
s3.notes = s3.notes || []
s3.notes.push({ role: 'mainagent', at: now, action: 'complete', text: '前端看板完成（树状侧边栏 + Turn 瀑布流 + 双语），提交审核' })
st.updatedAt = now
fs.writeFileSync(p, JSON.stringify(st, null, 2), 'utf8')
console.log('Step 3 → review，artifacts 已关联')

const tp = `${base}/web-relay/traces/${exprId}.md`
let t = fs.readFileSync(tp, 'utf8')
const entry = `## [主 agent] ${now}

Step 3 执行完成（前端层级看板）—— PASS
- step-value/lib/client.js（465 行）：树状侧边栏（Workspace → Session 层级 + 总开销卡片）+ Turn 费用卡片瀑布流（model/tokens/costUSD/CNY）+ step-details 明细展开
- 中英切换：STEP_VALUE_I18N 29 键内联，localStorage step-value:locale 持久化
- 冒烟验证通过：id=step-value、apply 注册 sidebar.footer.action + shell.overlay、i18n zh/en 对称
- 对接 /step-value/tree、/summary、/step-details（按 ws.dir/s.dir 传参）`
t = t.trimEnd() + '\n\n' + entry + '\n'
fs.writeFileSync(tp, t, 'utf8')
console.log('轨迹已写')
