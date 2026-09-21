// 注入 Step 2 E2E 原始日志到 notes（外部 AI 审核上下文直接读 notes）
import fs from 'node:fs'
const stepsPath = 'D:/dsh relay test/web-relay/experiments/expr-2026-08-26_14-16-21.steps.json'
const log = fs.readFileSync('D:/dsh relay test/verify-s2-e2e.log', 'utf8')
const state = JSON.parse(fs.readFileSync(stepsPath, 'utf8'))
const s2 = state.steps.find((s) => s.id === '2')
s2.notes = s2.notes || []
s2.notes.push({ role: 'mainagent', at: new Date().toISOString(), action: 'complete', text: 'Step 2 端到端实测原始日志（三项用例实际响应）：\n' + log })
s2.artifacts = s2.artifacts || []
if (!s2.artifacts.includes('D:\\dsh relay test\\verify-s2-e2e.log')) s2.artifacts.push('D:\\dsh relay test\\verify-s2-e2e.log')
fs.writeFileSync(stepsPath, JSON.stringify(state, null, 2) + '\n', 'utf8')
console.log('notes 注入完成，Step 2 notes =', s2.notes.length, '| artifacts =', JSON.stringify(s2.artifacts))
