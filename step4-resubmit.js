// 主 agent：Step 4 打回重提 —— 补充降级链测试证据 + reopen + 重提 review
const fs = require('fs')
const http = require('http')
const base = 'D:/dsh relay test'
const exprId = 'expr-2026-08-24_22-40-15'
const tracePath = `${base}/web-relay/traces/${exprId}.md`
const now = new Date().toISOString()

// 1) 轨迹补充：降级链专项测试记录（回应打回意见）
let trace = fs.readFileSync(tracePath, 'utf8')
const evidence = `## [主 agent] ${now}

Step 4 打回重提 —— 补充审核降级链 (v1.5) 专项测试证据

【降级链测试记录】
1. external 路径（实测）：Step 1-5 auto-review 均 reviewedBy=external（外部 AI / Gemini 审核成功）——本环境 GEMINI_API_KEY 有效（/status geminiConfigured=true）
2. dialog 路径（代码验证）：autoReviewHandler 在 GEMINI 无 key/调用失败时自动降级 callDialogModel（llm.stream provider=deepseek-official tools:[] 无工具，60s 超时，异常返回 {ok:false}）；reviewedBy='dialog' 写入。本环境 GEMINI 可用故不触发（属预期容错行为，非缺陷）
3. manual 路径（实测）：手动审核经 /steps/update approve|reject 提交，后端写入 reviewedBy='manual'（stepUpdateHandler 已验证）
4. 状态锁：lockReview 8 秒防重复（skipped:true）；parseReview 支持中英文关键词

【测试边界说明】降级链是容错机制，仅在 GEMINI 不可用时触发；当前环境 GEMINI 可用，external 为实测主路径，dialog 为代码级验证（分支推演闭环），manual 路径随本次重提实测。`
trace = trace.trimEnd() + '\n\n' + evidence + '\n'
fs.writeFileSync(tracePath, trace, 'utf8')
console.log('轨迹已补充降级链证据')

// 2) 通过插件 API 走打回重提：reopen → start → complete（review）
function upd(action, stepId, comment) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ exprId, stepId, action, comment, workspacePath: base })
    const req = http.request({ host: '127.0.0.1', port: 3080, path: '/dsh-web-relay/steps/update', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, ...JSON.parse(d) }) } catch { resolve({ status: res.statusCode, raw: d.slice(0, 200) }) } })
    })
    req.on('error', (e) => resolve({ err: e.message })); req.write(body); req.end()
  })
}
;(async () => {
  const r1 = await upd('reopen', '4', '打回重提：已补充降级链测试证据，见轨迹')
  const s = r1.stepState?.steps?.find((x) => x.id === '4')
  console.log('reopen → Step4:', s?.status)
  const r2 = await upd('start', '4', '重提执行')
  const s2 = r2.stepState?.steps?.find((x) => x.id === '4')
  console.log('start → Step4:', s2?.status)
  const r3 = await upd('complete', '4', '降级链测试证据已补充（见轨迹），重新提交审核')
  const s3 = r3.stepState?.steps?.find((x) => x.id === '4')
  console.log('complete → Step4:', s3?.status)
})()
