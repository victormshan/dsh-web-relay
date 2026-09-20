// 统一任务身份（**唯一来源**）—— 为四类任务载体提供一套规范 id，消除"各说各话"。
//
// 为什么需要（2026-09-20 分析得出）：系统里并存四种任务载体，各自的 id 词汇互不相通：
//   · cc 通道任务     taskId            （状态：D:\cc-tasks\tasks\<id>\）
//   · 三方协议迭代    exprId            （状态：web-relay/experiments\<exprId>.steps.json）
//   · 需要人介入信号  stableKey#gN      （状态：D:\cc-tasks\chain-needs-human.json）
//   · 主 agent 自持   （无 id —— "装填我自己的任务"至今无载体）
// 后果是跨载体追责只能靠人肉对账，且审计层只能**grep 散文**去认领对象（⑩ 的 J2 初版正是
// 在信号 detail 里正则扫 exprId —— 脆弱：措辞一改就失配）。
//
// 规范形态（写入方必须用 makeRef 产出，读取方用 parseRef 归一）：
//   cc:<taskId>              owner=cc         —— 派发给 cc 通道的工作项
//   expr:<exprId>            owner=main-agent —— 三方协议迭代（含 AutoIteration 版本演进）
//   signal:<stableKey>#g<N>  owner=main-agent —— "需要人介入"的信号实例（含代数）
//   main:<slug>              owner=main-agent —— 主 agent 自持任务（预留：装填自己的任务）
//
// 兼容策略：**无前缀的裸串一律归为 legacy**（历史信号里的 plain `expr-2026-…`）。legacy 可被
// 读取方识别用于匹配，但**不得**由写入方产出——否则又会出现两套形态。
export const TASK_KINDS = ['cc', 'expr', 'signal', 'main']

/** 各 kind 的权威信息：状态落在哪、终态有哪些。消费方据此解析对象，不再各写一套路径。 */
export const KIND_INFO = {
  cc: { owner: 'cc', stateDir: 'D:\\cc-tasks\\tasks\\<id>', terminalStates: ['approved-and-closed', 'closure-blocked', 'paused-too-many-attempts'] },
  expr: { owner: 'main-agent', stateDir: 'web-relay\\experiments\\<id>.steps.json', terminalStates: ['done', 'stopped', 'paused'] },
  signal: { owner: 'main-agent', stateDir: 'D:\\cc-tasks\\chain-needs-human.json', terminalStates: ['acknowledged', 'auto-resolved'] },
  main: { owner: 'main-agent', stateDir: 'D:\\cc-tasks\\main-tasks\\<id>.json', terminalStates: ['done', 'partial', 'timeout'] },
}

// 形态正则：**先判"像不像 ref"再判 kind 认不认识**。
// 初版写成 /^(cc|expr|signal|main):(.+)$/，导致 `bogus:x` 落进 legacy 分支、而下面的
// unknown-kind 分支永远不可达（死代码暴露了意图与实现不一致）——被 test/task-ref.test.mjs 抓到。
// 语义：`X:rest` 形态但 X 不是已知 kind → unknown-kind（不得当成 legacy 裸串，那会掩盖拼写错误）；
// 完全没有 kind 前缀 → legacy（历史裸串）。
const REF_RE = /^([A-Za-z][A-Za-z0-9_-]*):(.+)$/

/**
 * 造一个规范 ref。signal 必须带代数（同源只叫一次靠代数递增）。
 * @param {'cc'|'expr'|'signal'|'main'} kind
 * @param {string} id
 * @param {{generation?: number}} [opts]
 * @returns {string}
 */
export function makeRef(kind, id, { generation } = {}) {
  if (!TASK_KINDS.includes(kind)) throw new Error(`makeRef: 未知 kind ${kind}（允许 ${TASK_KINDS.join('/')}）`)
  const s = String(id == null ? '' : id).trim()
  if (!s) throw new Error('makeRef: id 必填')
  if (kind === 'signal') {
    const g = Number.isInteger(generation) && generation >= 1 ? generation : 1
    // 允许调用方直接传入已含 #gN 的 stableKey → 不重复追加
    return /#g\d+$/.test(s) ? `signal:${s}` : `signal:${s}#g${g}`
  }
  return `${kind}:${s}`
}

/**
 * 归一解析。任何输入都返回结构化结果，不抛。
 * @param {string} s
 * @returns {{ok:boolean, kind:string|null, id:string|null, generation:number|null, canonical:string|null, legacy:boolean, why:string}}
 */
export function parseRef(s) {
  const raw = String(s == null ? '' : s).trim()
  if (!raw) return { ok: false, kind: null, id: null, generation: null, canonical: null, legacy: false, why: 'empty' }
  const m = raw.match(REF_RE)
  if (!m) {
    // 裸串：legacy（历史形态）。identifiable 但非规范。
    return { ok: false, kind: 'legacy', id: raw, generation: null, canonical: null, legacy: true, why: 'no-kind-prefix（历史裸串，可匹配但不得用于新写入）' }
  }
  const kind = m[1]
  const rest = m[2]
  if (!TASK_KINDS.includes(kind)) return { ok: false, kind: null, id: null, generation: null, canonical: null, legacy: false, why: `unknown-kind:${kind}` }
  if (kind === 'signal') {
    const gm = rest.match(/^(.*)#g(\d+)$/)
    if (!gm) return { ok: false, kind, id: rest, generation: null, canonical: null, legacy: false, why: 'signal-ref-必须带 #g<N>' }
    return { ok: true, kind, id: gm[1], generation: Number(gm[2]), canonical: `signal:${gm[1]}#g${gm[2]}`, legacy: false, why: 'ok' }
  }
  if (!rest) return { ok: false, kind, id: null, generation: null, canonical: null, legacy: false, why: 'empty-id' }
  return { ok: true, kind, id: rest, generation: null, canonical: `${kind}:${rest}`, legacy: false, why: 'ok' }
}

/** 是否规范形态（写入方自检用；legacy 一律 false）。 */
export function isCanonicalRef(s) { return parseRef(s).ok === true }

/** 该对象归谁管、状态落在哪、终态是什么——让消费方不必再各写一套路径约定。 */
export function describeRef(s) {
  const p = parseRef(s)
  const info = p.kind && KIND_INFO[p.kind] ? KIND_INFO[p.kind] : null
  return {
    ref: s,
    ok: p.ok,
    legacy: p.legacy,
    kind: p.kind,
    id: p.id,
    generation: p.generation,
    owner: info ? info.owner : null,
    state: info ? info.stateDir.replace('<id>', String(p.id || '')) : null,
    terminalStates: info ? info.terminalStates : [],
    why: p.why,
  }
}

/**
 * 宽松匹配：两个 id 是否指向同一对象（供审计"该对象是否已登记"用）。
 * 接受一侧为 legacy 裸串（历史信号），但要求 id 逐字相等——**不做模糊/包含匹配**，
 * 因为"包含"正是旧实现 grep 散文的病根。
 */
export function sameRef(a, b) {
  const pa = parseRef(a), pb = parseRef(b)
  if (!pa.id || !pb.id) return false
  if (pa.id !== pb.id) return false
  // kind 冲突（都规范且不同）→ 不算同一对象
  if (pa.ok && pb.ok && pa.kind !== pb.kind) return false
  return true
}
