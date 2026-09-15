// dsh-web-relay · 案例库解析/选择/渲染（V2-1，从 lib/index.js 抽出为可测纯函数）
// 行为与旧实现（lib/index.js 原 readCaseLibrary 内联正则 + buildCaseBlock 内联打分/渲染）逐字段等价：
// - 解析正则、字段名、trim 规则与旧实现完全一致；
// - 打分规则（词长>2 才计分、category 命中 +2、score>0 才入选、降序、Top-K 硬上限 3）与旧实现一致；
// - 渲染文案（标题/编号/reason 截 300/exprId+stepId 尾注）与旧实现一致；
// - 无命中/空库 → 渲染返回空串（不留空标题），与旧实现一致。
// 新增：dedupeCases（parseCaseLibrary 内部调用）按 exprId:stepId 去重、后出现者覆盖先出现者——
// 对正常写入路径（collectRejectedCases 已在写入前保证幂等）是无操作（no-op），仅对手工编辑等异常
// 文件提供防御性兜底，不改变现有生产数据的解析结果。

const CASE_RE_SOURCE = '## 案例 (\\d+)[\\s\\S]*?exprId: ([^\\n]+)[\\s\\S]*?stepId: ([^\\n]+)[\\s\\S]*?category: ([^\\n]+)[\\s\\S]*?reason: ([^\\n]+)[\\s\\S]*?recordedAt: ([^\\n]+)'

// 解析 prompt-case-library.md 文本 → 案例条目数组；不抛错，异常/无匹配返回 []
export function parseCaseLibrary(text) {
  const src = String(text || '')
  const re = new RegExp(CASE_RE_SOURCE, 'g')
  const cases = []
  let m
  while ((m = re.exec(src)) !== null) {
    cases.push({
      seq: Number(m[1]),
      exprId: m[2].trim(),
      stepId: m[3].trim(),
      category: m[4].trim(),
      reason: m[5].trim(),
      recordedAt: m[6].trim()
    })
  }
  return dedupeCases(cases)
}

// 按 exprId:stepId 去重（幂等键），后出现者覆盖先出现者
export function dedupeCases(cases) {
  const byKey = new Map()
  for (const c of (Array.isArray(cases) ? cases : [])) {
    if (!c || !c.exprId || !c.stepId) continue
    byKey.set(`${c.exprId}:${c.stepId}`, c)
  }
  return Array.from(byKey.values())
}

// 按 query 文本匹配案例 Top-K：
// - query 小写后按 /\s+/ 切词，仅取 length>2 的词；每命中一个词出现在 case.reason.toLowerCase() 中 +1；
// - 若 query 包含 case.category（原样，不额外小写——与旧实现字节等价，现网 category 均为小写 id，效果等同大小写不敏感）再 +2；
// - 过滤 score>0 → 按 score 降序 → slice(0, min(limit,3))（Top-K 硬上限 3，不可通过 limit 突破）
export function selectTopCases(items, { query, limit = 3 } = {}) {
  const topic = String(query || '').toLowerCase()
  const words = topic.split(/\s+/).filter((w) => w.length > 2)
  const cap = Math.min(limit == null ? 3 : Number(limit), 3)
  const scored = (Array.isArray(items) ? items : [])
    .map((c) => {
      const reason = String((c && c.reason) || '').toLowerCase()
      let score = 0
      for (const w of words) if (reason.includes(w)) score++
      if (c && topic.includes(c.category)) score += 2
      return { c, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, cap))
  return scored.map((x) => x.c)
}

// 渲染注入文本块；selected 为空 → 返回空串（不留空标题）
export function renderCaseBlock(selected) {
  if (!selected || selected.length === 0) return ''
  return '【历史拒收案例（V3.1 反思注入，Top-K≤3）】\n' + selected
    .map((c, i) => `${i + 1}. [${c.category}] ${String(c.reason || '').slice(0, 300)}（${c.exprId} Step ${c.stepId}）`)
    .join('\n')
}
