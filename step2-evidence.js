// 主 agent：Step 2 打回重提 —— 补 artifacts + 轨迹证据
const fs = require('fs')
const base = 'D:/dsh relay test'
const exprId = 'expr-2026-08-25_02-09-32'
const now = new Date().toISOString()

const p = `${base}/web-relay/experiments/${exprId}.steps.json`
const st = JSON.parse(fs.readFileSync(p, 'utf8'))
const s2 = st.steps.find((s) => s.id === '2')
s2.artifacts = ['step-value/lib/i18n.js（中英词汇表，zh/en 29 键对称）']
st.updatedAt = now
fs.writeFileSync(p, JSON.stringify(st, null, 2), 'utf8')
console.log('Step 2 artifacts 已关联')

const tp = `${base}/web-relay/traces/${exprId}.md`
let t = fs.readFileSync(tp, 'utf8')
const entry = `## [主 agent] ${now}

Step 2 打回重提 —— 补充产物证据
【产物】step-value/lib/i18n.js：STEP_VALUE_I18N（zh/en 各 29 键完全对称）+ STEP_VALUE_I18N_DEFAULT_LOCALE=zh；顶部注释区分 API Turn（每次 assistant/message 的 API 调用，费用统计基本单位）与 Task Step（web-relay Step List 任务步骤）
【验证】node --check 通过；动态 import 对称验证 zh keys:29 | en keys:29 | 对称:true`
t = t.trimEnd() + '\n\n' + entry + '\n'
fs.writeFileSync(tp, t, 'utf8')
console.log('轨迹已补充')
