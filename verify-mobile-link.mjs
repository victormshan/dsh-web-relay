// 手机链路端到端实测（工作区侧工具；供重启清单复跑）
//
// 与 current-link.mjs 的分工：
//   · current-link.mjs   = 从启动行**现读** token + 两侧探针（正确 token 接受 / 错误 token 拒绝）；
//   · 本脚本            = 端到端**实测手机链路**：鉴权语义、SPA 外壳、静态资源字节一致性。
// 为什么要分开：current-link 只证明"token 有效"，不证明"手机打开页面能加载"（静态资源经 ts.net 可能出问题）。
//
// 判据（均按实测语义写，不按预期写）：
//   ① 无 token → 拒绝（401/403），不得放行
//   ② 正确 token → 303/200 且下发 dsh-auth cookie
//   ③ 错误 token → 拒绝
//   ④ 带 cookie → 首页 200 且为 SPA 外壳
//   ⑤ 首页引用的常规静态资源逐个比对：ts.net 与本机 状态码+字节数一致
// 退出码：0 全通过 / 1 有失败 / 3 仪器错误（取不到链接或宿主不可达）/ 4 未验证（瞬时网络错误）
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ===========================================================================
// 判定纯函数（导出以便 --selftest 做两侧控制：只证明"能失败"会误杀正确输入）
// ===========================================================================
/** ① 无 token：按实测语义应为**拒绝**（401/403）。 */
export const judgeNoToken = (status) => status === 401 || status === 403
/** ② 正确 token：接受（303/200）且下发 dsh-auth cookie。 */
export const judgeTokenAccepted = (status, setCookie) => (status === 303 || status === 200) && /dsh-auth/i.test(String(setCookie || ''))
/** ③ 错误 token：拒绝（401/403）。 */
export const judgeWrongTokenRejected = (status) => status === 401 || status === 403
/** ④ 首页：200 且是 SPA 外壳（带 module 脚本或 root 容器）。 */
export const judgeShell = (status, text) => status === 200 && /<div id="root"|type="module"/.test(String(text || ''))
/** ⑤ 静态资源：两侧状态码与字节数一致才通过。 */
export const judgeAssetSame = (ts, local) => Boolean(ts) && Boolean(local) && ts.status === local.status && ts.len === local.len

