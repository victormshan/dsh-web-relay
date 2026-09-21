// 主 agent：写 Step 1/2 执行结果到三方轨迹，并置 steps.json 状态为 review
const fs = require('fs')
const base = 'D:/dsh relay test'
const exprId = 'expr-2026-08-24_22-40-15'
const tracePath = `${base}/web-relay/traces/${exprId}.md`
const stepsPath = `${base}/web-relay/experiments/${exprId}.steps.json`

const now = new Date().toISOString()

// 1) 追加 [主 agent] 轨迹条目（read-modify-write，保持 frontmatter）
let trace = fs.readFileSync(tracePath, 'utf8')
const entry = `## [主 agent] ${now}

Step 1 执行结果（基础通信与轨迹读写校验）—— PASS
- traceHandler/appendTrace（POST /dsh-web-relay/trace）read-modify-write 追加、条目格式与代码自洽
- saveRecord/recordHandler frontmatter 5 字段齐全，记录/轨迹/steps.json 三件套格式完整
- 观察项：statusHandler version 仍为 0.8.0（实际 1.0.0，需修复）；appendTrace 幂等为追加安全

Step 2 执行结果（规则 8 Triage 与格式解析护栏测试）—— PASS
- extractBlocks 正确提取 json:agent-action（trusted）；parseActions 校验 write_file/run_cmd 越界与超时
- extractSteps/normalizeStep 正确透传 depends_on/parallel_group（Step3←[1,2] 等拓扑完整）
- parseHandler 预览端点不执行不落盘；client 一键补全护栏（showGuard/wrapPayload）就位
- 验收：简单任务直接结论（Triage 存在）、复杂任务 steps 提取成功

v1.6 并发调度：Step 1、2（组 base_validation，无依赖）已由 2 个并行 subagent 并发执行完成，现提交审核。`
trace = trace.trimEnd() + '\n\n' + entry + '\n'
fs.writeFileSync(tracePath, trace, 'utf8')

// 2) steps.json：Step 1、2 → review
const st = JSON.parse(fs.readFileSync(stepsPath, 'utf8'))
for (const s of st.steps) {
  if (s.id === '1') {
    s.status = 'review'
    s.notes = s.notes || []
    s.notes.push({ role: 'mainagent', at: now, action: 'complete', text: '基础通信与轨迹读写校验 PASS（并发执行，见轨迹）' })
  }
  if (s.id === '2') {
    s.status = 'review'
    s.notes = s.notes || []
    s.notes.push({ role: 'mainagent', at: now, action: 'complete', text: '规则8 与格式解析护栏测试 PASS（并发执行，见轨迹）' })
  }
}
st.updatedAt = now
fs.writeFileSync(stepsPath, JSON.stringify(st, null, 2), 'utf8')

console.log('轨迹已追加 + Step 1/2 → review')
console.log('Step 状态:', st.steps.map((s) => `${s.id}:${s.status}`).join(' '))
