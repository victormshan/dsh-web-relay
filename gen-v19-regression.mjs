// v1.9 Step 3 端到端回归验证日志生成（真实命令输出）
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const lines = []
const run = (label, cmd, cwd = 'D:/DSH/dsh-web-relay') => {
  lines.push(`### ${label}`)
  lines.push(`$ ${cmd}`)
  try {
    const out = execSync(cmd, { encoding: 'utf8', cwd, timeout: 90000 })
    lines.push(out.trim())
    lines.push('')
  } catch (e) {
    lines.push(`[exit ${e.status}] ${String(e.stdout || e.message || '').trim()}`)
    lines.push('')
  }
}

run('语法检查 index.js', 'node --check lib/index.js')
run('语法检查 client.js', 'node --check lib/client.js')
run('v1.8 集成验证 verify-v18.js', 'node "D:/dsh relay test/verify-v18.js"')
run('v1.8 后端验证 verify-v18-backend.mjs', 'node "D:/dsh relay test/verify-v18-backend.mjs"')
run('v1.8.1 悬空校验 verify-s1-dangling.mjs', 'node "D:/dsh relay test/verify-s1-dangling.mjs"')
run('v1.8.1 reviewedBy verify-s2-reviewedby.mjs', 'node "D:/dsh relay test/verify-s2-reviewedby.mjs"')
run('v1.9 降级链 verify-v19-fallback.mjs', 'node "D:/dsh relay test/verify-v19-fallback.mjs"')
run('v1.9 AutoIteration verify-v19-autoiter.mjs', 'node "D:/dsh relay test/verify-v19-autoiter.mjs"')
run('v1.9 前端 VM 冒烟 verify-v18-frontend.mjs', 'node "D:/dsh relay test/verify-v18-frontend.mjs"')
run('git status', 'git status --short')
run('git log --oneline -3', 'git log --oneline -3')

const log = lines.join('\n')
fs.writeFileSync('D:/dsh relay test/verify-v19-regression.log', log, 'utf8')
console.log(log)
console.log('--- REGRESSION LOG WRITTEN: verify-v19-regression.log ---')
