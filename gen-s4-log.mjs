// 生成 Step 4 测试与发布验证日志（真实命令输出，供外部 AI 审核）
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const lines = []
const run = (label, cmd) => {
  lines.push(`### ${label}`)
  lines.push(`$ ${cmd}`)
  try {
    const out = execSync(cmd, { encoding: 'utf8', cwd: 'D:/DSH/dsh-web-relay', timeout: 60000 })
    lines.push(out.trim())
    lines.push('')
  } catch (e) {
    lines.push(`[exit ${e.status}] ${String(e.stdout || '').trim()}`)
    lines.push('')
  }
}

run('语法检查 index.js', 'node --check lib/index.js')
run('语法检查 client.js', 'node --check lib/client.js')
run('集成验证 verify-v18.js', 'node "D:/dsh relay test/verify-v18.js"')
run('后端验证 verify-v18-backend.mjs', 'node "D:/dsh relay test/verify-v18-backend.mjs"')
run('悬空校验验证 verify-s1-dangling.mjs', 'node "D:/dsh relay test/verify-s1-dangling.mjs"')
run('reviewedBy 验证 verify-s2-reviewedby.mjs', 'node "D:/dsh relay test/verify-s2-reviewedby.mjs"')
run('前端 VM 冒烟 verify-v18-frontend.mjs', 'node "D:/dsh relay test/verify-v18-frontend.mjs"')
run('package.json 版本', 'node -e "console.log(JSON.parse(require(\'fs\').readFileSync(\'package.json\',\'utf8\')).version)"')
run('git tag -l v1.2.1', 'git tag -l v1.2.1')
run('git log --oneline -2', 'git log --oneline -2')
run('git status --short', 'git status --short')
run('安装目录版本', 'node -e "console.log(JSON.parse(require(\'fs\').readFileSync(process.env.USERPROFILE + \'/.dsh/profiles/web/node_modules/dsh-web-relay/package.json\',\'utf8\')).version)"')

const log = lines.join('\n')
fs.writeFileSync('D:/dsh relay test/verify-s4-release.log', log, 'utf8')
console.log(log)
console.log('--- LOG WRITTEN: D:\\dsh relay test\\verify-s4-release.log ---')
