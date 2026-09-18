// ccfeat-20260915-selfcheck: 重启后自检钩子单测（真实模块 lib/selfcheck.mjs）
// 全部为纯函数用例：不碰网络、不 spawn 真进程、不读写真实磁盘（listDir/readFile 均为内存 fake）。
// 运行：node --test test/selfcheck.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import {
  computeDrift,
  checkRouteContract,
  needsNotify,
  mapExternalResult,
  shouldSkipBoot,
  sliceHandlerSource,
  isIgnoredArtifact,
  SELFCHECK_REQUIRED_ROUTES,
  SELFCHECK_REQUIRED_HEALTH_FIELDS,
} from '../lib/selfcheck.mjs'
import { extractRoutes } from '../scripts/sync-engine-docs.mjs'
import { computeLoadedLibHash, LOADED_LIB_HASH, LOADED_LIB_DIR } from '../lib/index.js'

/** 构造一对内存 fake（source/runtime 两端），files: { source: {rel: content}, runtime: {rel: content} }，
 *  dirs: { rel: [childRelPaths...] }（模拟目录展开——source/runtime 共用同一份目录结构声明，
 *  实际内容差异由 files 决定）。 */
function makeFakeFsPair({ dirs = {}, files = { source: {}, runtime: {} } } = {}) {
  const listDir = async (root, entry) => dirs[entry] || []
  const readFile = async (root, rel) => {
    const bucket = files[root] || {}
    return Object.prototype.hasOwnProperty.call(bucket, rel) ? bucket[rel] : null
  }
  return { listDir, readFile }
}

const identityHash = (content) => content

// ---- computeDrift ----

test('computeDrift: 两端一致 → drift 为空', async () => {
  const { listDir, readFile } = makeFakeFsPair({
    dirs: { lib: ['lib/index.js', 'lib/selfcheck.mjs'] },
    files: {
      source: { 'lib/index.js': 'AAA', 'lib/selfcheck.mjs': 'BBB' },
      runtime: { 'lib/index.js': 'AAA', 'lib/selfcheck.mjs': 'BBB' },
    },
  })
  const drift = await computeDrift({ manifest: ['lib'], listDir, readFile, hash: identityHash })
  assert.equal(drift.checked, 2)
  assert.deepEqual(drift.differing, [])
})

test('computeDrift: 单文件内容不同 → 精确定位到该相对路径（content-diff）', async () => {
  const { listDir, readFile } = makeFakeFsPair({
    dirs: { lib: ['lib/index.js', 'lib/selfcheck.mjs'] },
    files: {
      source: { 'lib/index.js': 'AAA-fixed', 'lib/selfcheck.mjs': 'BBB' },
      runtime: { 'lib/index.js': 'AAA-old', 'lib/selfcheck.mjs': 'BBB' },
    },
  })
  const drift = await computeDrift({ manifest: ['lib'], listDir, readFile, hash: identityHash })
  assert.deepEqual(drift.differing, [{ path: 'lib/index.js', kind: 'content-diff' }])
})

test('computeDrift: 运行端缺文件 → 归类 missing-runtime（不与 missing-source 混淆）', async () => {
  const { listDir, readFile } = makeFakeFsPair({
    dirs: { lib: ['lib/new-file.mjs'] },
    files: {
      source: { 'lib/new-file.mjs': 'AAA' },
      runtime: {},
    },
  })
  const drift = await computeDrift({ manifest: ['lib'], listDir, readFile, hash: identityHash })
  assert.deepEqual(drift.differing, [{ path: 'lib/new-file.mjs', kind: 'missing-runtime' }])
})

test('computeDrift: 源码端缺文件 → 归类 missing-source（不与 missing-runtime 混淆）', async () => {
  const { listDir, readFile } = makeFakeFsPair({
    dirs: { lib: ['lib/legacy-file.mjs'] },
    files: {
      source: {},
      runtime: { 'lib/legacy-file.mjs': 'AAA' },
    },
  })
  const drift = await computeDrift({ manifest: ['lib'], listDir, readFile, hash: identityHash })
  assert.deepEqual(drift.differing, [{ path: 'lib/legacy-file.mjs', kind: 'missing-source' }])
})