if (process.argv.includes('--selftest')) {
  const cases = [
    // ---- POS 正控：正确输入必须放行 ----
    ['[POS] 无 token 401 → 判为"已拒绝"', judgeNoToken(401) === true],
    ['[POS] 无 token 403 → 判为"已拒绝"', judgeNoToken(403) === true],
    ['[POS] 正确 token 303 + dsh-auth cookie → 接受', judgeTokenAccepted(303, 'dsh-auth-abc=v1.xyz; Path=/') === true],
    ['[POS] 正确 token 200 + cookie → 接受', judgeTokenAccepted(200, 'dsh-auth-x=y') === true],
    ['[POS] 错误 token 401 → 拒绝', judgeWrongTokenRejected(401) === true],
    ['[POS] 首页 200 + module 脚本 → SPA 外壳', judgeShell(200, '<script type="module" src="/a.js">') === true],
    ['[POS] 首页 200 + root 容器 → SPA 外壳', judgeShell(200, '<div id="root"></div>') === true],
    ['[POS] 资源两侧 200/相同字节 → 一致', judgeAssetSame({ status: 200, len: 100 }, { status: 200, len: 100 }) === true],
    // ---- NEG 负控：错误输入必须被拒（防永真门禁）----
    ['[NEG] 无 token 200 → 必须判失败（鉴权被绕过）', judgeNoToken(200) === false],
    ['[NEG] 正确 token 但未下发 cookie → 必须判失败', judgeTokenAccepted(303, '') === false],
    ['[NEG] 错误 token 却 200 → 必须判失败（错误 token 被接受）', judgeWrongTokenRejected(200) === false],
    ['[NEG] 首页 200 但非 SPA（纯文本）→ 必须判失败', judgeShell(200, 'plain text') === false],
    ['[NEG] 首页 401 → 必须判失败', judgeShell(401, '<div id="root">') === false],
    ['[NEG] 资源字节不一致 → 必须判失败', judgeAssetSame({ status: 200, len: 100 }, { status: 200, len: 68 }) === false],
    ['[NEG] 资源状态码不一致 → 必须判失败', judgeAssetSame({ status: 200, len: 100 }, { status: 401, len: 100 }) === false],
    ['[NEG] 资源缺失（null）→ 必须判失败', judgeAssetSame(null, { status: 200, len: 1 }) === false],
  ]
  let bad = 0
  for (const [n, c] of cases) { if (!c) bad++; console.log(`  [${c ? 'PASS' : 'FAIL'}] ${n}`) }
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`)
  process.exit(bad ? 1 : 0)
}

const WORK = path.dirname(fileURLToPath(import.meta.url))
const HOST = process.env.DSH_TAILNET_HOST || 'https://win10-dt.taile618c2.ts.net'
const LOCAL = 'http://127.0.0.1:3080'

const results = []
const ok = (n, c, d = '') => { results.push({ n, c }); console.log(`  [${c ? 'PASS' : 'FAIL'}] ${n}${d ? ' — ' + d : ''}`) }
const skip = (n, d = '') => { results.push({ n, c: null }); console.log(`  [未验证] ${n}${d ? ' — ' + d : ''}`) }

// ---- 0) 现读当前链接（不写死：token 随重启轮换）----
let link = null
try {
  const out = execFileSync(process.execPath, [path.join(WORK, 'current-link.mjs')], { encoding: 'utf8', timeout: 60000 })
  const m = out.match(/https:\/\/[^\s]*\?token=[A-Za-z0-9_-]+/)
  link = m ? m[0] : null
  const valid = /token 状态：有效/.test(out)
  console.log(`  [${link && valid ? 'PASS' : 'FAIL'}] 现读链接且 current-link 自检为"有效"${link ? '' : '（未解析出链接）'}`)
  results.push({ n: 'current-link 现读且有效', c: Boolean(link && valid) })
  if (!link || !valid) { console.log('  仪器错误：拿不到有效链接，退出'); process.exit(3) }
} catch (e) {
  console.log('  [仪器错误] current-link.mjs 执行失败：' + String(e.message).slice(0, 120))
  process.exit(3)
}
const token = new URL(link).searchParams.get('token')

const get = async (url, headers = {}) => {
  const r = await fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(20000) })
  const buf = Buffer.from(await r.arrayBuffer())
  return { status: r.status, len: buf.length, text: buf.toString('utf8'), setCookie: r.headers.get('set-cookie') }
}

console.log('=== ① 无 token → 必须拒绝 ===')
const a = await get(`${HOST}/`)
ok('无 token 被拒绝（401/403）', judgeNoToken(a.status), `status=${a.status}`)

console.log('=== ② 正确 token → 接受 + 下发 cookie ===')
const b = await get(`${HOST}/?token=${encodeURIComponent(token)}`)
ok('正确 token 被接受（303/200）', judgeTokenAccepted(b.status, b.setCookie), `status=${b.status}`)
const cookie = String(b.setCookie || '').split(';')[0]
ok('下发 dsh-auth cookie', /dsh-auth/i.test(cookie), cookie.slice(0, 50) + '…')

console.log('=== ③ 错误 token → 必须拒绝 ===')
const c = await get(`${HOST}/?token=definitely-wrong-token`)
ok('错误 token 被拒绝（401/403）', judgeWrongTokenRejected(c.status), `status=${c.status}`)

console.log('=== ④ 带 cookie 取首页 ===')
let home = null
try {
  home = await get(`${HOST}/`, { cookie })
  ok('首页为 SPA 外壳（200 + module/root）', judgeShell(home.status, home.text), `status=${home.status} len=${home.len}`)
} catch (e) {
  skip('首页取用', String(e.cause && e.cause.message || e.message).slice(0, 80))
}

console.log('=== ⑤ 静态资源字节一致性（相对路径用 URL 解析，禁止字符串拼接）===')
if (home && home.text) {
  const refs = [...home.text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !u.startsWith('data:') && !u.startsWith('/plugins/??'))
    // 只比"静态资源"：排除根路径 `/`（本机无 cookie 时是 68B 鉴权壳，与 SPA 首页不可比，
    // 该差异已由 ①②③ 的鉴权判据覆盖）。带扩展名或查询串的才算资源。
    .filter((u) => {
      const p = new URL(u, `${HOST}/`).pathname
      return p !== '/' && (/\.[A-Za-z0-9]{1,6}$/.test(p) || new URL(u, `${HOST}/`).search !== '')
    })
  let same = 0, diff = 0
  for (const ref of refs) {
    try {
      const tsUrl = new URL(ref, `${HOST}/`).href
      const loUrl = new URL(ref, `${LOCAL}/`).href
      const x = await get(tsUrl, { cookie })
      const y = await get(loUrl)
      if (judgeAssetSame(x, y)) same++
      else { diff++; console.log(`    不一致 ${ref} → ts=${x.status}/${x.len}B local=${y.status}/${y.len}B`) }
    } catch (e) {
      skip(`资源 ${String(ref).slice(0, 40)}`, String(e.cause && e.cause.message || e.message).slice(0, 60))
    }
  }
  ok(`静态资源 ts.net 与本机一致（${same} 个）`, diff === 0, diff ? `${diff} 个不一致` : `共同 ${refs.length} 个`)
} else {
  skip('静态资源一致性', '首页未取到')
}

const failed = results.filter((r) => r.c === false).length
const unver = results.filter((r) => r.c === null).length
console.log(`\nRESULT: ${results.filter((r) => r.c === true).length}/${results.length - unver} PASS, ${unver} 未验证, ${failed} FAIL`)
console.log(`\n手机打开：${link}`)
console.log('（首次带 token 完成鉴权后靠 dsh-auth cookie 维持；token 每次宿主重启轮换，失效请重新现读）')
process.exit(failed ? 1 : (unver ? 4 : 0))
