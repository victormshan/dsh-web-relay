// 补 AutoIteration 声明到 step-value 3 版任务（ask 通道未提取，主 agent 补齐）
import fs from 'node:fs'
const p = 'D:/dsh relay test/web-relay/experiments/expr-2026-08-26_15-17-07.steps.json'
const s = JSON.parse(fs.readFileSync(p, 'utf8'))
s.iterations = 3
s.currentIteration = 1
s.finalAcceptance = '三版后 step-value 功能增强、/summary 性能改善（10s 内返回）、全量验证通过、版本发布 0.3.0 并部署'
s.autoDecision = true
s.rejectStreak = 0
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8')
console.log('AutoIteration 声明已补：iterations=3, currentIteration=1, autoDecision=true')
