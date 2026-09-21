// 派发前规格校验器：import 规格模块 → 构建 task.json → v2 门控校验 + 编码自检，**不入队**
// 用途：在 cc 配额窗口开启前就发现规格问题（避免浪费 4-8 分钟/任务的窗口）
// 用法：
//   node check-spec.mjs <specModule.mjs>      # 校验某规格
//   node check-spec.mjs --selftest-anchors    # 自测锚点校验逻辑（纯函数 + 内存 IO）
//
// 2026-09-15 增补（B：规格锚点校验）。动因（均来自本会话实测）：
//  ① **行号漂移**：规格里写「约 L1880」这类引用，源文件一改就失效，而 cc 会照着找 → 改错位置。
//     这是主 agent 自己最反复的失误（本会话多份规格都靠回源重查行号才发现漂了）。
//  ② **锚点多重命中**（更致命）：规格让 cc 用某个字符串去定位，而该字符串在文件里出现多次时，
//     indexOf 可能取到错的那个。实测事故：自检钩子的 health handler 切片命中了「搜索字面量自身」
//     → 切片退化成 96 字符 → 14 个必需字段全部判为缺失 → 契约检查恒失败 → **每次 boot 假唤醒**。
//     而那一版交付的 18 个单测**全是绿的**（只喂内存 fake，从未走真实提取路径）。
// 因此：显式声明的锚点必须为真（FAIL 级）；多重命中与行号疑似漂移给 WARN（可能有正当理由，但不该静默）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = 'D:\\dsh-web-relay';

// ---------- 纯逻辑（IO 注入，便于自测） ----------

