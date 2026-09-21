// 补 AutoIteration 声明到 dialog 修复任务（iterations=3）
import fs from 'node:fs'
const p = 'D:/dsh relay test/web-relay/experiments/expr-2026-08-26_17-49-28.steps.json'
const s = JSON.parse(fs.readFileSync(p, 'utf8'))
s.iterations = 3
s.currentIteration = 1
s.finalAcceptance = 'dialog 兜底（callDialogModel）在模拟 Gemini 429 时能稳定输出评审 JSON；全角色降级链 external→dialog→pause 第二级打通；插件 1.3.1 发布部署'
s.autoDecision = true
s.rejectStreak = 0
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8')
console.log('声明已补：iterations=3, currentIteration=1')
