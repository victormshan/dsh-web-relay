// dsh-web-relay · v3.9 S3 宿主 watchdog（bin/watchdog.mjs，独立进程，不进插件 lib）
// 职责：每 CHECK_MS 探测 dsh web 宿主 /health-check；连续 miss ≥ MISS_N 次 →
//   先 POST /admin/prepare-restart（优雅落盘+停新任务领取）→ 树杀旧 PID → 重新拉起宿主；
//   防风暴：WINDOW_MS 内重启 ≥ MAX_RESTARTS 次则暂停 PAUSE_MS。
// 参考骨架：dsh-web-gemini-ext/bridge-watchdog.mjs（崩溃自愈 + 防风暴限速）。
// 运行：node bin/watchdog.mjs            （Windows 计划任务 AtLogOn，任务名 DSH-WEB-Watchdog）
// 环境变量：DSH_WEB_PORT / DSH_WEB_CMD（整条命令，优先）/ DSH_WEB_BIN / DSH_WEB_ARGS /
//           DSH_NODE_EXE / DSH_RELAY_GC_MS 无关；CHECK_MS/TIMEOUT_MS/MISS_N/MAX_RESTARTS/WINDOW_MS/PAUSE_MS 可覆盖
import { spawn, spawnSync, execSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// v4.9.2/lx_2: 跨平台操作抽象层（win/linux 双实现，见 lib/platform-ops.js）——Windows 行为不变
import { createPlatformOps } from '../lib/platform-ops.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const platformOps = createPlatformOps()   // 按 process.platform 选用（win32 走 taskkill/netstat/reg）
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }

