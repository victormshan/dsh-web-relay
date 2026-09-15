// sync-engine-docs 回归（V3-1）：引擎↔文档一致性校验器的纯函数用临时夹具覆盖，
// 不读取/依赖真实仓库内容，避免真实文档变化导致测试跟着漂移。
//
// 夹具使用真实临时目录 + 真实 fs.readFileSync（而非内存 map + 手写字符串路径），
// 因为 scripts/sync-engine-docs.mjs 内部用 path.join 拼接 root 与相对路径，
// Windows 上 path.join('/x', 'lib/index.js') 会产出反斜杠路径（'\x\lib\index.js'），
// 若夹具的内存 map 键是手写的正斜杠字符串会永远查不中（ENOENT），导致断言失败。
// 用真实目录 + 真实 fs 让"夹具路径构造"与"脚本路径构造"复用同一套 path.join 规则，
// 从根上消除分隔符不一致，无需对平台路径字符串做任何断言（只断言纯函数返回值）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  collectEngineFacts,
  collectDocFacts,
  diffFacts,
  hasDrift,
} from '../scripts/sync-engine-docs.mjs'

function mkFixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sed-'))
}

function writeFile(root, rel, content) {
  if (content == null) return
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

// 构建一份完整夹具（lib/index.js + 可选 lib 额外文件 + package.json + 三份文档），
// 返回 collectEngineFacts/collectDocFacts/diffFacts 的纯函数计算结果。
// ccHybrid/readme/compat 传 undefined 时故意不落盘该文件，用于覆盖"文档缺失"场景。
function buildFixture({ indexSrc, libExtra = {}, pkgVersion, ccHybrid, readme, compat }) {
  const root = mkFixtureRoot()
  try {
    writeFile(root, 'lib/index.js', indexSrc)
    writeFile(root, 'package.json', JSON.stringify({ name: 'fixture', version: pkgVersion }))
    writeFile(root, 'docs/CC-HYBRID.md', ccHybrid)
    writeFile(root, 'README.md', readme)
    writeFile(root, 'docs/COMPATIBILITY.md', compat)
    for (const [rel, src] of Object.entries(libExtra)) writeFile(root, rel, src)

    const readFile = (p) => fs.readFileSync(p, 'utf8')
    const libFiles = ['lib/index.js', ...Object.keys(libExtra)]
    const engine = collectEngineFacts({ readFile, root, libFiles })
    const docs = collectDocFacts({ readFile, root })
    const diff = diffFacts(engine, docs)
    return { engine, docs, diff }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('无漂移：文档记载了全部路由/开关/版本锚点 → 三类 ok=true，diff 为空', () => {
  const { diff } = buildFixture({
    indexSrc: `
      webServer.register({ kind: 'exact', path: '/dsh-web-relay/status', handler: statusHandler })
      webServer.register({ kind: 'exact', path: '/dsh-web-relay/ask', handler: askHandler })
    `,
    libExtra: { 'lib/health.js': `if (process.env.DSH_FIXTURE_ENABLED) {}` },
    pkgVersion: '1.2.3',
    ccHybrid: '路由：/dsh-web-relay/status 与 /dsh-web-relay/ask；开关：DSH_FIXTURE_ENABLED。',
    readme: '当前版本 1.2.3。',
    compat: '兼容矩阵版本 1.2.3。',
  })

  assert.equal(diff.routes.ok, true)
  assert.deepEqual(diff.routes.missingInDoc, [])
  assert.deepEqual(diff.routes.staleInDoc, [])
  assert.equal(diff.envSwitches.ok, true)
  assert.deepEqual(diff.envSwitches.missingInDoc, [])
  assert.equal(diff.versionAnchors.ok, true)
  assert.equal(hasDrift(diff), false)
})

test('路由缺失：代码注册但文档未记载的路由命中 missing-in-doc', () => {
  const { diff } = buildFixture({
    indexSrc: `
      webServer.register({ kind: 'exact', path: '/dsh-web-relay/status', handler: statusHandler })
      webServer.register({ kind: 'exact', path: '/dsh-web-relay/steps/new-route', handler: newRouteHandler })
    `,
    libExtra: {},
    pkgVersion: '1.0.0',
    ccHybrid: '文档只提到 /dsh-web-relay/status，没提新路由。版本 1.0.0。',
    readme: '版本 1.0.0。',
    compat: '版本 1.0.0。',
  })

  assert.equal(diff.routes.ok, false)
  assert.deepEqual(diff.routes.missingInDoc, ['/dsh-web-relay/steps/new-route'])
  assert.equal(hasDrift(diff), true)
})

test('环境开关缺失：代码使用但文档未记载的开关命中 missing-in-doc', () => {
  const { diff } = buildFixture({
    indexSrc: `webServer.register({ kind: 'exact', path: '/dsh-web-relay/status', handler: statusHandler })`,
    libExtra: { 'lib/foo.js': `const v = process.env.DSH_UNDOCUMENTED_SWITCH` },
    pkgVersion: '1.0.0',
    ccHybrid: '文档记载了 /dsh-web-relay/status，但没提任何 DSH_ 开关。版本 1.0.0。',
    readme: '版本 1.0.0。',
    compat: '版本 1.0.0。',
  })

  assert.equal(diff.envSwitches.ok, false)
  assert.deepEqual(diff.envSwitches.missingInDoc, ['DSH_UNDOCUMENTED_SWITCH'])
  assert.equal(hasDrift(diff), true)
})

test('版本锚点不一致：README/COMPATIBILITY 未记载当前版本号 → ok=false 且列出期望值', () => {
  const { diff } = buildFixture({
    indexSrc: `webServer.register({ kind: 'exact', path: '/dsh-web-relay/status', handler: statusHandler })`,
    libExtra: {},
    pkgVersion: '2.5.0',
    ccHybrid: '文档记载了 /dsh-web-relay/status。',
    readme: '这份 README 还停留在旧版本，尚未更新。',
    compat: '兼容矩阵也没跟上，仍是旧版本。',
  })

  assert.equal(diff.versionAnchors.ok, false)
  assert.equal(diff.versionAnchors.expected, '2.5.0')
  assert.deepEqual(
    diff.versionAnchors.missing.map((m) => m.doc).sort(),
    ['README.md', 'docs/COMPATIBILITY.md']
  )
  for (const m of diff.versionAnchors.missing) assert.equal(m.expected, '2.5.0')
  assert.equal(hasDrift(diff), true)
})

test('版本锚点简写格式：文档用 {major}.{minor}.x 简写锚点也算命中', () => {
  const { diff } = buildFixture({
    indexSrc: `webServer.register({ kind: 'exact', path: '/dsh-web-relay/status', handler: statusHandler })`,
    libExtra: {},
    pkgVersion: '4.9.7',
    ccHybrid: '文档记载了 /dsh-web-relay/status。',
    readme: '插件版本 4.9.x 系列。',
    compat: '兼容矩阵覆盖 4.9.x 系列。',
  })

  assert.equal(diff.versionAnchors.ok, true)
  assert.equal(diff.versionAnchors.missing.length, 0)
  assert.deepEqual(
    diff.versionAnchors.matched.map((m) => m.anchor),
    ['4.9.x', '4.9.x']
  )
})

test('（加分）stale-in-doc：文档写了代码未注册的路由 → 命中 stale-in-doc', () => {
  const { diff } = buildFixture({
    indexSrc: `webServer.register({ kind: 'exact', path: '/dsh-web-relay/status', handler: statusHandler })`,
    libExtra: {},
    pkgVersion: '1.0.0',
    ccHybrid: '文档记载了 /dsh-web-relay/status，还多写了一个 /dsh-web-relay/ghost-route 但代码里从未注册。版本 1.0.0。',
    readme: '版本 1.0.0。',
    compat: '版本 1.0.0。',
  })

  assert.equal(diff.routes.ok, false)
  assert.deepEqual(diff.routes.staleInDoc, ['/dsh-web-relay/ghost-route'])
  assert.deepEqual(diff.routes.missingInDoc, [])
  assert.equal(hasDrift(diff), true)
})

test('文档缺失：docs/CC-HYBRID.md 不存在时给出诊断 warning 而非抛栈', () => {
  const { diff } = buildFixture({
    indexSrc: `webServer.register({ kind: 'exact', path: '/dsh-web-relay/status', handler: statusHandler })`,
    libExtra: {},
    pkgVersion: '1.0.0',
    ccHybrid: undefined, // 故意不落盘：docs/CC-HYBRID.md 不存在
    readme: '版本 1.0.0。',
    compat: '版本 1.0.0。',
  })

  assert.equal(diff.routes.ok, false)
  assert.match(diff.routes.warning, /CC-HYBRID\.md/)
  assert.equal(diff.envSwitches.ok, false)
  assert.equal(hasDrift(diff), true)
})

test('正则无命中：源码里没有任何路由/开关时标记 warning 而非静默通过', () => {
  const { diff } = buildFixture({
    indexSrc: `// 没有任何 webServer.register 调用`,
    libExtra: {},
    pkgVersion: '1.0.0',
    ccHybrid: '空文档。版本 1.0.0。',
    readme: '版本 1.0.0。',
    compat: '版本 1.0.0。',
  })

  assert.equal(diff.routes.ok, true)
  assert.match(diff.routes.warning, /未提取到任何/)
  assert.equal(diff.envSwitches.ok, true)
  assert.match(diff.envSwitches.warning, /未提取到任何/)
})
