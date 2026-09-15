// lib/selfcheck.mjs — ccfeat-20260915-selfcheck
//
// 重启后自检钩子的纯逻辑层：交付漂移比对 / 路由契约判定 / 外部命令结果映射 / 通知判定 /
// 幂等判定，全部为纯函数（不直接触碰磁盘/网络/子进程），磁盘与子进程 IO 均由调用方
// （lib/index.js）通过参数注入（listDir/readFile/hash），便于单测用内存 fake 覆盖，
// 与 lib/cc-stats.mjs 的「纯函数 + 轻量 IO 注入」风格一致。
//
// 纯 Node ESM，Node >= 18，零第三方依赖。

/** 对一个 manifest 条目在某一端做展开：目录 → 递归下的相对文件路径列表；文件/不存在 → []。 */
async function expandManifestEntry(root, entry, listDir) {
  try {
    const expanded = await listDir(root, entry)
    return Array.isArray(expanded) ? expanded : []
  } catch (err) {
    return []
  }
}

/**
 * 展开 package.json files 清单为去重后的候选相对路径集合：每个条目本身作为「字面量文件」
 * 候选，另叠加 listDir 在源码端/运行端两侧分别展开出的目录内文件（两侧都展开、取并集——
 * 否则「仅一端新增/删除了目录内某文件」这类漂移会被漏检）。若某条目其实是目录，条目本身
 * 在两端都读不到内容会被 computeDrift 自然跳过（视为「目录伪条目，无需比对」），无需提前
 * 区分文件/目录。
 */
export async function expandManifest(manifest, listDir) {
  const out = new Set()
  const entries = Array.isArray(manifest) ? manifest : []
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) continue
    out.add(entry)
    for (const root of ['source', 'runtime']) {
      for (const rel of await expandManifestEntry(root, entry, listDir)) {
        if (typeof rel === 'string' && rel.trim()) out.add(rel)
      }
    }
  }
  return [...out].sort()
}

const defaultHash = (buf) => (buf == null ? '' : String(buf))

/**
 * 是否属于「非源码产物」，应排除在交付漂移比对之外。
 *
 * 为什么必须有它（2026-09-15 该自检首次上线实测）：部署工具会在目标 lib/ 里留下
 * `.bak-vNNN-<时间戳>` 备份。它们只存在于运行端、不被任何代码引用，却会被漂移比对判为
 * `missing-source` → 每次重启都误报、假唤醒主 agent。而部署工具**每次部署都会再产生**这类文件，
 * 故若不排除，该误报是**永久性**的（自检就从「减少打扰」变成「固定打扰」）。
 *
 * 范围刻意收紧，只排除公认的备份/临时/编辑器残留，避免掩盖真实漂移（若有人往 lib/ 塞了真的
 * 新模块，仍必须报出来）。被排除的条目会计数并在结果里回传（ignored / ignoredFiles），
 * **不做静默丢弃**——「静默忽略」本身就是审计问题。
 *
 * @param {string} relPath - 相对路径（POSIX 或 Windows 分隔符均可）。
 * @returns {boolean} true = 排除。
 */
export function isIgnoredArtifact(relPath) {
  const p = String(relPath || '')
  if (!p) return false
  if (/\.(bak|orig)(-[A-Za-z0-9._-]+)?$/i.test(p)) return true   // *.bak / *.bak-v496-1789216494515 / *.orig
  if (/\.(tmp|temp|swp|swo)$/i.test(p)) return true              // 临时/编辑器残留
  if (/~$/.test(p)) return true                                  // 编辑器备份 foo.js~
  if (/(^|\/)\.DS_Store$/i.test(p)) return true
  if (/(^|\/)Thumbs\.db$/i.test(p)) return true
  return false
}

/**
 * 交付漂移比对：给定源码端/运行端根目录信息、files 清单、以及注入的 listDir/readFile/hash，
 * 逐文件比对内容摘要，返回差异清单。
 *
 * @param {object} opts
 * @param {string[]} opts.manifest - package.json files 清单（条目可以是文件或目录）。
 * @param {(root: 'source'|'runtime', entry: string) => Promise<string[]>} opts.listDir -
 *   展开某一端某清单条目下的相对文件路径（非目录/不存在 → 返回 []；内部会对 source/runtime
 *   两端各调用一次并取并集，以便发现「仅一端存在」的文件）。
 * @param {(root: 'source'|'runtime', relPath: string) => Promise<*|null>} opts.readFile -
 *   读取某一端某相对路径的内容；不存在/不可读 → 返回 null（不得抛出）。
 * @param {(content: *) => string} [opts.hash] - 内容 → 摘要字符串（默认恒等映射，生产环境
 *   由调用方注入 sha256）。
 * @returns {Promise<{checked: number, differing: Array<{path: string, kind: 'content-diff'|'missing-source'|'missing-runtime'}>, ignored: number, ignoredFiles: string[]}>}
 */