export const CFG = {
  port: Number(process.env.DSH_WEB_PORT) || 3080,
  checkMs: num(process.env.DSH_WEB_CHECK_MS, 5000),
  // v4.9.5（重启风暴修复）: 探针超时 2000 → 4000ms。
  // 实测 /dsh-web-relay/health-check 原耗时稳定 ~1520ms（扫全部 expr + 两次 bridge HTTP），
  // 2000ms 超时余量太小，负载稍高即超时；现已给该端点加 TTL 缓存（毫秒级），
  // 但仍保留更宽的超时余量，避免"探针抖动 = 杀宿主"。
  timeoutMs: num(process.env.DSH_WEB_TIMEOUT_MS, 4000),
  // v4.9.5（重启风暴修复）: 连续失联阈值 3 → 6。
  // 原值 3（约 15s）在机器繁忙/宿主刚重启（bootResumeScan 扫描期）时会误判，触发 kill+拉起；
  // 重启后宿主更慢 → 再次误判 → 自我维持的重启风暴（2026-09-11 实测单日拉起宿主 18 次、
  // 判定重启 37 次，主 agent 回合被反复打断）。6 次 ≈ 30s 连续失联才动手，仍能兜住真挂。
  missN: Math.floor(num(process.env.DSH_WEB_MISS_N, 6)),
  restartDelayMs: num(process.env.DSH_WEB_RESTART_DELAY_MS, 2000),
  // v4.9.10（EADDRINUSE 死循环修复）: 重启时不再「固定 2s 后盲 spawn」，改为**等端口真正释放**。
  // 根因（2026-09-15 实测事故）：doRestart 杀掉旧 PID 后固定 restartDelayMs 就 spawn 新宿主，
  // 但旧宿主的 3080 监听未必已释放（TIME_WAIT、慢销毁、或占用者是 taskkill 杀不掉的外来进程，
  // 如另一套 node 安装手工起的 dsh web）。此时新宿主 boot 期即 EADDRINUSE 失败退出
  // （报 "plugin tree failed to load ... listen EADDRINUSE"）→ child.on('exit') 又触发重拉
  // → 「重拉→失败→再重拉」死循环；每次重拉还多开一个浏览器 tab。用户观感即「页面不动了 +
  // tab 一直冒出来」，最终只能手工重启。现改为：轮询端口直到空出才 spawn；超时仍被占则
  // **本次拒绝 spawn**（宁可不拉起也不制造死循环），交给后续 tick 与防风暴门处理。
  portFreeWaitMs: num(process.env.DSH_WEB_PORT_FREE_WAIT_MS, 15000),
  portFreePollMs: num(process.env.DSH_WEB_PORT_FREE_POLL_MS, 500),
  // v4.9.10: 见 hostArgv() 的说明——两个参数必须固化到自愈路径，否则与手工启动不一致。
  noOpen: process.env.DSH_WEB_NO_OPEN !== '0',
  trustedHost: (process.env.DSH_WEB_TRUSTED_HOST || 'win10-dt.taile618c2.ts.net').trim(),
  maxRestarts: Math.floor(num(process.env.DSH_WEB_MAX_RESTARTS, 3)),
  windowMs: num(process.env.DSH_WEB_WINDOW_MS, 10 * 60 * 1000),
  pauseMs: num(process.env.DSH_WEB_PAUSE_MS, 10 * 60 * 1000),
  nodeExe: process.env.DSH_NODE_EXE || (() => { try { return fs.realpathSync(process.execPath) } catch { return process.execPath } })(),
  // 默认宿主命令：<node> <nvm node_modules>/@deepseek-ai/dsh/lib/bin.js web [DSH_WEB_ARGS]
  webBin: process.env.DSH_WEB_BIN || path.join(path.dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  webArgs: (process.env.DSH_WEB_ARGS || 'web').trim(),
  webCmd: (process.env.DSH_WEB_CMD || '').trim(),
  logFile: process.env.DSH_WEB_LOG || path.join(__dirname, 'watchdog-host.log'),
  lockFile: process.env.DSH_WEB_LOCK || path.join(__dirname, '.watchdog.lock'),
  // v4.9.3（根因修复）: 重启请求信号文件——主 agent 的工具进程是宿主进程的**直接子进程**，
  // 直接调用 restart-now / kill-host 会因 taskkill /T /F 把正在执行该命令的工具进程一并杀掉，
  // 导致工具调用结果永不到达、回合卡死（须用户介入才能继续——"每次都停"的根因）。
  // 改为「写信号文件 → 常驻 watchdog（独立进程树，Task Scheduler 下）在后续 tick 执行重启」：
  // 调用方命令毫秒级返回，等主 agent 工具进程退出后 watchdog 才树杀宿主，回合不再中断。
  restartRequestFile: process.env.DSH_WEB_RESTART_REQ || path.join(__dirname, 'restart.request.json'),
  dryRun: process.env.DSH_WEB_DRYRUN === '1',   // 模拟模式：只打日志不 kill/spawn（验收模拟用，防误杀真实宿主）
  // v3.9.3（总守护）：桥接链路托管——探测 8899，发现 DSH-Bridge-Watchdog 未运行则拉起
  bridgePort: Number(process.env.DSH_WEB_BRIDGE_PORT) || 8899,
  bridgeCheckEvery: Math.floor(num(process.env.DSH_WEB_BRIDGE_CHECK_EVERY, 12)), // 每 N 个 tick 查一次桥
  bridgeIgnoreProc: process.env.DSH_WEB_BRIDGE_IGNORE_PROC === '1',               // 模拟：跳过进程存在性检查
  bridgeWatchdogPath: process.env.DSH_BRIDGE_WATCHDOG_PATH || ''                  // 空则运行时按默认候选路径探测（见 resolveBridgeWatchdogPath）
}
// v4.9.5（假告警修复）: 默认桥接守护路径改为**运行时解析**（原在模块加载时 existsSync 一次，
// 若加载时路径不存在/被 env 置空，之后即使文件出现也永远判为"未配置路径"，
// 于是每分钟刷一条"掉线但未配置路径"——实测该噪声刷了数小时，掩盖真实状态）。
export const BRIDGE_WATCHDOG_CANDIDATES = [
  'D:\\DSH\\dsh-web-gemini-ext\\bridge-watchdog.mjs',
  'D:\\dsh relay test\\dsh-web-gemini-ext\\bridge-watchdog.mjs'
]
export function resolveBridgeWatchdogPath(cfg = CFG) {
  if (cfg.bridgeWatchdogPath) return cfg.bridgeWatchdogPath
  for (const c of BRIDGE_WATCHDOG_CANDIDATES) { try { if (fs.existsSync(c)) return c } catch { /* 忽略 */ } }
  return ''
}
const healthUrl = () => `http://127.0.0.1:${CFG.port}/dsh-web-relay/health-check`
const prepareUrl = () => `http://127.0.0.1:${CFG.port}/dsh-web-relay/admin/prepare-restart`
const bridgeProbeUrl = () => `http://127.0.0.1:${CFG.bridgePort}/__token`

// ---------- 纯函数（可单测）----------
// 防风暴门：WINDOW_MS 内重启次数 < max → allow；否则返回需暂停毫秒
export function stormGate(restartTimes, { now = Date.now(), max = CFG.maxRestarts, windowMs = CFG.windowMs, pauseMs = CFG.pauseMs } = {}) {
  const cutoff = now - windowMs
  const recent = restartTimes.filter((t) => t > cutoff)
  if (recent.length < max) return { allow: true, recent: recent.length, pauseRemainingMs: 0 }
  const oldestInWindow = Math.min(...recent)
  return { allow: false, recent: recent.length, pauseRemainingMs: Math.max(0, oldestInWindow + windowMs + pauseMs - now) }
}
export function classifyProbe({ httpOk, okFlag } = {}) { return httpOk === true && okFlag === true }
export function decideRestart({ missCount, missN = CFG.missN } = {}) { return missCount >= missN }
/**
 * v4.9.10（纯函数，可单测）：spawn 前是否该继续等端口释放。
 * @returns {'spawn'|'wait'|'refuse'} 端口已空 → spawn；仍被占且未超时 → wait；
 *   仍被占且已超时 → refuse（拒绝本次 spawn，避免 EADDRINUSE 死循环 + 每次多开一个 tab）。
 */
export function decidePortWait({ holder, elapsedMs, waitMs }) {
  if (holder === null || holder === undefined || holder === '' || holder === 0) return 'spawn'
  return Number(elapsedMs) >= Number(waitMs) ? 'refuse' : 'wait'
}
// 重启尝试门：先判防风暴再记录（暂停期不累计，避免次数无限膨胀）
export function attemptRestart(restartTimes, { now = Date.now(), max = CFG.maxRestarts, windowMs = CFG.windowMs, pauseMs = CFG.pauseMs } = {}) {
  const gate = stormGate(restartTimes, { now, max, windowMs, pauseMs })
  if (!gate.allow) return { allowed: false, pauseRemainingMs: gate.pauseRemainingMs, restartTimes }
  restartTimes.push(now)
  return { allowed: true, pauseRemainingMs: 0, restartTimes }
}
// 简单命令解析：双引号段保持原样（不处理转义），其余按空白拆分
export function parseCommand(cmd) {
  const out = []
  const re = /"([^"]*)"|(\S+)/g
  let m
  while ((m = re.exec(cmd))) out.push(m[1] !== undefined ? m[1] : m[2])
  return out
}
export function hostArgv() {
  if (CFG.webCmd) return parseCommand(CFG.webCmd)
  const base = [CFG.webBin]
  if (CFG.webArgs) base.push(...parseCommand(CFG.webArgs))
  // v4.9.10（tab 泛滥修复）: 固化两个宿主必需参数——此前两者都只存在于手工启动的命令行，
  // watchdog 拉起的宿主两者皆无，于是「自愈重拉」这条路径与手工启动行为不一致。
  // ① --no-open：dsh web 默认会打开浏览器（实测日志 "dsh web: opening the default browser;
  //    pass --no-open to disable"）。watchdog 每次重拉都再开一个 tab → 重拉风暴时 tab 泛滥
  //    （2026-09-11 曾单日拉起宿主 18 次 = 18 个 tab）。守卫式追加，DSH_WEB_NO_OPEN=0 可关闭。
  // ② --trusted-host：经 tailscale 域名/手机访问 GUI 所必需（dsh-web-app 的 webCommand 解析
  //    --host/--port/--trusted-host/--no-open）。DSH_WEB_TRUSTED_HOST 可覆盖。
  if (CFG.noOpen && !base.includes('--no-open')) base.push('--no-open')
  if (CFG.trustedHost && !base.includes('--trusted-host')) base.push('--trusted-host', CFG.trustedHost)
  return base
}

