/**
 * task-scope.mjs
 *
 * CC 任务范围评估器（防 900s 超时浪费配额）。
 *
 * 背景（实测教训，详见 dsh-web-relay/docs/CC-HYBRID.md）：
 * 2026-09-10 主 agent 派发的 RCA 任务（5 个问题 + 4 方案评估 + 3 份产物）
 * 900s 超时失败（exit=124）且无任何产物——白耗 15 分钟 Pro 配额。
 * 而范围适中的任务均成功：v2 校验器实现 3.7min、248 行代码诊断 8min、
 * 架构征询（6 问 + 2 产物）4.3min。
 *
 * 现有 lib/triage-route.js 只判「该不该派 cc」（硬边界/豁免/启用），
 * 本模块补上「任务是否过大需拆分」这一环，供派发前预检。
 *
 * 纯函数、零第三方依赖、Node >=18（ESM）。
 */

// ---- 基线秒数（实测校准：实现类约 120s 起，分析类约 150s 起）----
export const BASELINE_IMPLEMENT_SECONDS = 120
export const BASELINE_ANALYSIS_SECONDS = 150

// ---- 各因子权重（2026-09-10 主 agent 复核校准）----
// 实测基准：架构征询任务（6 问 + 2 产物 + 8 refs）实际 258s 成功；RCA 任务（5 问 + 4 方案评估
// + 3 产物 + 5 refs + 明确要求核实源码并给出补丁）实际 900s 超时无产物。
// cc 初版参数（question 30 / artifact 120 / evalItem 90）对前者估出 930s → 误判 too-big 会
// 导致过度拆分（白耗配额与协调开销）。修正如下：
export const SECONDS_PER_QUESTION = 20        // 30 → 20（读题+简短回答的增量）
export const SECONDS_PER_ARTIFACT = 40        // 120 → 40（Claude 一次 Write 即落盘，非长写作）
export const SECONDS_PER_EVAL_ITEM = 20       // 90 → 20（编号项多为"问题列表"，不应按深度评估计）
export const REFS_CHUNK_SIZE = 3
export const SECONDS_PER_REFS_CHUNK = 40      // 60 → 40（读取消化的边际成本）
// 新增：深度动作词因子——真正的重任务特征（要求核实源码/逐条核对/方案评估/出补丁/实现/重构），
// 每项 +90s。它承担 RCA 型任务的耗时特征，使"问题多但回答简单"的任务不再被误判。
export const SECONDS_PER_DEEP_ACTION = 90

// ---- 判级阈值（对齐 runner.sh timeout 900s 与 lib/triage-route.js 的保守预估线）----
export const RISKY_THRESHOLD_SECONDS = 420
export const TOO_BIG_THRESHOLD_SECONDS = 600

function countMatches(re, str) {
  const m = str.match(re)
  return m ? m.length : 0
}

/**
 * 统计 prompt 中的"提问数"：问号（中英文）+"请...回答/说明/解释/列出/给出/评估"等显式征询句式。
 * 不统计编号列表标记（那部分由 countEvalItems 单独计入，避免同一处内容被两个因子重复加权）。
 */
function countQuestions(prompt) {
  const marks = countMatches(/[?？]/g, prompt)
  const asks = countMatches(/请[^\n。]{0,15}(?:回答|说明|解释|列出|给出|评估)/g, prompt)
  return marks + asks
}

/**
 * 统计 prompt 中显式枚举的评估项数：形如"1)""2."或圆圈数字"①②③"的行首标记。
 * 典型场景：多方案对比评估列表（RCA 任务实测"4 方案评估"即此类）。
 */
function countEvalItems(prompt) {
  const numbered = countMatches(/(?:^|[\s、，,;；])\d{1,2}[.)]/gm, prompt)
  const circled = countMatches(/[①②③④⑤⑥⑦⑧⑨⑩]/g, prompt)
  return numbered + circled
}

function baselineSecondsForKind(kind) {
  return kind === 'understand' || kind === 'review'
    ? BASELINE_ANALYSIS_SECONDS
    : BASELINE_IMPLEMENT_SECONDS
}

/**
 * 统计"深度动作"数：要求 Claude 做重活的特征词——核实源码、逐条核对、方案评估、
 * 出补丁、实现/重构、交叉验证、逐项测试等。这类动作每项实打实耗 1-2 分钟
 * （不同于"多问几个问题"），是 RCA 型任务超时的主因（2026-09-10 校准）。
 */
function countDeepActions(prompt) {
  const patterns = [
    /核实/g, /逐条核对|逐项核对|逐条给出/g, /方案评估|评估.{0,6}方案|四方案|多方案/g,
    /补丁|patch/gi, /实现|重构|修改代码|改源码/g, /交叉验证|交叉校验/g, /逐项测试|逐个测试|单测全覆盖/g,
  ]
  let n = 0
  for (const re of patterns) n += countMatches(re, prompt)
  return n
}