test('computeDrift: 目录伪条目（本身非真实文件）两端都读不到内容 → 不计入 checked/differing', async () => {
  const { listDir, readFile } = makeFakeFsPair({
    dirs: { lib: ['lib/index.js'] },
    files: {
      source: { 'lib/index.js': 'AAA' },
      runtime: { 'lib/index.js': 'AAA' },
    },
  })
  const drift = await computeDrift({ manifest: ['lib'], listDir, readFile, hash: identityHash })
  // 'lib' 条目字面量本身两端都读不到（不是真实文件）→ 不计入 checked，只有 lib/index.js 计入
  assert.equal(drift.checked, 1)
})

// ---- 非源码产物排除（2026-09-15 首次上线实测：部署备份 .bak-vNNN-* 会把自检变成永久误报）----

test('isIgnoredArtifact: 部署备份/临时/编辑器残留 → 排除；真实源码文件名不受影响', () => {
  // 实测命中的三种（运行端仅有、无任何代码引用）
  assert.equal(isIgnoredArtifact('lib/index.js.bak-v495-1789130857136'), true)
  assert.equal(isIgnoredArtifact('lib/index.js.bak-v496-1789216494364'), true)
  assert.equal(isIgnoredArtifact('lib/client.js.bak-v496-1789216494515'), true)
  assert.equal(isIgnoredArtifact('lib/index.js.bak'), true)
  assert.equal(isIgnoredArtifact('lib/index.js.orig'), true)
  assert.equal(isIgnoredArtifact('lib/index.js~'), true)
  assert.equal(isIgnoredArtifact('lib/index.js.tmp'), true)
  assert.equal(isIgnoredArtifact('lib/index.js.swp'), true)
  assert.equal(isIgnoredArtifact('lib/.DS_Store'), true)
  // 必须放过真实源码——否则会把真漂移一起掩盖（这是本排除逻辑最关键的反向约束）
  for (const ok of ['lib/index.js', 'lib/selfcheck.mjs', 'lib/client.js', 'docs/OCC.md', 'lib/backup.js', 'lib/bakon.js']) {
    assert.equal(isIgnoredArtifact(ok), false, `${ok} 不应被排除`)
  }
  assert.equal(isIgnoredArtifact(''), false)
  assert.equal(isIgnoredArtifact(null), false)
})

test('computeDrift: 运行端多出的 .bak 备份不计入 differing，但必须计入 ignored 并回传文件名（不静默丢弃）', async () => {
  const { listDir, readFile } = makeFakeFsPair({
    dirs: { lib: ['lib/index.js', 'lib/index.js.bak-v496-1789216494364'] },
    files: {
      source: { 'lib/index.js': 'AAA' },                                    // 源码端无备份
      runtime: { 'lib/index.js': 'AAA', 'lib/index.js.bak-v496-1789216494364': 'OLD' },
    },
  })
  const drift = await computeDrift({ manifest: ['lib'], listDir, readFile, hash: identityHash })
  assert.deepEqual(drift.differing, [], '备份文件不得被判为 missing-source 漂移（否则每次部署后都假唤醒）')
  assert.equal(drift.checked, 1, '仅真实源码文件参与比对')
  assert.equal(drift.ignored, 1)
  assert.deepEqual(drift.ignoredFiles, ['lib/index.js.bak-v496-1789216494364'])
})

