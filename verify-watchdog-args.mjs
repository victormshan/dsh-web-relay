// 验证 watchdog.mjs 改动：hostArgv() 是否固化 --no-open / --trusted-host，且不破坏既有行为
// 安全说明：watchdog.mjs 有 isMain 守卫（L397），import 不会启动守护进程。
import { hostArgv, CFG, parseCommand } from 'file:///D:/dsh-web-relay/bin/watchdog.mjs'

const argv = hostArgv()
console.log('  hostArgv() = ' + JSON.stringify(argv))
const checks = [
  ['含 --no-open（防每次重拉开新 tab）', argv.includes('--no-open')],
  ['含 --trusted-host（tailscale/手机访问）', argv.includes('--trusted-host')],
  ['--trusted-host 后有主机名', argv[argv.indexOf('--trusted-host') + 1] === CFG.trustedHost],
  ['仍含 web 子命令', argv.includes('web')],
  ['全是非空字符串（既有测试契约）', argv.every((a) => typeof a === 'string' && a.length > 0)],
  ['端口释放等待参数已生效', CFG.portFreeWaitMs > 0 && CFG.portFreePollMs > 0],
]
let bad = 0
for (const [name, ok] of checks) { if (!ok) bad++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`) }
console.log(`  trustedHost=${CFG.trustedHost} | noOpen=${CFG.noOpen} | portFreeWaitMs=${CFG.portFreeWaitMs}`)

// 守卫式追加：不应重复（若 DSH_WEB_ARGS 已含该参数）
console.log('\n  --- 重复追加守卫（模拟 DSH_WEB_ARGS 已含 --no-open）---')
const orig = CFG.webArgs
CFG.webArgs = 'web --no-open --trusted-host example.ts.net'
const dup = hostArgv()
CFG.webArgs = orig
const count = (arr, v) => arr.filter((x) => x === v).length
console.log('  ' + JSON.stringify(dup))
const guardOk = count(dup, '--no-open') === 1 && count(dup, '--trusted-host') === 1
console.log(`  [${guardOk ? 'PASS' : 'FAIL'}] 已存在时不重复追加（--no-open ×${count(dup, '--no-open')}, --trusted-host ×${count(dup, '--trusted-host')}）`)
if (!guardOk) bad++

console.log(`\n  RESULT: ${bad === 0 ? 'PASS' : 'FAIL(' + bad + ')'}`)
process.exit(bad === 0 ? 0 : 1)