/**
 * 评估任务范围是否过大。
 * @param {{kind?: string, prompt?: string, expectArtifacts?: string[], refs?: string[]}} task
 * @returns {{level: 'ok'|'risky'|'too-big', estimatedSeconds: number, reasons: string[], suggestion: string}}
 */
export function assessTaskScope(task = {}) {
  const kind = typeof task?.kind === 'string' ? task.kind : 'unknown'
  const prompt = typeof task?.prompt === 'string' ? task.prompt : ''
  const artifacts = Array.isArray(task?.expectArtifacts) ? task.expectArtifacts : []
  const refs = Array.isArray(task?.refs) ? task.refs : []

  const questionCount = countQuestions(prompt)
  const evalItemCount = countEvalItems(prompt)
  const deepActionCount = countDeepActions(prompt)
  const artifactCount = artifacts.length
  const refsCount = refs.length
  const refsChunks = Math.floor(refsCount / REFS_CHUNK_SIZE)

  const baseline = baselineSecondsForKind(kind)
  const questionSeconds = questionCount * SECONDS_PER_QUESTION
  const artifactSeconds = artifactCount * SECONDS_PER_ARTIFACT
  const evalSeconds = evalItemCount * SECONDS_PER_EVAL_ITEM
  const refsSeconds = refsChunks * SECONDS_PER_REFS_CHUNK
  const deepSeconds = deepActionCount * SECONDS_PER_DEEP_ACTION

  const estimatedSeconds = baseline + questionSeconds + artifactSeconds + evalSeconds + refsSeconds + deepSeconds

  const reasons = [`基线 kind=${kind}：${baseline}s`]
  if (questionCount > 0) reasons.push(`问题数 ${questionCount}（+${questionSeconds}s）`)
  if (artifactCount > 0) reasons.push(`期望产物 ${artifactCount} 份（+${artifactSeconds}s）`)
  if (evalItemCount > 0) reasons.push(`显式枚举评估项 ${evalItemCount}（+${evalSeconds}s）`)
  if (refsChunks > 0) reasons.push(`refs ${refsCount} 个，每 ${REFS_CHUNK_SIZE} 个 +${SECONDS_PER_REFS_CHUNK}s（+${refsSeconds}s）`)
  if (deepActionCount > 0) reasons.push(`深度动作 ${deepActionCount} 项（核实/评估/补丁/实现类，+${deepSeconds}s）`)

  let level = 'ok'
  if (estimatedSeconds > TOO_BIG_THRESHOLD_SECONDS) level = 'too-big'
  else if (estimatedSeconds > RISKY_THRESHOLD_SECONDS) level = 'risky'

  let suggestion
  if (level === 'too-big') {
    suggestion = `预估 ${estimatedSeconds}s 超过安全线 ${TOO_BIG_THRESHOLD_SECONDS}s，必须拆分（2026-09-10 RCA 任务 5问+4方案+3产物 实测 900s 超时无产物）。建议用 recommendSplit() 按产物/主题拆为 2-4 个独立 task.json，先出诊断类任务再出产出类任务。`
  } else if (level === 'risky') {
    suggestion = `预估 ${estimatedSeconds}s 处于 ${RISKY_THRESHOLD_SECONDS}-${TOO_BIG_THRESHOLD_SECONDS}s 风险区间，建议精简问题数/产物数，或为该任务预留"降级为主 agent 直接实现"的后备方案。`
  } else {
    suggestion = `预估 ${estimatedSeconds}s 在安全范围内，无需拆分。`
  }

  return { level, estimatedSeconds, reasons, suggestion }
}

/**
 * 按"产物/主题"维度给出拆分建议。
 * @param {{kind?: string, prompt?: string, expectArtifacts?: string[], refs?: string[]}} task
 * @returns {{needed: boolean, chunks: Array<{title: string, focus: string}>}}
 */
export function recommendSplit(task = {}) {
  const assessment = assessTaskScope(task)
  if (assessment.level !== 'too-big') {
    return { needed: false, chunks: [] }
  }

  const artifacts = Array.isArray(task?.expectArtifacts) ? task.expectArtifacts : []
  const chunks = []

  if (artifacts.length >= 2) {
    // 产物数足够多时，按每份产物独立拆一个任务（最多 4 块）——每块只产出一份，避免单任务内多产物互相拖慢。
    for (const name of artifacts.slice(0, 4)) {
      chunks.push({
        title: `产出「${name}」`,
        focus: `只做「${name}」这一份产物涉及的分析与写作，不涉及其他产物`,
      })
    }
  } else {
    // 产物数不足以按产物拆分时，退化为"诊断/分析"与"实现/产出"两阶段拆分
    // （对齐 suggestion 中"任务 A 只做诊断、任务 B 只出补丁"的思路）。
    chunks.push(
      { title: '诊断/分析', focus: '只做问题定位与方案对比，不落地任何补丁或最终产物' },
      { title: '实现/产出', focus: '基于诊断结论直接出补丁或指定产物，不重复分析过程' },
    )
  }

  return { needed: true, chunks: chunks.slice(0, 4) }
}
