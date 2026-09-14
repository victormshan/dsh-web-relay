// dsh-web-relay · P3(v3.5.0) Architect 突破度门禁（非阻断 warn）+ V1-1 硬门禁
// 纯函数模块，便于镜像测试。
// 语义（协议层）：每 2 个 Incremental 版本后，下一版应含 Structural/Paradigm 突破项。
// 版本级判定：一个版本的 steps 中任一含 structural/paradigm → 本版计为"突破"（重置连增）；
//             否则任一含 incremental → 本版计为 incremental（连增 +1）；均无（unknown）→ 不计不重置（防误报）。
// 提示级（warn），不阻断 restructure/plan。
//
// V1-1: 在 warn 之上新增代码层硬门禁 evaluateBreakthroughPlan——连续 Incremental 版本数达到
// DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL（默认 3）时 gatePassed=false，要求下一版含 Structural 突破项；
// 并对「全部未声明 breakthrough_type」的计划做保守拦截（可用 DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED=1 放行）。

const TYPE_LEVEL = { incremental: 1, structural: 2, paradigm: 3 }

// 取单个 step 的突破度类型（incremental/structural/paradigm），无法识别返回 null
export function breakthroughTypeOf(step) {
  if (!step) return null
  const raw = step.breakthrough_type
    || (step.architect_vision && step.architect_vision.breakthrough_type)
    || (step.architect && step.architect.breakthrough_type)
  if (raw == null) return null
  const v = String(raw).trim().toLowerCase()
  return TYPE_LEVEL[v] ? v : null
}

// 版本级突破类型：包含突破项→'breakthrough'；否则含 incremental→'incremental'；否则 null
export function versionTypeOf(steps) {
  const seq = Array.isArray(steps) ? steps : []
  let hasInc = false
  for (const s of seq) {
    const t = breakthroughTypeOf(s)
    if (t === 'structural' || t === 'paradigm') return 'breakthrough'
    if (t === 'incremental') hasInc = true
  }
  return hasInc ? 'incremental' : null
}

// 版本门禁：传入本版 steps 与历史连增 streak，返回 { streak, warn }
export function auditBreakthrough(steps, prevStreak = 0) {
  const vt = versionTypeOf(steps)
  let streak = Number(prevStreak) || 0
  if (vt === 'breakthrough') streak = 0
  else if (vt === 'incremental') streak += 1
  const warn = streak >= 2
    ? `Architect 突破度提示（P3）：连续 ${streak} 个版本为 Incremental 且无 Structural/Paradigm 突破项——协议建议每 2 个 Incremental 后下一版含突破项（warn 不阻断）`
    : null
  return { streak, warn }
}

// V1-1: 突破度三阶评估硬门禁（纯函数，无 IO/Date/随机，历史可注入）。
// 入参：
//   steps   — 本版 step 数组（同 versionTypeOf 的输入契约）
//   history — 历史版本序列（旧到新），元素可为 'incremental' | 'breakthrough' | null，
//             或 { type: 'incremental' | 'breakthrough' | null } 形式
// 出参：{ gatePassed, consecutiveIncremental, verdict, requiredType, reasons[] }
export function evaluateBreakthroughPlan({ steps, history } = {}) {
  const seq = Array.isArray(steps) ? steps : []
  const hist = Array.isArray(history) ? history : []
  const MAX = Number(process.env.DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL || 3)

  // 保守拦截：本版非空但没有任何 step 声明 breakthrough_type（含嵌套 architect_vision/architect）——
  // 无法判定突破度，默认拦截；DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED=1 可显式放行（兼容存量计划）。
  const anyDeclared = seq.some((s) => breakthroughTypeOf(s) != null)
  if (seq.length > 0 && !anyDeclared) {
    if (process.env.DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED === '1') {
      return {
        gatePassed: true,
        consecutiveIncremental: 0,
        verdict: 'gate-passed-undeclared-allowed',
        requiredType: null,
        reasons: ['本版未声明任何突破度类型；DSH_RELAY_BREAKTHROUGH_ALLOW_UNDECLARED=1 已显式放行']
      }
    }
    return {
      gatePassed: false,
      consecutiveIncremental: 0,
      verdict: 'gate-needs-declaration',
      requiredType: 'structural',
      reasons: ['本版未声明任何突破度类型，无法判定；请由规划方补 breakthrough_type（incremental/structural/paradigm）']
    }
  }

  // 历史连续 Incremental 计数：遇 breakthrough 归零（并清空已计入的 reasons）；遇 null/unknown 跳过不重置。
  let consecutive = 0
  let reasons = []
  hist.forEach((h, idx) => {
    const t = (h && typeof h === 'object') ? h.type : h
    if (t === 'breakthrough' || t === 'structural' || t === 'paradigm') {
      consecutive = 0
      reasons = []
    } else if (t === 'incremental') {
      consecutive += 1
      reasons.push(`历史第 ${idx + 1} 版为 Incremental（连增计入第 ${consecutive} 次）`)
    }
    // t 为 null/unknown：不计不重置（防误报）
  })

  // 本版：含 structural/paradigm → 重置；仅 incremental → 连增 +1；unknown（含空数组）→ 不触发不改变。
  const vt = versionTypeOf(seq)
  if (vt === 'breakthrough') {
    consecutive = 0
    reasons = []
  } else if (vt === 'incremental') {
    consecutive += 1
    reasons.push(`本版为 Incremental（连增计入第 ${consecutive} 次）`)
  }

  if (consecutive >= MAX) {
    reasons.push(`连续 Incremental 版本数 ${consecutive} 已达阈值 DSH_RELAY_BREAKTHROUGH_MAX_INCREMENTAL=${MAX}，下一版须含 Structural/Paradigm 突破项`)
    return { gatePassed: false, consecutiveIncremental: consecutive, verdict: 'gate-blocked', requiredType: 'structural', reasons }
  }
  return { gatePassed: true, consecutiveIncremental: consecutive, verdict: 'gate-passed', requiredType: null, reasons: [] }
}
