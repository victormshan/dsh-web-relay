// dsh-web-relay · AutoIteration 声明解析（v4.4 U3 重构：可测 + 兜底增强）
// 输入：prompt+answer 文本 → { iterations, finalAcceptance, autoDecision }
// 解析路径：① 含 iterations 的 JSON 对象（JSON.parse 容错，字段顺序无关）② 行内/叙述式（容忍引号）

import { readdirSync as nodeReaddirSync, readFileSync as nodeReadFileSync } from 'node:fs'
import path from 'node:path'

export function extractAutoIterDecl(text) {
  const src = String(text || '')
  const decl = { iterations: 1, finalAcceptance: null, autoDecision: false }
  const clamp = (n) => (Number.isInteger(n) && n >= 1 && n <= 10 ? n : null)

  // ① JSON 对象形态（顺序无关）：抓取含 "iterations" 的最内层 {…} 后 JSON.parse
  const obj = src.match(/\{[^{}]*"iterations"\s*:\s*\d+[^{}]*\}/)
  if (obj) {
    try {
      const parsed = JSON.parse(obj[0])
      const n = clamp(parsed.iterations)
      if (n) decl.iterations = n
      if (typeof parsed.finalAcceptance === 'string' && parsed.finalAcceptance) decl.finalAcceptance = parsed.finalAcceptance
      if (typeof parsed.autoDecision === 'boolean') decl.autoDecision = parsed.autoDecision
      return decl
    } catch (err) { /* fallthrough to narrative */ }
  }

  // ② 叙述式/行内（容忍字段名与冒号间引号，如 iterations": 3、autoDecision": true）
  const mIt = src.match(new RegExp('iterations\\s*"?\\s*[:：]\\s*"?\\s*(\\d+)', 'i'))
  const ni = mIt && clamp(parseInt(mIt[1], 10))
  if (!ni) {
    const mC = src.match(/(?:自动迭代|自动演进|迭代)\s*[:：]?\s*(\d{1,2})\s*(?:个|次|轮)?版本/)
    if (mC) { const n3 = clamp(parseInt(mC[1], 10)); if (n3) decl.iterations = n3 }
  } else decl.iterations = ni
  const ma = src.match(new RegExp('autoDecision\\s*"?\\s*[:：]\\s*"?\\s*(true|false)', 'i'))
  if (ma) decl.autoDecision = ma[1].toLowerCase() === 'true'
  const mf = src.match(new RegExp('finalAcceptance\\s*"?\\s*[:：]\\s*"?\\s*["\'“”‘’]([^"\'“”‘’]+)["\'“”‘’]', 'i'))
  if (mf) decl.finalAcceptance = mf[1]
  return decl
}

// ---------------------------------------------------------------------------
// v1-2: AutoIteration 声明契约完整性（半状态可见化）
// 背景：expr-2026-09-13_17-36-07 实测——外部 AI 只在正文写叙述式声明（无严格 JSON 块），
// extractAutoIterDecl 的宽松兜底只抓到 iterations=3，autoDecision/finalAcceptance 落成 false/null，
// 版间门因此认为共 3 版却每版仍需人工审核，与「人工缺席下的自动演化」矛盾，且此前无任何告警/判定。
// assessAutoIterDecl 是一个可注入的纯函数：只做判定，不抛错、不做 IO。
// ---------------------------------------------------------------------------
export function assessAutoIterDecl(decl) {
  if (!decl || typeof decl !== 'object' || Array.isArray(decl)) {
    return { complete: false, halfState: false, reasons: ['invalid-decl'], hint: null }
  }
  const { iterations, autoDecision } = decl
  if (typeof iterations !== 'number' || !Number.isInteger(iterations) || typeof autoDecision !== 'boolean') {
    return { complete: false, halfState: false, reasons: ['invalid-decl'], hint: null }
  }
  if (iterations > 1 && autoDecision !== true) {
    return {
      complete: false,
      halfState: true,
      reasons: [`声明了 ${iterations} 版（iterations>1）但未开启 autoDecision：版间门仍会要求每版人工审核，与「人工缺席下的自动演化」预期不符`],
      hint: renderStrictDeclExample()
    }
  }
  return { complete: true, halfState: false, reasons: [], hint: null }
}