test('computeDrift: 排除逻辑不得掩盖真实漂移——同名真实模块仍必须报出来', async () => {
  const { listDir, readFile } = makeFakeFsPair({
    dirs: { lib: ['lib/index.js', 'lib/newmod.js'] },
    files: {
      source: { 'lib/index.js': 'AAA' },
      runtime: { 'lib/index.js': 'AAA', 'lib/newmod.js': 'HOT-PATCH' },      // 有人往 lib/ 塞了新模块
    },
  })
  const drift = await computeDrift({ manifest: ['lib'], listDir, readFile, hash: identityHash })
  assert.deepEqual(drift.differing, [{ path: 'lib/newmod.js', kind: 'missing-source' }])
  assert.equal(drift.ignored, 0)
})

// ---- needsNotify ----

test('needsNotify: 仅 drift 非空 → 需要通知', () => {
  assert.equal(needsNotify({ drift: { differing: [{ path: 'x', kind: 'content-diff' }] }, contract: { ok: true } }), true)
})

test('needsNotify: 仅 contract 失败 → 需要通知', () => {
  assert.equal(needsNotify({ drift: { differing: [] }, contract: { ok: false, failed: ['route-missing:/x'] } }), true)
})

test('needsNotify: drift 为空且 contract 通过 → 不需要通知', () => {
  assert.equal(needsNotify({ drift: { differing: [] }, contract: { ok: true } }), false)
})

// ---- mapExternalResult ----

test('mapExternalResult: exit=0 → ok', () => {
  const r = mapExternalResult({ exitCode: 0, signal: null, timedOut: false, tail: '' })
  assert.equal(r.ok, true)
  assert.equal(r.reason, null)
})