// ---------- 注册表环境补注入（v3.9.1-fix）----------
// 背景：GEMINI_API_KEY 等以 DPAPI blob 存于 User/Machine 环境（dsh 启动时解密注入）。
// 若 watchdog 进程自身 env 缺该变量（继承链早于注册表设置/经深层子进程链拉起），
// 其 spawn 的宿主会丢 key（/status geminiConfigured=false）。
// 修复：spawn 前从注册表 User→Machine 回读指定变量，并入子进程 env。
const REG_USER = 'HKCU\\Environment'
const REG_MACHINE = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
// 解析 `reg query` 输出中的 REG_SZ 值（纯函数可单测；注意 CRLF——先剥行尾 \r 再匹配）
export function parseRegValue(out, name) {
  const lines = String(out || '').split('\n')
  for (const raw of lines) {
    const l = raw.replace(/\r$/, '')
    const m = l.match(/^\s*(\S+)\s+REG_\w+\s+(.*)$/)
    if (m && m[1].toUpperCase() === String(name).toUpperCase()) return m[2].trim()
  }
  return null
}
export function readRegistryEnv(name) {
  // v4.9.2/lx_2: 委托 platform-ops readSecret（win 注册表 User→Machine；linux ~/.dsh/env）——Windows 行为等价
  return platformOps.readSecret(name)
}
export function childEnv() {
  const env = { ...process.env }
  // 仅当进程 env 缺失时补注入（避免覆盖已存在的明文/解密值）
  for (const name of ['GEMINI_API_KEY', 'GEMINI_MODEL']) {
    if (!env[name]) {
      const v = readRegistryEnv(name)
      if (v) env[name] = v
    }
  }
  // v4.9.1-fix（无介入续跑实证）：透传 DSH_SESSION_ID——若 watchdog 自身 env 携带 harness 会话 ID
  // （User setx / launcher 注入），宿主 spawn 时继承，bootResumeScan 即可在 expr 未落盘 sessionId 时
  // 回退唤醒主 agent 会话（lib/index.js resume 分支 wakeSid 回退）。watchdog env 无则跳过（expr 落盘优先）。
  return env
}