// ---------------------------------------------------------------------------
// ccfix-20260915-autoiteraudit: autoIterDeclAudit 落盘字段的单一构造点
// 背景：/steps/declare 与 /ask 此前各自内联赋值 autoIterDeclAudit（declare 甚至先写盘后计算，
// 判定结果只进了响应体、从未落盘），两处字段结构还不一致。统一为一个纯函数：
// 先算出 { at, source, decl, verdict } 再交给调用方落盘，调用方不得再自行拼装该字段。
// ---------------------------------------------------------------------------
export function buildAutoIterDeclAudit(decl, source, at = new Date().toISOString()) {
  const d = (decl && typeof decl === 'object' && !Array.isArray(decl)) ? decl : {}
  const snapshot = { iterations: d.iterations, autoDecision: d.autoDecision, finalAcceptance: d.finalAcceptance }
  return { at, source, decl: snapshot, verdict: assessAutoIterDecl(snapshot) }
}

// 严格声明块样例（供 halfState 提示、/ask payload 注入复用，单一事实来源）
export function renderStrictDeclExample() {
  return [
    '【AutoIteration 声明格式（严格）】',
    '只有严格 JSON 块会被解析：{"iterations": N, "finalAcceptance": "<验收标准>", "autoDecision": true}',
    '正文叙述式声明（如"自动迭代3个版本"、"配置：iterations: 3"）不会被识别为完整声明——iterations 可能被兜底抓到，',
    '但 autoDecision 会落为 false，版间门仍会要求每版人工审核，不会进入「人工缺席下的自动演化」。',
    '示例（可直接复制，替换 N 与验收标准后原样输出为一个独立 JSON 对象）：',
    '{"iterations": 3, "finalAcceptance": "<验收标准>", "autoDecision": true}'
  ].join('\n')
}

// ---------------------------------------------------------------------------
// v1-2: /ask 注入机器生成能力清单（根因治理 lesson L-2026-0914-060：手写清单会随代码漂移）
// 清单由两部分机器生成：① docs/capabilities/registry.yaml 条目 ② lib/*.js 导出名扫描。
// fsImpl 可注入（测试用 fake fs，不读写真实磁盘）；registry 缺失/格式异常时优雅退化，不抛错。
// ---------------------------------------------------------------------------
const DEFAULT_FS_IMPL = {
  readdirSync: (dir) => nodeReaddirSync(dir),
  readFileSync: (file) => nodeReadFileSync(file, 'utf8')
}

function parseRegistryEntries(yamlText) {
  const entries = []
  const lines = String(yamlText || '').split(/\r?\n/)
  let cur = null
  for (const line of lines) {
    const mId = line.match(/^-\s*id:\s*(.+?)\s*$/)
    if (mId) {
      if (cur) entries.push(cur)
      cur = { id: mId[1], name: '', status: '' }
      continue
    }
    if (!cur) continue
    const mName = line.match(/^\s{2}name:\s*(.+?)\s*$/)
    if (mName) { cur.name = mName[1]; continue }
    const mStatus = line.match(/^\s{2}status:\s*(.+?)\s*$/)
    if (mStatus) { cur.status = mStatus[1]; continue }
  }
  if (cur) entries.push(cur)
  return entries.filter((e) => e.id)
}

function listLibExportCounts(fsImpl, libDir) {
  let files = []
  try { files = fsImpl.readdirSync(libDir) } catch (err) { return [] }
  const out = []
  for (const f of [...files].sort()) {
    if (!/\.(m?js)$/i.test(f)) continue
    let text = ''
    try { text = fsImpl.readFileSync(path.join(libDir, f)) } catch (err) { continue }
    const names = new Set()
    const re = /export\s+(?:async\s+function|function|const|class)\s+([A-Za-z0-9_]+)/g
    let m
    while ((m = re.exec(text))) names.add(m[1])
    out.push({ file: f, count: names.size })
  }
  return out
}