test('mapExternalResult: exit≠0 → fail 且带 tail', () => {
  const r = mapExternalResult({ exitCode: 3, signal: null, timedOut: false, tail: 'boom\n' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /exit=3/)
  assert.equal(r.tail, 'boom\n')
})

test('mapExternalResult: 超时 → fail 且 reason 含 timeout（与 exit≠0 可区分）', () => {
  const timeoutResult = mapExternalResult({ exitCode: null, signal: 'SIGKILL', timedOut: true, tail: '' })
  const failResult = mapExternalResult({ exitCode: 1, signal: null, timedOut: false, tail: '' })
  assert.equal(timeoutResult.ok, false)
  assert.match(timeoutResult.reason, /timeout/)
  assert.ok(!failResult.reason.includes('timeout'))
})

// ---- shouldSkipBoot ----

test('shouldSkipBoot: 同 bootId → skip', () => {
  assert.equal(shouldSkipBoot({ lastBootId: 'boot-1', currentBootId: 'boot-1' }), true)
})

test('shouldSkipBoot: 不同 bootId → run（不跳过）', () => {
  assert.equal(shouldSkipBoot({ lastBootId: 'boot-1', currentBootId: 'boot-2' }), false)
})

test('shouldSkipBoot: 无历史记录（首次 boot）→ run（不跳过）', () => {
  assert.equal(shouldSkipBoot({ lastBootId: null, currentBootId: 'boot-1' }), false)
})

// ---- checkRouteContract ----

test('checkRouteContract: 路由齐全 + 字段齐备 → ok', () => {
  const r = checkRouteContract({
    registeredRoutes: ['/dsh-web-relay/health-check', '/dsh-web-relay/ask'],
    requiredRoutes: ['/dsh-web-relay/health-check'],
    handlerSource: '{ ok: true, selfCheck: heavy.selfCheck }',
    requiredHealthFields: ['ok', 'selfCheck'],
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.failed, [])
})

test('checkRouteContract: 路由缺失 → 精确报告缺失的路由', () => {
  const r = checkRouteContract({
    registeredRoutes: ['/dsh-web-relay/ask'],
    requiredRoutes: ['/dsh-web-relay/health-check'],
    handlerSource: '{ ok: true }',
    requiredHealthFields: ['ok'],
  })
  assert.equal(r.ok, false)
  assert.deepEqual(r.failed, ['route-missing:/dsh-web-relay/health-check'])
})

test('checkRouteContract: health 字段缺失 → 精确报告缺失的字段', () => {
  const r = checkRouteContract({
    registeredRoutes: ['/dsh-web-relay/health-check'],
    requiredRoutes: ['/dsh-web-relay/health-check'],
    handlerSource: '{ ok: true }',
    requiredHealthFields: ['ok', 'selfCheck'],
  })
  assert.equal(r.ok, false)
  assert.deepEqual(r.failed, ['health-field-missing:selfCheck'])
})

// ---- 源码契约：防止后人图省事把自检外部命令退回同步阻塞实现 ----

test('源码契约: lib/index.js 的自检外部命令实现未使用 execSync（必须异步 spawn，不得阻塞事件循环）', () => {
  const indexPath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const src = readFileSync(indexPath, 'utf8')
  // 精确定位自检外部命令的执行函数本体（而非仅按开关名邻近窗口猜测——函数名字面量唯一，
  // 不会因周边注释长度变化而漂移出窗口）。
  const startMarker = 'async function runSelfCheckExternalCommand'
  const start = src.indexOf(startMarker)
  assert.ok(start !== -1, '未找到 runSelfCheckExternalCommand，自检外部命令执行函数可能被移除或改名')
  const endMarker = 'async function mostRecentExprSessionId'
  const endIdx = src.indexOf(endMarker, start)
  const fnBody = endIdx === -1 ? src.slice(start, start + 3000) : src.slice(start, endIdx)
  assert.ok(!/execSync\s*\(/.test(fnBody), '自检外部命令执行函数内发现 execSync 调用——必须用 node:child_process 的异步 spawn，否则会阻塞事件循环，触发探针超时→watchdog 重启风暴')
  assert.match(fnBody, /spawn\s*\(/, '自检外部命令执行函数内未发现 spawn 调用')
})

// ---- 端到端契约：对**真实 lib/index.js** 跑一遍契约检查 ----
// 2026-09-15 主 agent 修复时补：原实现（切片用 indexOf 找 'const healthCheckHandler = async'）会命中
// **该函数自己的搜索字面量**（位置在真实定义之前），切片退化成 96 字符 → 14 个必需字段全部判为「缺失」
// → 契约检查恒定失败 → 每次宿主重启都假唤醒一次主 agent。原来的 18 个用例全是喂内存 fake 的纯函数用例，
// **从未触碰真实提取路径**，因此全部通过却漏掉了这个必然发生的缺陷。
// 下面这条用例直接对真实源码跑「路由提取 + 切片 + 契约判定」，是本类陷阱的回归守卫。
test('端到端契约: 对真实 lib/index.js 跑契约检查必须通过（守卫切片自匹配陷阱）', () => {
  const indexPath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const src = readFileSync(indexPath, 'utf8')

  const sliced = sliceHandlerSource(src)
  assert.ok(sliced.length > 500, `health handler 切片过短（${sliced.length} 字符）——极可能又命中了搜索字面量自身而非真实定义`)
  // 位置性断言（不能只断言 includes——maxLen 兜底会把锚点之后的真实定义一并吞进来，
  // 于是「切片起点其实是 decoy」这种情况会被 includes 放过。变异测试实测过这个坑。）
  assert.ok(
    sliced.startsWith('const healthCheckHandler = async (req, res)'),
    `切片起点不是真实定义（起点前出现锚点字面量时会命中它）：${JSON.stringify(sliced.slice(0, 60))}`
  )

  const contract = checkRouteContract({
    registeredRoutes: extractRoutes(src),
    requiredRoutes: SELFCHECK_REQUIRED_ROUTES,
    handlerSource: sliced,
    requiredHealthFields: SELFCHECK_REQUIRED_HEALTH_FIELDS,
  })
  assert.equal(contract.ok, true, `真实源码契约检查未通过（会导致每次 boot 假唤醒）：${JSON.stringify(contract.failed)}`)
})

test('端到端契约: 路由提取器必须能提出自检必需的全部路由', () => {
  const indexPath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const routes = extractRoutes(readFileSync(indexPath, 'utf8'))
  const missing = SELFCHECK_REQUIRED_ROUTES.filter((r) => !routes.includes(r))
  assert.deepEqual(missing, [], `真实源码缺少必需路由：${JSON.stringify(missing)}`)
})

test('切片守卫: 锚点字面量出现在源码中较早位置时，必须取真实定义（lastIndexOf）而非首个命中', () => {
  // 构造「搜索字面量在前、真实定义在后」的最小复现——这正是本次线上陷阱的形态。
  // 注意断言必须落在**切片起点**上：只断言 includes 会被 maxLen 兜底放过（变异测试实测）。
  const decoy = `function helper() { return src.indexOf('${'const healthCheckHandler = async'}') }`
  const real = 'const healthCheckHandler = async (req, res) => {\n  const ok = true\n  const selfCheck = 1\n}\n'
  const src = decoy + '\n' + real
  const s = sliceHandlerSource(src)
  assert.ok(
    s.startsWith('const healthCheckHandler = async (req, res)'),
    `切片起点落在 decoy 上（命中搜索字面量自身）：${JSON.stringify(s.slice(0, 60))}`
  )
  assert.ok(s.includes('const selfCheck = 1'), '切片未覆盖到真实定义体')
  assert.equal(sliceHandlerSource(''), '')
  assert.equal(sliceHandlerSource('无锚点'), '')
})

// ---- ccfeat-20260916-chainstats-b: /health-check 接线 ccChainStats（与 ccStats 并列）----
// 编码通道（链条派发）统计接线：把 A4a（lib/cc-stats.mjs 的 loadChainTaskResults +
// summarizeChainTasks）挂到 /health-check，并让 ccChainStats 进入既有重启自检契约。
// 下面 4 条用例均对**真实源码**断言（而非内存 fake），理由同上方端到端契约用例——
// 这类"字段是否真的接线到位"的缺陷，只喂内存 fake 的纯函数用例测不出来。

test('契约清单: SELFCHECK_REQUIRED_HEALTH_FIELDS 包含 ccChainStats，且紧跟在 ccStats 之后', () => {
  const idx = SELFCHECK_REQUIRED_HEALTH_FIELDS.indexOf('ccChainStats')
  assert.ok(idx !== -1, 'SELFCHECK_REQUIRED_HEALTH_FIELDS 未包含 ccChainStats——新字段不会被重启自检自动校验')
  assert.equal(
    SELFCHECK_REQUIRED_HEALTH_FIELDS[idx - 1],
    'ccStats',
    'ccChainStats 未紧跟在 ccStats 之后，清单可读性变差（应与审核通道字段相邻，便于对照）'
  )
})

test('端到端契约: 真实 lib/index.js 的 healthCheckHandler 切片必须暴露 ccChainStats（而非只在 collectHeavyHealth 里出现）', () => {
  const indexPath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const src = readFileSync(indexPath, 'utf8')
  const sliced = sliceHandlerSource(src)
  assert.ok(sliced.length > 500, `health handler 切片过短（${sliced.length} 字符）`)
  assert.ok(
    sliced.includes('ccChainStats'),
    'healthCheckHandler 源码切片内未找到 ccChainStats——字段可能只加到了 collectHeavyHealth，未真正接到响应体'
  )
  assert.match(
    sliced,
    /ccChainStats:\s*heavy\.ccChainStats/,
    'healthCheckHandler 响应体未见 "ccChainStats: heavy.ccChainStats" 赋值'
  )
})

test('源码契约: healthHeavyEmpty 缓存空态补了 ccChainStats: null（与命中缓存时的返回体形状一致）', () => {
  const indexPath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const src = readFileSync(indexPath, 'utf8')
  const start = src.indexOf('const healthHeavyEmpty = () => ({')
  assert.ok(start !== -1, '未找到 healthHeavyEmpty 定义，缓存空态兜底函数可能被移除或改名')
  const end = src.indexOf('async function collectHeavyHealth', start)
  const body = end === -1 ? src.slice(start, start + 2000) : src.slice(start, end)
  assert.match(body, /ccStats:\s*null/, 'healthHeavyEmpty 缺少既有 ccStats: null 兜底（不应被本次改动误删）')
  assert.match(body, /ccChainStats:\s*null/, 'healthHeavyEmpty 未补 ccChainStats: null——重启后首探（未命中缓存）与命中缓存两种情形返回体形状会不一致')
})

test('源码契约: collectHeavyHealth 读取 ccChainStats 时 fail-open（异常一律置 null，不得让 /health-check 500）', () => {
  const indexPath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const src = readFileSync(indexPath, 'utf8')
  const start = src.indexOf('async function collectHeavyHealth')
  assert.ok(start !== -1, '未找到 collectHeavyHealth 定义')
  const end = src.indexOf('function heavyHealth', start)
  const body = end === -1 ? src.slice(start, start + 6000) : src.slice(start, end)
  assert.match(
    body,
    /let ccChainStats = null\s*\n\s*try\s*\{[\s\S]*?\}\s*catch\s*\([^)]*\)\s*\{\s*ccChainStats = null\s*\}/,
    'collectHeavyHealth 内的 ccChainStats 聚合未见 try/catch fail-open 写法——读取/聚合异常可能未兜底为 null，会让 /health-check 500'
  )
  assert.match(
    body,
    /loadChainTaskResults\(/,
    'collectHeavyHealth 未调用 loadChainTaskResults——应复用 A4a 的读取器，不得另立聚合'
  )
  assert.match(
    body,
    /summarizeChainTasks\(/,
    'collectHeavyHealth 未调用 summarizeChainTasks——应复用 A4a 的聚合函数，不得另立分类'
  )
  assert.match(body, /return\s*\{[^}]*ccChainStats[^}]*\}/, 'collectHeavyHealth 的返回体未包含 ccChainStats')
})

// ---- ccfeat-20260917-loadedhash: 已加载代码指纹（宿主到底加载了哪份代码，精确可证）----
// 背景：插件在仓库开发，但运行时加载 profile 安装目录下的副本；只复制文件不重启宿主，
// 运行时仍是旧代码，且 package.json version 不随每次改动变化。故新增 loadedLibHash：
// 对已加载模块目录（lib/）下全部 .js/.mjs 文件计算一次内容指纹，暴露到 /health-check，
// 外部验收器用同一算法独立重算比对——算法必须逐字一致，任何偏差都会导致无法比对。

test('computeLoadedLibHash: 对真实 lib 目录计算结果为 16 位十六进制字符串，且同一目录稳定复现', () => {
  assert.match(LOADED_LIB_HASH, /^[0-9a-f]{16}$/, 'LOADED_LIB_HASH 不是 16 位十六进制字符串')
  const again = computeLoadedLibHash(LOADED_LIB_DIR)
  assert.equal(again, LOADED_LIB_HASH, '同一目录两次计算结果必须一致（稳定复现），且与模块初始化时缓存的值相同')
  assert.match(again, /^[0-9a-f]{16}$/)
})

test('computeLoadedLibHash: 算法必须按规格实现（临时夹具目录手工按规格算出期望值再比对）', () => {
  // 规格：① 取目录下所有 .js/.mjs 文件；② 按 basename 升序排序；③ 每个文件拼一行
  // basename + "\n" + sha256_hex(文件字节内容) + "\n"；④ 顺序连接为 payload；
  // ⑤ loadedLibHash = sha256_hex(payload) 的前 16 个十六进制字符。
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loadedhash-fixture-'))
  try {
    // 刻意用非字母序的文件名，验证实现确实按 basename 升序排序而非目录读取顺序或声明顺序。
    writeFileSync(path.join(dir, 'zeta.js'), 'console.log("z")\n', 'utf8')
    writeFileSync(path.join(dir, 'alpha.mjs'), 'export const a = 1\n', 'utf8')
    // 非 .js/.mjs 文件必须被排除在指纹计算之外。
    writeFileSync(path.join(dir, 'notes.txt'), '不应参与指纹计算', 'utf8')

    const sortedNames = ['alpha.mjs', 'zeta.js'] // 手工按 basename 升序排列（规格 ②）
    let expectedPayload = ''
    for (const name of sortedNames) {
      const bytes = readFileSync(path.join(dir, name))
      expectedPayload += `${name}\n${createHash('sha256').update(bytes).digest('hex')}\n`
    }
    const expected = createHash('sha256').update(expectedPayload, 'utf8').digest('hex').slice(0, 16)

    const actual = computeLoadedLibHash(dir)
    assert.equal(actual, expected, '实现产出的指纹与按规格手工计算的期望值不一致')
    assert.match(actual, /^[0-9a-f]{16}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('契约清单: SELFCHECK_REQUIRED_HEALTH_FIELDS 包含 loadedLibHash（随既有重启自检自动校验）', () => {
  assert.ok(
    SELFCHECK_REQUIRED_HEALTH_FIELDS.includes('loadedLibHash'),
    'SELFCHECK_REQUIRED_HEALTH_FIELDS 未包含 loadedLibHash——新字段不会被重启自检自动校验，装一半不会被抓出'
  )
})

test('端到端契约: 真实 lib/index.js 的 healthCheckHandler 切片必须暴露 loadedLibHash 与 loadedFrom（而非只在模块顶层算了没接线）', () => {
  const indexPath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const src = readFileSync(indexPath, 'utf8')
  const sliced = sliceHandlerSource(src)
  assert.ok(sliced.length > 500, `health handler 切片过短（${sliced.length} 字符）`)
  assert.match(sliced, /loadedLibHash:\s*LOADED_LIB_HASH/, 'healthCheckHandler 响应体未见 "loadedLibHash: LOADED_LIB_HASH" 赋值')
  assert.match(sliced, /loadedFrom:\s*LOADED_LIB_DIR/, 'healthCheckHandler 响应体未见 "loadedFrom: LOADED_LIB_DIR" 赋值')

  const contract = checkRouteContract({
    registeredRoutes: extractRoutes(src),
    requiredRoutes: SELFCHECK_REQUIRED_ROUTES,
    handlerSource: sliced,
    requiredHealthFields: SELFCHECK_REQUIRED_HEALTH_FIELDS,
  })
  assert.equal(contract.ok, true, `真实源码契约检查未通过：${JSON.stringify(contract.failed)}`)
})

test('源码契约: watchdog 探针超时注释已改正为 4000ms 并注明权威来源 bin/watchdog.mjs（不得再写过时的 2000ms）', () => {
  const indexPath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const src = readFileSync(indexPath, 'utf8')
  const anchor = src.indexOf('稳定耗时 ~1520ms')
  assert.ok(anchor !== -1, '未找到探针超时注释所在锚点，注释可能被移除或改写')
  const window = src.slice(anchor, anchor + 400)
  assert.match(window, /探针超时\s*4000ms/, '探针超时注释未写成 4000ms')
  assert.match(window, /bin\/watchdog\.mjs/, '探针超时注释未注明权威来源 bin/watchdog.mjs')
  assert.ok(!/探针超时\s*2000ms/.test(window), '探针超时注释仍残留过时的 2000ms')

  const watchdogPath = fileURLToPath(new URL('../bin/watchdog.mjs', import.meta.url))
  const watchdogSrc = readFileSync(watchdogPath, 'utf8')
  assert.match(
    watchdogSrc,
    /timeoutMs:\s*num\(process\.env\.DSH_WEB_TIMEOUT_MS,\s*4000\)/,
    'bin/watchdog.mjs 的 timeoutMs 默认值权威来源已变化——注释与实现需同步核对'
  )
})