// ---------- v3.9.3 总守护：桥接链路（DSH-Bridge-Watchdog / 8899）----------
// 决策（纯函数）：bridge 在线 → ok；bridge 掉线但 watchdog 进程在 → 交给它自愈（不重复拉起）；
// 两者皆无且有路径配置 → spawn-watchdog；无配置 → no-config
export function bridgeDecision({ bridgeAlive, watchdogAlive, path = CFG.bridgeWatchdogPath }) {
  if (bridgeAlive) return { action: 'ok' }
  if (watchdogAlive) return { action: 'watchdog-holds' }
  if (path) return { action: 'spawn-watchdog', path }
  return { action: 'no-config' }
}
// 探测 DSH-Bridge-Watchdog 进程是否在跑（Windows：spawnSync powershell，避开 cmd 引号地狱）
export function bridgeWatchdogRunning() {
  if (CFG.bridgeIgnoreProc) return false
  try {
    const ps = `$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bridge-watchdog' } | Select-Object -First 1; if ($p) { 'FOUND' } else { 'NONE' }`
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 6000 })
    return /FOUND/.test(String(out.stdout || ''))
  } catch { return false }
}

// ---------- 单例锁（v3.9.2：防手动调试与计划任务双开竞态）----------
export function parseLock(text) {
  const n = Number(String(text || '').trim())
  return Number.isInteger(n) && n > 0 ? n : null
}
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return false }
}
export function acquireLock(logFn = log) {
  try {
    const existing = parseLock(fs.existsSync(CFG.lockFile) ? fs.readFileSync(CFG.lockFile, 'utf8') : '')
    if (existing && pidAlive(existing)) {
      logFn(`已有 watchdog 实例在运行（PID=${existing}，锁 ${CFG.lockFile}），本实例退出`)
      return false
    }
    fs.writeFileSync(CFG.lockFile, String(process.pid))
    process.on('exit', () => { try { fs.unlinkSync(CFG.lockFile) } catch {} })
    return true
  } catch (err) {
    logFn(`单例锁获取失败（${err && err.message}），继续运行（不阻断）`)
    return true
  }
}

// ---------- 运行时 ----------
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => { let j = null; try { j = JSON.parse(raw) } catch {}; resolve({ httpOk: res.statusCode === 200, okFlag: j && j.ok === true, body: j }) })
    })
    req.on('timeout', () => { req.destroy(); resolve({ httpOk: false, okFlag: false, error: 'timeout' }) })
    req.on('error', (e) => resolve({ httpOk: false, okFlag: false, error: String((e && e.message) || e) }))
  })
}
function probe() { return httpGetJson(healthUrl(), CFG.timeoutMs).then((r) => ({ alive: classifyProbe(r), ...r })) }
function log(line) {
  const msg = `[watchdog ${new Date().toISOString()}] ${line}`
  console.log(msg)
  try { fs.appendFileSync(CFG.logFile, msg + '\n') } catch {}
}
function prepareBestEffort() {
  httpGetJson(prepareUrl(), 3000).catch(() => {}) // fire-and-forget
}
function killPidTree(pid) {
  // v4.9.2/lx_2: 委托 platform-ops（win taskkill /T /F；linux pkill -P + kill -TERM）
  return platformOps.killPidTree(pid).ok
}
function findPortPid() {
  // v4.9.2/lx_2: 委托 platform-ops（win netstat -ano；linux ss -ltnp / lsof -iTCP）
  return platformOps.findPortPid(CFG.port)
}