export function generateCapabilitiesList({ repoRoot, fsImpl = DEFAULT_FS_IMPL, maxLen = 2000 } = {}) {
  const root = repoRoot ? String(repoRoot) : ''
  let registryEntries = []
  try {
    const yamlText = fsImpl.readFileSync(path.join(root, 'docs', 'capabilities', 'registry.yaml'))
    registryEntries = parseRegistryEntries(yamlText).filter((e) => e.status !== 'deprecated')
  } catch (err) { registryEntries = [] }

  let libFiles = []
  try { libFiles = listLibExportCounts(fsImpl, path.join(root, 'lib')) } catch (err) { libFiles = [] }

  const parts = []
  if (registryEntries.length) {
    parts.push('【能力注册表 registry.yaml（机器生成，勿手写）】')
    for (const e of registryEntries) parts.push(`- ${e.id}：${e.name}`)
  }
  if (libFiles.length) {
    parts.push('【lib 模块导出（机器扫描）】')
    parts.push(libFiles.map((f) => `${f.file}(${f.count})`).join(', '))
  }
  let text = parts.join('\n')
  if (text.length > maxLen) text = text.slice(0, Math.max(0, maxLen - 1)) + '…'
  return text
}

// ---------------------------------------------------------------------------
// v1-2: 受控声明补全（/steps/declare 等价入口的纯计算核心）
// 只做校验 + 差值计算，不做任何 IO/网络；调用方（lib/index.js 的 HTTP handler）负责落盘与 appendTrace。
// 关键约束：未携带 autoDecision 时不得把已有的 true 回退为 false（防误降级）。
// ---------------------------------------------------------------------------
export function computeAutoIterDeclareUpdate(currentDecl, patch) {
  const cur = (currentDecl && typeof currentDecl === 'object') ? currentDecl : {}
  const before = {
    iterations: Number.isInteger(cur.iterations) ? cur.iterations : 1,
    finalAcceptance: typeof cur.finalAcceptance === 'string' ? cur.finalAcceptance : null,
    autoDecision: cur.autoDecision === true
  }
  const p = (patch && typeof patch === 'object') ? patch : {}
  const hasIterations = Object.prototype.hasOwnProperty.call(p, 'iterations')
  const hasFinalAcceptance = Object.prototype.hasOwnProperty.call(p, 'finalAcceptance')
  const hasAutoDecision = Object.prototype.hasOwnProperty.call(p, 'autoDecision')

  if (hasIterations && !(Number.isInteger(p.iterations) && p.iterations >= 1 && p.iterations <= 10)) {
    return { ok: false, error: 'iterations 必须为 1-10 的整数' }
  }
  if (hasFinalAcceptance && !(typeof p.finalAcceptance === 'string' && p.finalAcceptance.trim())) {
    return { ok: false, error: 'finalAcceptance 必须为非空字符串' }
  }
  if (hasAutoDecision && typeof p.autoDecision !== 'boolean') {
    return { ok: false, error: 'autoDecision 必须为 boolean' }
  }

  const after = {
    iterations: hasIterations ? p.iterations : before.iterations,
    // 未携带 autoDecision 时保留既有值（不回退已有的 true）
    autoDecision: hasAutoDecision ? p.autoDecision : before.autoDecision,
    finalAcceptance: hasFinalAcceptance ? p.finalAcceptance : before.finalAcceptance
  }
  const reason = typeof p.reason === 'string' ? p.reason.trim() : ''
  const traceText = `AutoIteration 声明补全：iterations ${before.iterations}→${after.iterations}，` +
    `autoDecision ${before.autoDecision}→${after.autoDecision}，` +
    `finalAcceptance ${JSON.stringify(before.finalAcceptance)}→${JSON.stringify(after.finalAcceptance)}` +
    (reason ? `；理由：${reason}` : '')
  return { ok: true, before, after, traceText }
}

// 供 node 直接运行本文件时打印样例结果（调试用）
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const t = process.argv.slice(2).join(' ') || '声明：{"iterations": 3, "autoDecision": true, "finalAcceptance": "test"}'
  console.log(JSON.stringify(extractAutoIterDecl(t)))
}
