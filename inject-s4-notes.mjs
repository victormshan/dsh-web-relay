// 将完整测试+发布验证日志注入 Step 4 notes（外部 AI 审核上下文直接读 notes）
import fs from 'node:fs'
const stepsPath = 'D:/dsh relay test/web-relay/experiments/expr-2026-08-26_13-49-58.steps.json'
const log = fs.readFileSync('D:/dsh relay test/verify-s4-release.log', 'utf8')
const state = JSON.parse(fs.readFileSync(stepsPath, 'utf8'))
const s4 = state.steps.find((s) => s.id === '4')
if (!s4) { console.log('FAIL: step 4 not found'); process.exit(1) }
s4.notes = s4.notes || []
s4.notes.push({
  role: 'mainagent',
  at: new Date().toISOString(),
  action: 'complete',
  text: 'Step 4 测试与发布验证日志（完整控制台输出）：\n' + log
})
fs.writeFileSync(stepsPath, JSON.stringify(state, null, 2) + '\n', 'utf8')
console.log('notes 已注入，Step 4 notes 数 =', s4.notes.length)