let child = null
let missCount = 0
let tickCount = 0
const restartTimes = []

function spawnHost() {
  const argv = hostArgv()
  const env = childEnv() // v3.9.1-fix: 补注入注册表 GEMINI_API_KEY/GEMINI_MODEL（防深层链丢 key）
  const injected = Object.keys(env).filter((k) => (k === 'GEMINI_API_KEY' || k === 'GEMINI_MODEL') && env[k] !== process.env[k])
  log(`拉起宿主：${CFG.nodeExe} ${argv.join(' ')}${injected.length ? `（env 补注入：${injected.join(',')}）` : ''}`)
  let out
  try { out = fs.openSync(CFG.logFile, 'a') } catch { out = 'ignore' }
  child = spawn(CFG.nodeExe, argv, { cwd: __dirname, stdio: ['ignore', out, out], windowsHide: true, env })
  child.on('exit', (code, signal) => {
    log(`宿主退出（code=${code} signal=${signal}）；${CFG.restartDelayMs}ms 后重新探测`)
    child = null
    setTimeout(() => { if (!child) tick() }, CFG.restartDelayMs)
  })
  child.on('error', (err) => { log(`宿主启动失败：${err.message}`); child = null })
}

function doRestart() {
  const attempt = attemptRestart(restartTimes)
  if (!attempt.allowed) { log(`防风暴暂停：暂停 ${Math.round(attempt.pauseRemainingMs / 1000)}s（窗口内已重启 ${restartTimes.length} 次，暂停期不累计）`); return }
  if (CFG.dryRun) {
    log(`[DRYRUN] 将执行重启流程：POST /admin/prepare-restart → taskkill 旧 PID → spawn 宿主（${CFG.nodeExe} ${hostArgv().join(' ')}）；防风暴仍生效（已重启 ${restartTimes.length} 次）`)
    return
  }
  prepareBestEffort()
  log('触发重启流程：已请求 /admin/prepare-restart（优雅落盘）')
  if (child) { killPidTree(child.pid); child = null }
  const pid = findPortPid()
  if (pid) { log(`树杀旧宿主 PID=${pid}`); killPidTree(pid) }
  // v4.9.10: 原为 setTimeout(spawnHost, CFG.restartDelayMs) —— 盲等固定 2s 即 spawn，
  // 未确认 3080 已释放 → 新宿主 EADDRINUSE 即退 → 重拉死循环 + tab 泛滥（详见 CFG.portFreeWaitMs）。
  scheduleSpawnAfterPortFree()
}

/**
 * v4.9.10：等端口真正释放后再 spawn 宿主。
 * 轮询 findPortPid()（Windows: netstat -ano LISTENING，不做 TIME_WAIT 判定）直到为空；
 * 超过 CFG.portFreeWaitMs 仍被占用则**拒绝本次 spawn** 并记录占用 PID——宁可暂不拉宿主，
 * 也不要制造「拉起来就 EADDRINUSE 退出」的死循环（每次循环都会多开一个浏览器 tab）。
 */
function scheduleSpawnAfterPortFree() {
  const deadline = Date.now() + CFG.portFreeWaitMs
  const step = () => {
    const holder = findPortPid()
    const decision = decidePortWait({ holder, elapsedMs: CFG.portFreeWaitMs - Math.max(0, deadline - Date.now()), waitMs: CFG.portFreeWaitMs })
    if (decision === 'spawn') {
      const waited = CFG.portFreeWaitMs - Math.max(0, deadline - Date.now())
      if (waited > CFG.portFreePollMs) log(`端口 ${CFG.port} 已释放（等待 ${Math.round(waited)}ms）→ 拉起宿主`)
      spawnHost()
      return
    }
    if (decision === 'refuse') {
      log(`端口 ${CFG.port} 等待 ${CFG.portFreeWaitMs}ms 后仍被 PID=${holder} 占用 → 本次不 spawn（避免 EADDRINUSE 死循环与 tab 泛滥）；交由后续 tick 与防风暴门处理`)
      setTimeout(() => { if (!child) tick() }, CFG.checkMs)
      return
    }
    setTimeout(step, CFG.portFreePollMs)
  }
  setTimeout(step, Math.min(CFG.restartDelayMs, CFG.portFreePollMs))
}

