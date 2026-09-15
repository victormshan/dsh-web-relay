#!/usr/bin/env node
// scripts/sync-engine-docs.mjs — 引擎↔文档一致性校验器（V3-1）
// 三类机器事实：① lib/index.js 里 webServer.register 的路由 path
//              ② lib/*.js 里 process.env.DSH_* 环境开关
//              ③ package.json 的 version 锚点
// 与文档比对：①②比对 docs/CC-HYBRID.md；③比对 README.md + docs/COMPATIBILITY.md。
// 只读校验器：不修改任何文件，文档缺项由人工/主 agent 决定是否补齐。
// 用法：node scripts/sync-engine-docs.mjs [--check] [--json] [--root <dir>]
//   --check  显式声明校验模式（当前是唯一模式，缺省即等价，保留此参数便于未来扩展/脚本调用自文档化）
//   --json   输出机器可读 JSON（字段：ok/engine/diff）
//   --root   指定仓库根目录（默认脚本所在仓库根）
// 退出码：无漂移 exit 0；有漂移（含文档/源码缺失导致的 warning）exit 1。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTE_RE = /webServer\.register\(\{[^}]*?path:\s*'([^']+)'/g
const ENV_RE = /process\.env\.(DSH_[A-Z_]+)/g
// 文档里的路由提取：贪婪匹配尽量长的路径段序列，遇到反引号/引号/空格/星号等非法字符自然截断
const DOC_ROUTE_RE = /\/dsh-web-relay\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*/g

function safeRead(readFile, p) {
  try {
    return readFile(p)
  } catch {
    return null
  }
}

// ---- 纯函数：从源码文本提取机器事实 ----

export function extractRoutes(src) {
  const out = new Set()
  for (const m of String(src || '').matchAll(ROUTE_RE)) out.add(m[1])
  return [...out].sort()
}

export function extractEnvSwitches(src) {
  const out = new Set()
  for (const m of String(src || '').matchAll(ENV_RE)) out.add(m[1])
  return [...out].sort()
}

export function extractDocRoutes(text) {
  const out = new Set()
  for (const m of String(text || '').matchAll(DOC_ROUTE_RE)) out.add(m[0])
  return [...out].sort()
}

// ---- 纯函数：收集引擎事实（IO 经 readFile 注入，测试用夹具替换）----
// libFiles: 待扫描环境开关的 lib/*.js 相对路径列表，由调用方（CLI）枚举后传入，
// 使本函数保持纯粹、可注入、不依赖真实目录结构。
export function collectEngineFacts({ readFile, root, indexPath = 'lib/index.js', libFiles = [], pkgPath = 'package.json' }) {
  const indexSrc = safeRead(readFile, path.join(root, indexPath))
  const routes = extractRoutes(indexSrc)

  const envSet = new Set()
  for (const rel of libFiles) {
    const src = safeRead(readFile, path.join(root, rel))
    if (src == null) continue
    for (const e of extractEnvSwitches(src)) envSet.add(e)
  }

  let version = null
  const pkgSrc = safeRead(readFile, path.join(root, pkgPath))
  if (pkgSrc != null) {
    try {
      const pkg = JSON.parse(pkgSrc)
      version = pkg.version || null
    } catch {
      version = null
    }
  }

  return { routes, envSwitches: [...envSet].sort(), version, indexFound: indexSrc != null, pkgFound: pkgSrc != null }
}

// ---- 纯函数：收集文档事实 ----
export function collectDocFacts({ readFile, root, ccHybridPath = 'docs/CC-HYBRID.md', readmePath = 'README.md', compatPath = 'docs/COMPATIBILITY.md' }) {
  return {
    ccHybrid: { path: ccHybridPath, text: safeRead(readFile, path.join(root, ccHybridPath)) },
    readme: { path: readmePath, text: safeRead(readFile, path.join(root, readmePath)) },
    compat: { path: compatPath, text: safeRead(readFile, path.join(root, compatPath)) },
  }
}

// ---- 版本锚点匹配规则 ----
// 优先精确匹配完整版本号字符串；若文档采用 "{major}.{minor}.x" 简写锚点格式
// （本仓库 docs/COMPATIBILITY.md 出现过 "4.9.x" 这种写法），退化为该简写形式匹配，
// 两者任一命中即视为文档记载了当前版本。
export function versionAnchorMatch(text, version) {
  if (text == null || !version) return null
  if (text.includes(version)) return version
  const parts = String(version).split('.')
  if (parts.length >= 2) {
    const shorthand = `${parts[0]}.${parts[1]}.x`
    if (text.includes(shorthand)) return shorthand
  }
  return null
}