export async function computeDrift({ manifest, listDir, readFile, hash } = {}) {
  const hashFn = typeof hash === 'function' ? hash : defaultHash
  const allRel = await expandManifest(manifest, listDir)
  // 非源码产物（部署备份/临时文件）单独剥离并回传，既不参与比对也不静默消失
  const ignoredFiles = allRel.filter((rel) => isIgnoredArtifact(rel))
  const relFiles = allRel.filter((rel) => !isIgnoredArtifact(rel))
  const differing = []
  let checked = 0
  for (const rel of relFiles) {
    let srcContent = null
    let runContent = null
    try { srcContent = await readFile('source', rel) } catch (err) { srcContent = null }
    try { runContent = await readFile('runtime', rel) } catch (err) { runContent = null }
    const srcMissing = srcContent === null || srcContent === undefined
    const runMissing = runContent === null || runContent === undefined
    if (srcMissing && runMissing) continue // 目录伪条目或两端皆无——无需比对
    checked += 1
    if (srcMissing && !runMissing) { differing.push({ path: rel, kind: 'missing-source' }); continue }
    if (runMissing && !srcMissing) { differing.push({ path: rel, kind: 'missing-runtime' }); continue }
    if (hashFn(srcContent) !== hashFn(runContent)) differing.push({ path: rel, kind: 'content-diff' })
  }
  return { checked, differing, ignored: ignoredFiles.length, ignoredFiles }
}

/**
 * 路由契约判定：自身已注册路由是否齐全（防注册代码被误删/漂移）+ /health-check 审计字段
 * 是否齐备（防字段被误删）。均为纯文本/集合比对，不做 IO。
 *
 * @param {object} opts
 * @param {string[]} [opts.registeredRoutes] - 已注册的路由 path 列表（调用方从自身源码正则提取）。
 * @param {string[]} [opts.requiredRoutes] - 期望必须存在的路由 path 列表。
 * @param {string} [opts.handlerSource] - /health-check handler 的源码文本（调用方截取）。
 * @param {string[]} [opts.requiredHealthFields] - 期望必须出现的字段名。
 * @returns {{ok: boolean, failed: string[]}}
 */
export function checkRouteContract({ registeredRoutes = [], requiredRoutes = [], handlerSource = '', requiredHealthFields = [] } = {}) {
  const failed = []
  const regSet = new Set(Array.isArray(registeredRoutes) ? registeredRoutes : [])
  for (const p of (Array.isArray(requiredRoutes) ? requiredRoutes : [])) {
    if (!regSet.has(p)) failed.push(`route-missing:${p}`)
  }
  const src = typeof handlerSource === 'string' ? handlerSource : ''
  for (const f of (Array.isArray(requiredHealthFields) ? requiredHealthFields : [])) {
    if (!src.includes(`${f}:`) && !src.includes(`${f},`)) failed.push(`health-field-missing:${f}`)
  }
  return { ok: failed.length === 0, failed }
}

/**
 * 是否需要唤醒主 agent：drift 非空或 contract 未通过即需要；两者皆正常则不需要
 * （无问题绝不打扰）。
 * @param {object} opts
 * @param {{differing: Array}} [opts.drift]
 * @param {{ok: boolean}} [opts.contract]
 * @returns {boolean}
 */
export function needsNotify({ drift, contract } = {}) {
  const driftBad = !!(drift && Array.isArray(drift.differing) && drift.differing.length > 0)
  const contractBad = !!(contract && contract.ok === false)
  return driftBad || contractBad
}

/**
 * 外部自检命令结果映射：exitCode/超时/信号 → { ok, reason, tail }。
 * 超时与「非 0 退出」必须可区分（reason 分别含 'timeout' 与 'exit='）。
 * @param {object} opts
 * @param {number|null} [opts.exitCode]
 * @param {string|null} [opts.signal]
 * @param {boolean} [opts.timedOut]
 * @param {string} [opts.tail] - stdout/stderr 尾部截断文本。
 * @param {boolean} [opts.spawnError] - spawn 本身失败（命令不存在等）。
 * @returns {{ok: boolean, reason: string|null, tail: string}}
 */
