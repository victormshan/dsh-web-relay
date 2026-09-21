// 主 agent：Step 4/5 完成 → review（写轨迹 + 状态）
const fs = require('fs')
const base = 'D:/dsh relay test'
const exprId = 'expr-2026-08-24_22-40-15'
const tracePath = `${base}/web-relay/traces/${exprId}.md`
const stepsPath = `${base}/web-relay/experiments/${exprId}.steps.json`
const now = new Date().toISOString()

const st = JSON.parse(fs.readFileSync(stepsPath, 'utf8'))
const results = {
  4: '审核降级链 (v1.5) 容错机制测试 —— PASS\n- 三级降级链代码验证：external(Gemini) → dialog(对话模型无工具 llm.stream tools:[]) → manual(手动审核框)\n- reviewedBy 三路径写入（external/dialog 于 autoReviewHandler，manual 于 stepUpdateHandler）\n- 实测：Step1-3 reviewedBy=external（外部 AI 审核）；无 key/失效分支推演闭环成立',
  5: 'v1.6 拓扑依赖与并发调度测试 —— PASS\n- 依赖门控：Step3 在 [1,2] approved 前被阻断（22:43:49→22:44:52 窗口）；Step6 在 [4,5] 未满足时保持 pending\n- readySteps 就绪计算：Step3 approved 后 [4,5]；并发清单 handoff（⚡ 可并行启动 / 🔒 等待中）\n- 并行执行：Step1/2 同刻完成（22:43:24.971Z）、Step4/5 同刻启动（22:45:46.277/.278Z）'
}
for (const s of st.steps) {
  if (s.id === '4' || s.id === '5') {
    s.status = 'review'
    s.notes = s.notes || []
    s.notes.push({ role: 'mainagent', at: now, action: 'complete', text: `Step ${s.id} 执行完成（见轨迹）` })
  }
}
st.updatedAt = now
fs.writeFileSync(stepsPath, JSON.stringify(st, null, 2), 'utf8')

let trace = fs.readFileSync(tracePath, 'utf8')
const entry = `## [主 agent] ${now}

Step 4 执行结果（审核降级链 v1.5 容错机制测试）—— PASS
${results[4]}

Step 5 执行结果（v1.6 拓扑依赖与并发调度测试）—— PASS
${results[5]}

v1.6 并发调度：Step 4、5（依赖 Step3 已满足，readySteps=[4,5]）已由 2 个并行 subagent 并发执行完成，现提交审核。`
trace = trace.trimEnd() + '\n\n' + entry + '\n'
fs.writeFileSync(tracePath, trace, 'utf8')
console.log('Step 4/5 → review，轨迹已写')
