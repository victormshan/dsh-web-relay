// 主 agent：Step 1 打回重提 —— 补充产物证据（artifacts + 验证记录），Step 2 重新触发审核
const fs = require('fs')
const base = 'D:/dsh relay test'
const exprId = 'expr-2026-08-25_02-09-32'
const now = new Date().toISOString()

// 1) Step 1 补充 artifacts + 验证记录到轨迹
const p = `${base}/web-relay/experiments/${exprId}.steps.json`
const st = JSON.parse(fs.readFileSync(p, 'utf8'))
const s1 = st.steps.find((s) => s.id === '1')
s1.artifacts = [
  'step-value/lib/index.js（后端费用解析 API，516 行）',
  'step-value/lib/i18n.js（中英词汇表，29 键）',
  '验证：真实会话 session-a0a01dfa 全量解析 604 assistant/message；工作区解码 --D-dsh~0020relay~0020test-- → D:\\dsh relay test；样例 turn=1 step=1 deepseek-v4-flash costUSD=0.002457；全局 4 工作区 27 会话 3800 turns totalCostUSD=87.37（见轨迹）'
]
st.updatedAt = now
fs.writeFileSync(p, JSON.stringify(st, null, 2), 'utf8')
console.log('Step 1 artifacts 已关联产物证据')

// 2) 轨迹补充 Step 1 验证记录
const tp = `${base}/web-relay/traces/${exprId}.md`
let t = fs.readFileSync(tp, 'utf8')
const entry = `## [主 agent] ${now}

Step 1 打回重提 —— 补充产物证据与验证记录

【产物】
- step-value/lib/index.js：516 行，三 API（/step-value/summary /tree /step-details）+ MODEL_PRICES 价格表（deepseek-v4-flash/chat/reasoner，input/output/cacheRead/reasoning USD 单价）+ USD_TO_CNY=7.2
- step-value/lib/i18n.js：zh/en 29 键对称

【真实验证数据】
- 工作区解码：--D-dsh~0020relay~0020test-- → D:\\dsh relay test（对照官方 projectKey 源码）
- 会话 session-a0a01dfa 全量解析：18,744 帧 → 604 个 assistant/message，title=测试Shell与HTTP运行
- Turn 样例：turn=1 step=1 deepseek-v4-flash/deepseek-official tokens{input:6241,output:456,cacheRead:2048,reasoning:230,total:8975} costUSD=0.002457 costCNY=0.017690
- 全局汇总：4 工作区 27 会话 3800 turns totalCostUSD=87.371972 totalCostCNY=629.078224（D:\\dsh relay test：17 会话 1999 turns $49.26）

node --check 通过。`
t = t.trimEnd() + '\n\n' + entry + '\n'
fs.writeFileSync(tp, t, 'utf8')
console.log('轨迹已补充验证记录')