/** 把仓库相对路径转成绝对路径。 */
export function absOf(rel) {
  return path.join(REPO, String(rel || '').replace(/\//g, '\\'));
}

/** 默认读文本实现（找不到/读失败返回 null，不抛）。 */
export function defaultReadText(rel) {
  try { return fs.readFileSync(absOf(rel), 'utf8'); } catch { return null; }
}

/**
 * 统计 pattern 在文本中的出现次数（默认按纯文本字面量计，regex=true 时按正则）。
 * @returns {number} 出现次数；文本为 null（文件不存在）返回 -1。
 */
export function countOccurrences(text, pattern, { regex = false } = {}) {
  if (text === null || text === undefined) return -1
  const p = String(pattern || '')
  if (!p) return 0
  if (regex) {
    try {
      const re = new RegExp(p, 'g')
      return (text.match(re) || []).length
    } catch { return -2 } // -2 = 正则非法
  }
  let n = 0
  let idx = text.indexOf(p)
  while (idx !== -1) { n += 1; idx = text.indexOf(p, idx + p.length) }
  return n
}

/**
 * 校验规格显式声明的 anchors。
 * 支持两种形态：
 *   { file, pattern, regex?, note? }          —— pattern 必须在该文件出现 ≥1 次
 *   { file, line, expect, note? }             —— 该行必须包含 expect（抓行号漂移）
 * 规则：
 *   - pattern 缺失 → FAIL；文件不存在 → FAIL；正则非法 → FAIL
 *   - pattern 命中 >1 次 → **WARN**（可能有正当理由，但需知晓；这是「锚点自匹配」事故的形态）
 *   - 行号形态：行内容不含 expect → FAIL（行号漂移）；行号超出文件行数 → FAIL
 * @returns {{failures: string[], warnings: string[], checked: number}}
 */
export function checkAnchors(anchors, readText = defaultReadText) {
  const failures = []
  const warnings = []
  let checked = 0
  const list = Array.isArray(anchors) ? anchors : []
  if (!Array.isArray(anchors) || anchors.length === 0) return { failures, warnings, checked, declared: 0 }
  for (const [i, a] of list.entries()) {
    const tag = `anchors[${i}]${a && a.note ? `(${a.note})` : ''}`
    if (!a || typeof a !== 'object' || !a.file) { failures.push(`${tag}: 缺少 file`); continue }
    const text = readText(a.file)
    if (text === null || text === undefined) { failures.push(`${tag}: 文件不存在或不可读 → ${a.file}`); continue }
    if (typeof a.line === 'number') {
      const lines = String(text).split(/\r?\n/)
      if (a.line < 1 || a.line > lines.length) { failures.push(`${tag}: 行号 ${a.line} 超出 ${a.file} 行数(${lines.length})`); continue }
      const expect = String(a.expect ?? '')
      if (!expect) { failures.push(`${tag}: 声明了 line 但缺少 expect`); continue }
      checked += 1
      if (!lines[a.line - 1].includes(expect)) {
        failures.push(`${tag}: 行号漂移 → ${a.file}:${a.line} 实际为 ${JSON.stringify(lines[a.line - 1].trim().slice(0, 70))}，不含 ${JSON.stringify(expect)}`)
      }
      continue
    }
    if (typeof a.pattern !== 'string' || !a.pattern) { failures.push(`${tag}: 缺少 pattern（或提供 line+expect）`); continue }
    const n = countOccurrences(text, a.pattern, { regex: a.regex === true })
    checked += 1
    if (n === -2) { failures.push(`${tag}: 正则非法 → ${a.pattern}`); continue }
    if (n === 0) { failures.push(`${tag}: 锚点在文件中不存在 → ${a.file} 中找不到 ${JSON.stringify(a.pattern)}`); continue }
    if (n > 1) warnings.push(`${tag}: 锚点在 ${a.file} 中命中 ${n} 次（非唯一）——若规格让 cc 用它定位唯一位置，indexOf 可能取到错的那个（实测事故形态：命中搜索字面量自身）`)
  }
  return { failures, warnings, checked, declared: list.length }
}

/**
 * 从 prompt 中自动提取「文件 + 约 Lnnn」形式的行号引用，核对是否疑似漂移。
 * 只产出 WARN（启发式，可能有正当理由），但足以发现「行号已失效」这类低级却致命的引用错误。
 *
 * 2026-09-15 两处修正（首版实测暴露）：
 *  ① 文件识别从「只认 /mnt/d/dsh-web-relay/ 全路径」扩展到**也认裸相对路径**（如 lib/index.js）——
 *     主 agent 的规格绝大多数用裸路径，首版因此对真实规格一条都没检出（等于没检查）。
 *  ② 探针 token 改为按「在文件内出现次数升序」取最少者——首版取「同行任一 token」，
 *     使得 function/const 这类高频词几乎在任何 ±slack 窗口内都能命中，检查恒通过（假阴性）。
 *     anchor 类 token（如 heartbeatTick）出现次数少，才有区分力。
 * @returns {{warnings: string[], checked: number}}
 */
export function checkPromptCitations(prompt, readText = defaultReadText, { slack = 15, maxProbeOcc = 20 } = {}) {
  const warnings = []
  let checked = 0
  const text = String(prompt || '')
  const FULL_RE = /\/mnt\/d\/dsh-web-relay\/([A-Za-z0-9_./-]+\.(?:js|mjs|md|json|yml|yaml))/g
  const BARE_RE = /\b((?:lib|test|scripts|docs|bin|shim|skills)\/[A-Za-z0-9_./-]+\.(?:js|mjs|md|json|yml|yaml))\b/g
  for (const rawLine of text.split(/\r?\n/)) {
    const cands = [
      ...[...rawLine.matchAll(FULL_RE)].map((m) => m[1]),
      ...[...rawLine.matchAll(BARE_RE)].map((m) => m[1]),
    ]
    if (cands.length === 0) continue
    const lineNums = [...rawLine.matchAll(/(?:约\s*)?L(\d{1,6})/g)].map((m) => Number(m[1]))
    if (lineNums.length === 0) continue
    for (const rel of [...new Set(cands)]) {
      const src = readText(rel)
      if (src === null || src === undefined) continue // 文件缺失已由 refs 检查报错；裸路径不存在则静默跳过
      const lines = String(src).split(/\r?\n/)
      // 候选探针：同行出现且文件内确实存在的 token，按出现次数升序 → **只取最专有的一个**。
      // 教训（三次迭代，均被自测/反向验证抓出）：
      //  ① 首版只认全路径 → 对裸相对路径规格零检出；
      //  ② 取前 2 个时第二个常是 function/const 这类在任意窗口内都存在的词，some() 一命中就永不告警；
      //  ③ **平局时按行内先后取**会把**文件路径自身**的片段选成探针：实测 `lib/cc-channel.js 约 L650
      //     export function shouldSkipForKnownQuotaExhaustion` 中 `channel`(路径片段) 与真符号出现次数
      //     都是 1，稳定排序保留了先出现的 `channel` → 窗口内找不到 → **对正确行号误报**。
      //     故：排除来自路径的 token，且平局时取更长者（更长≈更专有）。
      const pathTokens = new Set()
      for (const rel of cands) {
        for (const seg of rel.split(/[^A-Za-z0-9_]+/)) if (seg.length >= 5) pathTokens.add(seg)
      }
      const ranked = [...new Set(rawLine.match(/[A-Za-z_][A-Za-z0-9_]{5,}/g) || [])]
        .filter((t) => !pathTokens.has(t))
        .filter((t) => src.includes(t))
        .map((t) => ({ t, n: countOccurrences(src, t) }))
        .filter((x) => x.n > 0)
        .sort((a, b) => (a.n - b.n) || (b.t.length - a.t.length))
      const best = ranked[0]
      if (!best || best.n > maxProbeOcc) continue
      const probes = [best.t]
      if (probes.length === 0) continue
      for (const n of lineNums) {
        if (n < 1 || n > lines.length) { warnings.push(`行号引用 ${rel} 约 L${n} 超出该文件行数(${lines.length})`); continue }
        checked += 1
        const lo = Math.max(1, n - slack), hi = Math.min(lines.length, n + slack)
        const windowText = lines.slice(lo - 1, hi).join('\n')
        if (!probes.some((t) => windowText.includes(t))) {
          warnings.push(`行号可能已变：${rel} 约 L${n}（±${slack} 行内找不到同行提及的锚点 ${probes.map((t) => JSON.stringify(t)).join('/')}）。`
            + '注意：若该文件在规格写就之后被改动过（例如另一任务正在改它），此处「漂移」属预期现象，'
            + 'cc 应以**符号名**定位而非行号；仅当规格是新写的、且文件未动时，才说明行号确实写错了。')
        }
      }
    }
  }
  return { warnings, checked }
}

// ---------- 自测（--selftest-anchors） ----------
if (process.argv.includes('--selftest-anchors')) {
  const FAKE = {
    'lib/a.js': ['// header', 'const DEFAULT = 1', 'function targeted(x) { return x }', 'const again = DEFAULT'].join('\n'),
    // 长文件：符号只在最后一行，用于验证「行号远离符号 → 告警」（比对基准是**文件行数**，不是提示文本长度）
    'lib/long.js': [...Array(39).fill('// filler').map((s, i) => `${s} ${i + 1}`), 'function faraway(x) { return x }'].join('\n'),
    // 掩蔽场景：function 高频出现（会在任何 ±slack 窗口内命中），faraway 只出现 1 次且在第 40 行。
    // 用于验证「高频词不得掩盖漂移」——首版取前 2 个探针时，function 会让检查恒通过。
    'lib/masked.js': [...Array(39).fill('function filler(x) { return x }'), 'function faraway(x) { return x }'].join('\n'),
  }
  const read = (rel) => (rel in FAKE ? FAKE[rel] : null)
  let pass = 0; const fails = []
  const T = (name, cond) => { if (cond) pass++; else fails.push(name) }

  // countOccurrences
  T('countOccurrences 文本多次命中', countOccurrences(FAKE['lib/a.js'], 'DEFAULT') === 2)
  T('countOccurrences 未命中=0', countOccurrences(FAKE['lib/a.js'], 'NOPE') === 0)
  T('countOccurrences 文件不存在=-1', countOccurrences(null, 'x') === -1)
  T('countOccurrences 正则非法=-2', countOccurrences(FAKE['lib/a.js'], '(', { regex: true }) === -2)

  // checkAnchors：正例
  let r = checkAnchors([{ file: 'lib/a.js', pattern: 'function targeted' }], read)
  T('anchors 正例无失败', r.failures.length === 0 && r.checked === 1)
  // pattern 不存在 → FAIL
  r = checkAnchors([{ file: 'lib/a.js', pattern: 'function missing' }], read)
  T('anchors pattern 不存在 → FAIL', r.failures.length === 1)
  // 文件不存在 → FAIL
  r = checkAnchors([{ file: 'lib/nope.js', pattern: 'x' }], read)
  T('anchors 文件不存在 → FAIL', r.failures.length === 1)
  // 多重命中 → WARN 但不算失败
  r = checkAnchors([{ file: 'lib/a.js', pattern: 'DEFAULT' }], read)
  T('anchors 多重命中 → WARN 且不 FAIL', r.warnings.length === 1 && r.failures.length === 0)
  // 行号正确 → 通过
  r = checkAnchors([{ file: 'lib/a.js', line: 3, expect: 'function targeted' }], read)
  T('anchors 行号正确 → 通过', r.failures.length === 0)
  // 行号漂移 → FAIL（这正是要抓的：第 2 行不是 targeted）
  r = checkAnchors([{ file: 'lib/a.js', line: 2, expect: 'function targeted' }], read)
  T('anchors 行号漂移 → FAIL', r.failures.length === 1)
  // 行号越界 → FAIL
  r = checkAnchors([{ file: 'lib/a.js', line: 999, expect: 'x' }], read)
  T('anchors 行号越界 → FAIL', r.failures.length === 1)
  // 空/缺省 → 不报错、declared=0
  r = checkAnchors([], read)
  T('anchors 空数组 → 无失败且 declared=0', r.failures.length === 0 && r.declared === 0)

  // checkPromptCitations：同行含文件与正确行号 → 无告警
  let c = checkPromptCitations('见 /mnt/d/dsh-web-relay/lib/a.js 约 L3 的 targeted 实现', read)
  T('citations 行号正确 → 无告警', c.warnings.length === 0 && c.checked === 1)
  // 行号远离符号（长文件里符号在第 40 行，却引用 L2）→ 告警
  c = checkPromptCitations('见 /mnt/d/dsh-web-relay/lib/long.js 约 L2 的 faraway 实现', read)
  T('citations 行号远离符号 → 告警', c.warnings.length >= 1)
  // 同一长文件、行号正确 → 无告警（防止上一条靠「一律告警」蒙混过关）
  c = checkPromptCitations('见 /mnt/d/dsh-web-relay/lib/long.js 约 L40 的 faraway 实现', read)
  T('citations 长文件行号正确 → 无告警', c.warnings.length === 0 && c.checked === 1)
  // 裸相对路径形态（主 agent 规格的主流写法）必须也能检出 —— 首版只认全路径，实测对真实规格零检出
  c = checkPromptCitations('见 lib/long.js 约 L2 的 faraway 实现', read)
  T('citations 裸相对路径行号远离 → 告警', c.warnings.length >= 1 && c.checked === 1)
  c = checkPromptCitations('见 lib/long.js 约 L40 的 faraway 实现', read)
  T('citations 裸相对路径行号正确 → 无告警', c.warnings.length === 0 && c.checked === 1)
  // 高频词不应让检查恒通过：仅当「最专有」的 token 也在窗口内才算命中
  c = checkPromptCitations('见 lib/long.js 约 L2 的 faraway function 实现', read)
  T('citations 高频词不掩盖漂移（仍告警）', c.warnings.length >= 1)
  // 真掩蔽场景：function 在该文件出现 40 次（必然落在任何 ±slack 窗口内），faraway 仅 1 次且在第 40 行。
  // 引用 L2 时必须告警——即「只认最专有探针」这条修正的回归守卫。
  c = checkPromptCitations('见 lib/masked.js 约 L2 的 faraway function 实现', read)
  T('citations 真掩蔽场景仍告警（只认最专有探针）', c.warnings.length >= 1 && c.checked === 1)
  c = checkPromptCitations('见 lib/masked.js 约 L40 的 faraway function 实现', read)
  T('citations 真掩蔽场景行号正确 → 无告警', c.warnings.length === 0 && c.checked === 1)
  // 专有度门槛：同行只有高频词时不做假判定（checked 不应增加）
  c = checkPromptCitations('见 lib/masked.js 约 L2 的 function 实现', read)
  T('citations 无专有锚点时跳过（不假装检查过）', c.checked === 0 && c.warnings.length === 0)
  // 路径片段不得被选为探针（实测：`lib/svc-channel.js` 的 `channel` 与真符号同为出现 1 次，
  // 平局按行内先后会选中路径片段 → 对**正确行号**误报）。构造：路径片段 channel 与真符号 svcRealSymbol 均 1 次
  {
    const FAKE2 = { 'lib/svc-channel.js': [...Array(30).fill('// filler'), 'export function svcRealSymbol() { return 1 }'].join('\n') }
    const read2 = (r) => (r in FAKE2 ? FAKE2[r] : null)
    const cc = checkPromptCitations('见 lib/svc-channel.js 约 L31 的 svcRealSymbol 实现', read2)
    T('citations 路径片段不作探针（正确行号不误报）', cc.warnings.length === 0 && cc.checked === 1,
      JSON.stringify(cc.warnings))
    const cc2 = checkPromptCitations('见 lib/svc-channel.js 约 L2 的 svcRealSymbol 实现', read2)
    T('citations 路径片段不作探针（错误行号仍告警）', cc2.warnings.length >= 1)
  }
  // 越界行号 → 告警
  c = checkPromptCitations('见 /mnt/d/dsh-web-relay/lib/a.js 约 L9999 的 targeted', read)
  T('citations 行号越界 → 告警', c.warnings.length >= 1)
  // 无行号引用 → 不检查
  c = checkPromptCitations('见 /mnt/d/dsh-web-relay/lib/a.js', read)
  T('citations 无行号 → checked=0', c.checked === 0 && c.warnings.length === 0)

  console.log(`[selftest-anchors] ${pass}/${pass + fails.length} 通过`)
  for (const f of fails) console.log('  FAIL: ' + f)
  console.log(fails.length ? '[selftest-anchors] RESULT: FAIL' : '[selftest-anchors] RESULT: PASS')
  process.exit(fails.length ? 1 : 0)
}

// ---------- 主流程（校验指定规格） ----------
const specPath = process.argv[2];
if (!specPath) { console.error('usage: node check-spec.mjs <specModule.mjs> | --selftest-anchors'); process.exit(2); }

const mod = await import(pathToFileURL(specPath).href);
const spec = mod.task ?? mod.default;
if (!spec || typeof spec !== 'object') { console.error('spec 模块必须导出 task（或 default）对象'); process.exit(2); }

const VALIDATOR = 'D:\\dsh-web-relay\\scripts\\task-schema-cli.mjs';
const task = {
  taskId: spec.taskId ?? 'check-spec',
  kind: spec.kind ?? 'implement',
  title: spec.title ?? '',
  refs: Array.isArray(spec.refs) ? spec.refs : [],
  acceptance: spec.acceptance ?? '',
  prompt: spec.prompt ?? '',
  outputDir: spec.outputDir ?? 'out',
};
if (Array.isArray(spec.expectArtifacts) && spec.expectArtifacts.length) task.expectArtifacts = spec.expectArtifacts;
if (typeof spec.acceptanceScript === 'string' && spec.acceptanceScript.trim()) task.acceptanceScript = spec.acceptanceScript;

const tmp = path.join('D:\\dsh relay test', `_staging-check-${task.taskId}.json`);
fs.writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf8');
console.log(`[spec] taskId=${task.taskId} kind=${task.kind} prompt=${task.prompt.length}字符`);

const v = spawnSync(process.execPath, [VALIDATOR, 'validate-task', tmp], { encoding: 'utf8' });
console.log('[gate] ' + (v.stdout || '').trim().replace(/\s+/g, ' '));
let ok = v.status === 0;

const mojibakeHit = (() => {
  const runs = task.prompt.match(/[\u0080-\u00ff]{4,}/g) || [];
  for (const run of runs) {
    const decoded = Buffer.from(run, 'latin1').toString('utf8');
    if (!decoded.includes('\ufffd') && /[\u4e00-\u9fff]/.test(decoded)) return run.slice(0, 12);
  }
  return null;
})();
console.log('[gate] 编码自检 = ' + (mojibakeHit ? `失败（双重编码片段 ${JSON.stringify(mojibakeHit)}）` : '通过'));
if (mojibakeHit) ok = false;

// 写入范围自检：prompt 里声明的文件必须在磁盘上存在（[NEW] 前缀视为新建，跳过）
const declared = [...task.prompt.matchAll(/\/mnt\/d\/dsh-web-relay\/([A-Za-z0-9_./-]+\.(?:js|mjs|md|json|yml|yaml))/g)].map((m) => m[1]);
const uniq = [...new Set(declared)];
const missing = uniq.filter((rel) => !fs.existsSync(absOf(rel)));
console.log(`[refs] prompt 提及仓库文件 ${uniq.length} 个；磁盘缺失 ${missing.length} 个` + (missing.length ? `：${missing.join(', ')}` : ''));
console.log(`[exists] ${uniq.join(', ')}`);

// 锚点校验（B，2026-09-15 新增）：显式 anchors 必为真（FAIL 级）；多重命中与行号疑似漂移给 WARN
const anchorRes = checkAnchors(spec.anchors);
console.log(`[anchors] 声明 ${anchorRes.declared} 条（实际校验 ${anchorRes.checked} 条）；失败 ${anchorRes.failures.length} 条；告警 ${anchorRes.warnings.length} 条`);
for (const f of anchorRes.failures) console.log('  [anchors][FAIL] ' + f);
for (const w of anchorRes.warnings) console.log('  [anchors][WARN] ' + w);
if (anchorRes.failures.length) ok = false;
if (anchorRes.declared === 0) console.log('  [anchors][hint] 未声明 anchors —— 实现类规格建议声明（file+pattern 或 file+line+expect），可在派发前抓住行号漂移与锚点多义');

// 行号引用启发式核对（WARN 级）
const citeRes = checkPromptCitations(task.prompt);
if (citeRes.checked > 0) {
  console.log(`[citations] 核对 ${citeRes.checked} 条「约 Lnnn」行号引用；疑似漂移 ${citeRes.warnings.length} 条`);
  for (const w of citeRes.warnings) console.log('  [citations][WARN] ' + w);
}

fs.rmSync(tmp, { force: true });
console.log(ok ? 'RESULT: OK（可派发）' : 'RESULT: FAIL（不可派发）');
process.exit(ok ? 0 : 1);
