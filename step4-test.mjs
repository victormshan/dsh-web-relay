// Step 4 策略 C：进程内端到端自动化测试（修正版：async + turnsList）
import { parseSessionLog, computeCost, buildSummary, buildTree, decodeWorkspaceDir, MODEL_PRICES } from 'file:///D:/dsh relay test/step-value/lib/index.js'
import { STEP_VALUE_I18N } from 'file:///D:/dsh relay test/step-value/lib/i18n.js'

const results = []
const check = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' })

// 1. 工作区解码
check('decodeWorkspaceDir', decodeWorkspaceDir('--D-dsh~0020relay~0020test--') === 'D:\\dsh relay test', decodeWorkspaceDir('--D-dsh~0020relay~0020test--'))

// 2. 价格表
check('MODEL_PRICES', MODEL_PRICES['deepseek-v4-flash']?.input === 0.00027, JSON.stringify(MODEL_PRICES['deepseek-v4-flash']))

// 3. 真实会话解析（async）
const logPath = 'C:/Users/Administrator/.dsh/sessions/--D-dsh~0020relay~0020test--/session-a0a01dfa-1c88-4c91-8cbd-25b4d70274c2/session.jsonl.zstd'
const session = await parseSessionLog(logPath)
check('parseSessionLog 返回 turnsList', session && Array.isArray(session.turnsList) && session.turnsList.length > 0, `turns=${session ? session.turnsList.length : 'null'}`)
if (session && session.turnsList.length > 0) {
  const t0 = session.turnsList[0]
  check('turn 含 model', !!t0.model, `${t0.model} / ${t0.provider}`)
  check('turn 含 tokens', !!t0.tokens && typeof t0.tokens.input === 'number', JSON.stringify(t0.tokens))
  check('turn costUSD 计算', typeof t0.costUSD === 'number' && t0.costUSD > 0, `costUSD=${t0.costUSD} costCNY=${t0.costCNY}`)
  const manual = computeCost(t0.tokens, t0.model)
  check('computeCost 一致性', Math.abs(manual - t0.costUSD) < 1e-9, `computeCost=${manual} vs turn.costUSD=${t0.costUSD}`)
}

// 4. buildSummary（真实 sessions 根）
const summary = await buildSummary('C:/Users/Administrator/.dsh/sessions')
check('buildSummary', summary && Array.isArray(summary.workspaces) && summary.workspaces.length > 0 && typeof summary.totalCostUSD === 'number', `workspaces=${summary?.workspaces?.length} totalCostUSD=${summary?.totalCostUSD?.toFixed?.(6)}`)

// 5. buildTree
const tree = await buildTree('C:/Users/Administrator/.dsh/sessions')
check('buildTree', tree && Array.isArray(tree.workspaces) && tree.workspaces.length > 0, `workspaces=${tree?.workspaces?.length}`)

// 6. i18n 对称
check('i18n zh/en 对称', Object.keys(STEP_VALUE_I18N.zh).length === Object.keys(STEP_VALUE_I18N.en).length, `${Object.keys(STEP_VALUE_I18N.zh).length} keys`)

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} | ${r.name} | ${r.detail}`)
console.log(`--- ${results.filter((r) => r.pass).length}/${results.length} passed ---`)