// ---- 纯函数：比对机器事实 vs 文档 ----
export function diffFacts(engine, docs) {
  const result = {
    routes: { ok: true, missingInDoc: [], staleInDoc: [], warning: null },
    envSwitches: { ok: true, missingInDoc: [], warning: null },
    versionAnchors: { ok: true, expected: engine.version, matched: [], missing: [], warning: null },
  }

  const ccText = docs.ccHybrid.text
  if (ccText == null) {
    result.routes.ok = false
    result.routes.warning = `文档不存在或不可读: ${docs.ccHybrid.path}`
    result.envSwitches.ok = false
    result.envSwitches.warning = `文档不存在或不可读: ${docs.ccHybrid.path}`
  } else {
    // 路由：正向缺项 + 反向 stale
    for (const r of engine.routes) {
      if (!ccText.includes(r)) result.routes.missingInDoc.push(r)
    }
    const docRoutes = extractDocRoutes(ccText)
    const engineRouteSet = new Set(engine.routes)
    for (const r of docRoutes) {
      if (!engineRouteSet.has(r)) result.routes.staleInDoc.push(r)
    }
    if (engine.routes.length === 0) {
      result.routes.warning = 'lib/index.js 未提取到任何 webServer.register 路由（正则无命中，需人工确认，未静默通过）'
    }
    if (result.routes.missingInDoc.length > 0 || result.routes.staleInDoc.length > 0) result.routes.ok = false

    // 环境开关：仅正向缺项（文档漏记）
    for (const e of engine.envSwitches) {
      if (!ccText.includes(e)) result.envSwitches.missingInDoc.push(e)
    }
    if (engine.envSwitches.length === 0) {
      result.envSwitches.warning = 'lib/*.js 未提取到任何 process.env.DSH_* 开关（正则无命中，需人工确认，未静默通过）'
    }
    if (result.envSwitches.missingInDoc.length > 0) result.envSwitches.ok = false
  }

  if (!engine.version) {
    result.versionAnchors.ok = false
    result.versionAnchors.warning = 'package.json 未取到 version 字段'
  } else {
    for (const doc of [docs.readme, docs.compat]) {
      if (doc.text == null) {
        result.versionAnchors.ok = false
        result.versionAnchors.missing.push({ doc: doc.path, reason: 'file-not-found' })
        continue
      }
      const matched = versionAnchorMatch(doc.text, engine.version)
      if (matched) {
        result.versionAnchors.matched.push({ doc: doc.path, anchor: matched })
      } else {
        result.versionAnchors.ok = false
        result.versionAnchors.missing.push({ doc: doc.path, reason: 'anchor-not-found', expected: engine.version })
      }
    }
  }

  return result
}

export function hasDrift(diff) {
  return !(diff.routes.ok && diff.envSwitches.ok && diff.versionAnchors.ok)
}

// ---- CLI（纯 IO + 退出码，不含比对逻辑）----

function formatReport(engine, diff) {
  const lines = []
  lines.push('[sync-engine-docs] 三类机器事实计数：')
  lines.push(`  routes=${engine.routes.length} envSwitches=${engine.envSwitches.length} version=${engine.version || '(未知)'}`)
  lines.push('')
  lines.push(`[routes] ok=${diff.routes.ok}${diff.routes.warning ? `  warning=${diff.routes.warning}` : ''}`)
  if (diff.routes.missingInDoc.length) {
    lines.push('  missing-in-doc（代码已注册但文档未记载）：')
    for (const r of diff.routes.missingInDoc) lines.push(`    - ${r}`)
  }
  if (diff.routes.staleInDoc.length) {
    lines.push('  stale-in-doc（文档提及但代码未注册）：')
    for (const r of diff.routes.staleInDoc) lines.push(`    - ${r}`)
  }
  lines.push('')
  lines.push(`[envSwitches] ok=${diff.envSwitches.ok}${diff.envSwitches.warning ? `  warning=${diff.envSwitches.warning}` : ''}`)
  if (diff.envSwitches.missingInDoc.length) {
    lines.push('  missing-in-doc（代码已使用但文档未记载）：')
    for (const e of diff.envSwitches.missingInDoc) lines.push(`    - ${e}`)
  }
  lines.push('')
  lines.push(`[versionAnchors] ok=${diff.versionAnchors.ok} expected=${diff.versionAnchors.expected}${diff.versionAnchors.warning ? `  warning=${diff.versionAnchors.warning}` : ''}`)
  for (const m of diff.versionAnchors.matched) lines.push(`  matched: ${m.doc} -> ${m.anchor}`)
  for (const m of diff.versionAnchors.missing) lines.push(`  missing: ${m.doc} (${m.reason}${m.expected ? `, expected=${m.expected}` : ''})`)
  return lines.join('\n')
}

function listLibFiles(root) {
  try {
    return fs
      .readdirSync(path.join(root, 'lib'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.posix.join('lib', f))
      .sort()
  } catch {
    return []
  }
}

function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const rootIdx = args.indexOf('--root')
  const root = rootIdx >= 0 && args[rootIdx + 1]
    ? path.resolve(args[rootIdx + 1])
    : path.dirname(path.dirname(fileURLToPath(import.meta.url)))

  const readFile = (p) => fs.readFileSync(p, 'utf8')
  const libFiles = listLibFiles(root)

  const engine = collectEngineFacts({ readFile, root, libFiles })
  const docs = collectDocFacts({ readFile, root })
  const diff = diffFacts(engine, docs)
  const drift = hasDrift(diff)

  if (asJson) {
    console.log(JSON.stringify({ ok: !drift, engine, diff }, null, 2))
  } else {
    console.log(formatReport(engine, diff))
    console.log('')
    console.log(drift ? '[sync-engine-docs] 结论：存在漂移' : '[sync-engine-docs] 结论：无漂移')
  }

  process.exit(drift ? 1 : 0)
}

const isMain = path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()
