// dsh-web-relay 执行辅助：trace 追加 + steps/update 状态推进（node 原生 UTF-8）
// 用法: node relay-api.mjs <op> <json-arg>
//   op=trace    args: {"exprId":"...","role":"mainagent","text":"..."}
//   op=update   args: {"exprId":"...","stepId":"1","action":"complete","comment":"...","role":"mainagent"}
const BASE = 'http://127.0.0.1:3080/dsh-web-relay'
const WS = 'D:\\dsh relay test'
const [,, op, argsJson] = process.argv
const readArgs = (raw) => (raw && raw.startsWith('@') ? JSON.parse(fs.readFileSync(raw.slice(1), 'utf8')) : JSON.parse(raw || '{}'))
import fs from 'node:fs'
const a = readArgs(argsJson)

async function main() {
  if (op === 'trace') {
    const r = await fetch(`${BASE}/trace`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: WS, exprId: a.exprId, role: a.role || 'mainagent', text: a.text })
    })
    const d = await r.json()
    console.log('trace:', JSON.stringify(d).slice(0, 200))
  } else if (op === 'update') {
    const r = await fetch(`${BASE}/steps/update`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: WS, exprId: a.exprId, stepId: a.stepId, action: a.action, comment: a.comment || '', role: a.role || 'mainagent', artifacts: a.artifacts })
    })
    const d = await r.json()
    const st = d.step || {}
    console.log(`update ${a.action} Step ${a.stepId} -> status=${st.status} reviewedBy=${st.reviewedBy || '-'}`)
    if (d.stepState) {
      console.log('all steps:', d.stepState.steps.map((s) => `${s.id}[${s.status}${s.reviewedBy ? ':' + s.reviewedBy : ''}]`).join(' '))
      console.log('task status:', d.stepState.status, '| finalized:', d.stepState.finalized)
    }
    if (d.error) console.log('ERROR:', d.error)
  } else if (op === 'ask') {
    // 通过协议通道（gemini-free / manual）发起任务给外部 AI
    const r = await fetch(`${BASE}/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: WS, provider: a.provider || 'gemini-free', prompt: a.prompt, answer: a.answer || '', intent: a.intent || 'general', protocolVersion: a.protocolVersion || 'v1.5' })
    })
    const d = await r.json()
    console.log('ask ok:', d.ok, '| 记录 id:', d.id || '-', '| 错误:', d.error || '-')
    if (d.id) console.log('record:', `web-relay/experiments/dsh-web-relay-${d.id.slice(5)}.md`)
  } else if (op === 'autoreview') {
    const r = await fetch(`${BASE}/steps/auto-review`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: WS, exprId: a.exprId, stepId: a.stepId, batchStepIds: a.batchStepIds || [], enableSwarm: a.enableSwarm, reviewChannel: a.reviewChannel })
    })
    const d = await r.json()
    console.log('autoreview:', JSON.stringify(d).slice(0, 600))
  } else if (op === 'finalize') {
    const r = await fetch(`${BASE}/steps/finalize`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: WS, exprId: a.exprId })
    })
    const d = await r.json()
    console.log('finalize:', JSON.stringify(d).slice(0, 500))
  } else if (op === 'restructure') {
    const r = await fetch(`${BASE}/steps/restructure`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: WS, exprId: a.exprId, steps: a.steps })
    })
    const d = await r.json()
    console.log('restructure:', JSON.stringify(d).slice(0, 400))
  } else {
    console.log('unknown op')
  }
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