async function tick() {
  tickCount += 1
  const r = await probe()
  if (r.alive) {
    if (missCount > 0) { log(`宿主恢复（此前连续 miss ${missCount} 次）`); missCount = 0 }
    if (child && !child.killed && child.exitCode === null) { /* 子进程存活且端口通 → 正常 */ }
  } else {
    missCount += 1
    if (decideRestart({ missCount })) {
      log(`连续 miss ${missCount} 次（≥${CFG.missN}）→ 重启宿主（err=${r.error || '无响应'}）`)
      missCount = 0
      doRestart()
    } else {
      log(`miss ${missCount}/${CFG.missN}（${r.error || '无响应'}）`)
    }
  }
  // v3.9.3 总守护：周期检查桥接链路（DSH-Bridge-Watchdog / 8899）
  if (CFG.bridgeCheckEvery > 0 && tickCount % CFG.bridgeCheckEvery === 0) {
    await auxBridgeTick().catch((e) => log(`[bridge] aux 检查异常：${String((e && e.message) || e).slice(0, 200)}`))
  }
  // v4.9.3（根因修复）: 处理主 agent 重启请求信号——由常驻 watchdog（独立进程树）执行，
  // 避免调用方的工具进程随宿主树被杀（详见 CFG.restartRequestFile 注释）。
  checkRestartRequest()
}

/**
 * 检查并执行主 agent 的重启请求（信号文件）。
 * 到期后删除信号文件并执行 doRestart()；执行前再确认一次（防重复触发）。
 */
function checkRestartRequest() {
  let raw = null
  try { raw = fs.readFileSync(CFG.restartRequestFile, 'utf8') } catch { return } // 无请求
  let req = null
  try { req = JSON.parse(raw) } catch { /* 内容损坏：清理 */ }
  if (!req || typeof req.at !== 'number') {
    try { fs.unlinkSync(CFG.restartRequestFile) } catch {}
    log('[restart-request] 信号文件内容无效，已清理')
    return
  }
  if (Date.now() < req.at) return // 未到期
  try { fs.unlinkSync(CFG.restartRequestFile) } catch {}
  log(`[restart-request] 收到主 agent 重启请求（requestedAt=${new Date(req.requestedAt || 0).toISOString()} reason=${req.reason || '-'}）→ 执行重启`)
  doRestart()
}