export function mapExternalResult({ exitCode = null, signal = null, timedOut = false, tail = '', spawnError = false } = {}) {
  const t = typeof tail === 'string' ? tail : ''
  if (timedOut) return { ok: false, reason: `timeout（超过时限，signal=${signal || 'SIGKILL'}）`, tail: t }
  if (spawnError) return { ok: false, reason: `spawn 失败：${t || 'unknown'}`, tail: t }
  if (exitCode === 0) return { ok: true, reason: null, tail: t }
  if (exitCode === null && signal) return { ok: false, reason: `terminated by signal ${signal}`, tail: t }
  if (exitCode === null) return { ok: false, reason: 'spawn 未返回退出码', tail: t }
  return { ok: false, reason: `exit=${exitCode}`, tail: t }
}

// ---------------------------------------------------------------------------
// 契约自检的必需清单与源码切片（2026-09-15 主 agent 修复）
//
// 为什么把这两样从 lib/index.js 移到这里：切片逻辑原本写在 lib/index.js 内部，用
// indexOf 从文件开头找锚点 'const healthCheckHandler = async'——而该锚点字符串**恰好出现在
// 那个函数自己的源码里**（作为搜索字面量），且位置在真实定义之前，于是 indexOf 命中的是
// 「搜索字面量自己」：切片退化成 96 个字符，14 个必需字段全部判为「缺失」→ 契约检查恒定失败
// → 每次宿主重启都假唤醒一次主 agent（实测确诊）。这是「字面量出现在自身源码中」类陷阱。
// 修法有二：① 取 lastIndexOf（真实定义在文件后部）；② 把逻辑做成可对**真实源码**跑的纯函数，
// 从而能用一条端到端契约测试把这类陷阱钉死（见 test/selfcheck.test.js）。
// ---------------------------------------------------------------------------

/** 契约自检必须存在的关键路由（非全量；与 lib/index.js 的注册处保持同步维护）。 */
export const SELFCHECK_REQUIRED_ROUTES = [
  '/dsh-web-relay/health-check',
  '/dsh-web-relay/ask',
  '/dsh-web-relay/steps',
  '/dsh-web-relay/steps/update',
  '/dsh-web-relay/steps/auto-review',
  '/dsh-web-relay/trace'
]

/** 契约自检必须存在的 /health-check 审计字段（非全量）。 */
export const SELFCHECK_REQUIRED_HEALTH_FIELDS = [
  'ok', 'version', 'bootId', 'resumed', 'heartbeat', 'preparing', 'bridge',
  'restartStats', 'channelStats', 'dialogFallbackRate', 'ccStats', 'ccChainStats',
  'ccWatchdogWarning', 'healthCache', 'selfCheck'
]

/**
 * 从源码文本中切出 /health-check 处理函数的源码片段（供契约自检做字段齐备判定）。
 *
 * ⚠ 陷阱：锚点字符串会出现在「调用方自身源码」中。若用 indexOf 从头找，可能命中搜索字面量
 * 而不是真实定义（2026-09-15 实测：切片仅 96 字符 → 字段全缺失 → 每次 boot 假唤醒）。
 * 故用 lastIndexOf 取最后一处（真实定义在文件后部）。src 传入真实文件内容时该策略稳定。
 *
 * @param {string} src - 目标源码文本（通常为 lib/index.js 的内容）。
 * @param {object} [opts]
 * @param {string} [opts.defAnchor] - 处理函数定义锚点。
 * @param {string} [opts.endAnchor] - 下一个处理函数锚点（用于收窄切片；找不到则取 maxLen）。
 * @param {number} [opts.maxLen] - 收窄失败时的最大切片长度。
 * @returns {string} 切片；找不到定义锚点返回 ''（调用方据此判失败，不得静默当通过）。
 */
export function sliceHandlerSource(src, { defAnchor = 'const healthCheckHandler = async', endAnchor = 'const askHandler = async', maxLen = 8000 } = {}) {
  const s = typeof src === 'string' ? src : ''
  if (!s) return ''
  const start = s.lastIndexOf(defAnchor)
  if (start === -1) return ''
  const end = s.indexOf(endAnchor, start)
  return end === -1 ? s.slice(start, start + maxLen) : s.slice(start, end)
}

/**
 * 幂等判定：同一 bootId 是否已经跑过自检（跑过则跳过，防 boot 重入/重复唤醒）。
 * @param {object} opts
 * @param {string|null} [opts.lastBootId] - 上次落盘记录的 bootId（无记录为 null）。
 * @param {string} opts.currentBootId - 本次宿主的 bootId。
 * @returns {boolean} true = 应跳过（已跑过）；false = 应执行。
 */
export function shouldSkipBoot({ lastBootId = null, currentBootId } = {}) {
  if (!lastBootId || !currentBootId) return false
  return lastBootId === currentBootId
}