let childBridge = null
let bridgeDownStreak = 0
// v4.9.6（回归修复）: v4.9.5 重写 auxBridgeTick 时误删了本行声明，而下方
// attemptRestart(bridgeRestartTimes) 仍在引用 → 每分钟抛 ReferenceError
// （日志实测 "[bridge] aux 检查异常：bridgeRestartTimes is not defined"），
// bridge 监护那一层静默失效。教训与 lesson 050 同类（改块时漏声明/漏参）；
// 已补源码级回归测试（test/watchdog.test.js）。
const bridgeRestartTimes = []
let bridgeLastLogKey = ''
let bridgeLogRounds = 0
async function auxBridgeTick() {
  const b = await httpGetJson(bridgeProbeUrl(), 3000)
  // v4.9.5（假告警修复）: 诊断串带上真实原因（超时 / HTTP 码 / 连接错误），
  // 原实现只打"掉线"，无法区分"端口真没在听"与"探测方式/鉴权问题"，导致假告警无法定位。
  const why = b.error ? `probe=${b.error}` : (b.httpOk ? `probe=HTTP ${b.statusCode ?? '?'} okFlag=${b.okFlag}` : 'probe=无响应')
  if (classifyProbe(b)) {
    if (bridgeDownStreak > 0) { bridgeDownStreak = 0; log(`[bridge] 桥接恢复（8899 在线，本轮探针正常）`) }
    bridgeLastLogKey = ''
    bridgeLogRounds = 0
    return
  }
  bridgeDownStreak += 1
  if (bridgeDownStreak < 2) return // 首轮只观察：给既有 DSH-Bridge-Watchdog 自愈窗口（RESTART_DELAY 2s + CHECK 5s）
  const wdAlive = bridgeWatchdogRunning()
  const wdPath = resolveBridgeWatchdogPath()
  const d = bridgeDecision({ bridgeAlive: false, watchdogAlive: wdAlive, path: wdPath })
  // 去重限流：同一原因只在原因变化时或每 10 轮打一次，避免每分钟刷同一条噪声（此前刷了数小时）
  const logKey = `${d.action}|${wdAlive}|${why}`
  bridgeLogRounds += 1
  const shouldLog = logKey !== bridgeLastLogKey || bridgeLogRounds % 10 === 1
  bridgeLastLogKey = logKey
  if (d.action === 'watchdog-holds') {
    if (shouldLog) log(`[bridge] 8899 掉线但 DSH-Bridge-Watchdog 进程在（自愈中，观察第 ${bridgeDownStreak} 轮；${why}）`)
  } else if (d.action === 'no-config') {
    if (shouldLog) log(`[bridge] 8899 掉线且 watchdog 未运行，且候选路径均不存在（${BRIDGE_WATCHDOG_CANDIDATES.join(' ; ')}；${why}），跳过`)
  } else if (d.action === 'spawn-watchdog') {
    const att = attemptRestart(bridgeRestartTimes)
    if (!att.allowed) { log(`[bridge] 防风暴暂停：${Math.round(att.pauseRemainingMs / 1000)}s（窗口内已拉 ${bridgeRestartTimes.length} 次）`); return }
    if (CFG.dryRun) {
      log(`[DRYRUN][bridge] 8899 掉线且 DSH-Bridge-Watchdog 未运行 → 将拉起 ${d.path}（${why}）`)
      return
    }
    log(`[bridge] 8899 掉线且 DSH-Bridge-Watchdog 未运行 → 拉起 ${d.path}（${why}）`)
    childBridge = spawn(CFG.nodeExe, [d.path], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
    childBridge.on('exit', (code) => { log(`[bridge] DSH-Bridge-Watchdog 退出（code=${code}）；下轮复查`); childBridge = null })
    childBridge.on('error', (err) => { log(`[bridge] 拉起失败：${err.message}`); childBridge = null })
  }
}

// 仅作为 CLI 主入口运行时启动（被测试 import 时不执行）
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
  // v4.9.3（根因修复）: request-restart [delaySecs]——写重启信号文件后**立即返回**。
  // 常驻 watchdog 的 tick 检测到信号（到期）后由其执行 prepare→树杀→拉起。
  // 关键：调用方工具进程在树杀前已正常退出，因此不会出现"工具调用被中断、回合卡死"。
  const requestRestart = process.argv[2] === 'request-restart'
  if (requestRestart) {
    const delaySecs = Math.max(0, Number(process.argv[3] || 2))
    const reason = String(process.argv[4] || 'main-agent 请求重启（宿主管家）')
    const payload = { at: Date.now() + delaySecs * 1000, requestedAt: Date.now(), delaySecs, reason, by: `pid:${process.pid}` }
    try {
      fs.writeFileSync(CFG.restartRequestFile, JSON.stringify(payload, null, 2))
      log(`[request-restart] 已写重启信号（${delaySecs}s 后执行）：${CFG.restartRequestFile} | reason=${reason}`)
      console.log(`RESTART_REQUESTED file=${CFG.restartRequestFile} at=${new Date(payload.at).toISOString()}`)
      process.exit(0)
    } catch (e) {
      log(`[request-restart] 写信号失败：${String((e && e.message) || e)}`)
      console.log('RESTART_REQUEST_FAILED')
      process.exit(1)
    }
  }
  // v4.9.1: kill-host 子命令——仅树杀 3080 宿主（不 acquireLock；常驻 watchdog 探测 miss 后自愈拉起新宿主）。
  // 主 agent/面板「重启宿主」的工具化入口（替代每次手写 taskkill 编排脚本）；DRYRUN 演练同 restart-now。
  const killHost = process.argv[2] === 'kill-host'
  if (killHost) {
    if (CFG.dryRun) {
      log(`[DRYRUN][kill-host] 将执行：POST /admin/prepare-restart → 树杀 3080 宿主（常驻 watchdog 探测 miss≥${CFG.missN} 后自愈拉起；不实际执行）`)
    } else {
      log('[kill-host] 触发优雅停机准备（/admin/prepare-restart）…')
      prepareBestEffort()
      await new Promise((r) => setTimeout(r, 600)) // 等待 prepare 生效（落盘/停新任务）
      const pid = findPortPid()
      if (pid) {
        log(`[kill-host] 树杀当前宿主 PID=${pid}（watchdog 将探测自愈拉起）`)
        killPidTree(pid)
      } else {
        log('[kill-host] 未发现 3080 宿主进程（可能已不在线）')
      }
    }
    process.exit(0)
  }
  // v4.9.2（原子重启，根治跨回合句柄丢失）: restart-sync [waitSecs]——kill-host + 内部轮询 wait-healthy，
  // 宿主就绪后一次返回 RESTART_OK bootId=…；超时返回 RESTART_TIMEOUT。Agent 用【同步】单次调用即可闭环，
  // 无需后台 job / 自编 sleep+probe（消除 run_in_background 句柄跨回合失效与 UI 悬挂）。
  const restartSync = process.argv[2] === 'restart-sync'
  if (restartSync) {
    const waitSecs = Math.max(10, Number(process.argv[3] || 90))
    if (CFG.dryRun) {
      log(`[DRYRUN][restart-sync] kill-host + wait-healthy ${waitSecs}s（不实际执行）`)
      console.log('RESTART_OK bootId=DRYRUN')
      process.exit(0)
    }
    log(`[restart-sync] 触发优雅停机准备…`)
    prepareBestEffort()
    await new Promise((r) => setTimeout(r, 600))
    const pid = findPortPid()
    if (pid) { log(`[restart-sync] 树杀当前宿主 PID=${pid}`); killPidTree(pid) }
    else log('[restart-sync] 未发现 3080 宿主进程（可能已不在线），直接进入健康等待')
    const deadline = Date.now() + waitSecs * 1000
    let healthy = null
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000))
      const p = await probe()
      if (p.alive) { healthy = p.body; break }
    }
    if (healthy) {
      log(`[restart-sync] 宿主已拉起 bootId=${healthy.bootId || '?'}`)
      console.log(`RESTART_OK bootId=${healthy.bootId || '?'}`)
    } else {
      log(`[restart-sync] ${waitSecs}s 内宿主未就绪`)
      console.log('RESTART_TIMEOUT')
    }
    process.exit(healthy ? 0 : 1)
  }
  if (!acquireLock()) process.exit(0) // 单例锁：已有实例则退出
  const restartNow = process.argv[2] === 'restart-now'
  if (restartNow) {
    // v4.4 U4: restart-now 原子子命令——prepare → 确认 → 树杀当前宿主 → 进入监控（首检自动拉起新宿主）
    if (CFG.dryRun) {
      log(`[DRYRUN][restart-now] 将执行：POST /admin/prepare-restart → taskkill 当前宿主 → 首检拉起新宿主（不实际执行）`)
    } else {
      log('[restart-now] 触发优雅停机准备…')
      prepareBestEffort()
      await new Promise((r) => setTimeout(r, 800)) // 等待 prepare 生效（落盘/停新任务）
      const pid = findPortPid()
      if (pid) {
        log(`[restart-now] 树杀当前宿主 PID=${pid}`)
        killPidTree(pid)
      } else {
        log('[restart-now] 未发现 3080 宿主进程（可能已不在线），直接进入拉起流程')
      }
      log('[restart-now] 宿主已停，进入监控（首检将立即拉起新宿主）')
    }
  }
  log(`开始守护 dsh web @127.0.0.1:${CFG.port}（每 ${CFG.checkMs / 1000}s 探测，miss ≥ ${CFG.missN} 重启；防风暴 ${CFG.maxRestarts} 次/${CFG.windowMs / 60000}min）`)
  log(`宿主命令：${CFG.nodeExe} ${hostArgv().join(' ')}`)
  ;(async () => {
    // v3.9.2: 启动首检——未响应立即拉起（不等 miss×N 轮询，缩短开机/恢复空窗）
    const r = await probe()
    if (r.alive) log('宿主在线：进入监控模式')
    else {
      log(`启动首检未响应（${r.error || '无响应'}）→ 立即拉起（不等 miss ${CFG.missN} 轮询）`)
      doRestart()
    }
    setInterval(tick, CFG.checkMs)
  })()
}
