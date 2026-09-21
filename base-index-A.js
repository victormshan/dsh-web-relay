// dsh-web-relay — Host half. v0.3
// Providers:
//   'gemini-free' — official Google Gemini free-tier REST API (needs GEMINI_API_KEY env).
//   'manual' — no model call; persist a pasted answer.
// v0.3 adds structured-instruction execution:
//   POST /dsh-web-relay/parse    — server-side parse of ```json:agent-action blocks, never executes.
//   POST /dsh-web-relay/execute  — server-side RE-parse (never trusts client actions), executes the
//                                  selected indices, and writes ONE complete experiment record
//                                  (frontmatter + original text + parsed actions + per-item results).
// v0.5 record domain: every experiment is written to
//   <workspace>/web-relay/experiments/dsh-web-relay-<ts>.md   (record)
//   <workspace>/web-relay/traces/expr-<ts>.md                 (three-party trace)
// fully decoupled from side-window: the main agent reads the record via the
// injected workspacePath and appends its closure via POST /dsh-web-relay/trace.

import { randomUUID } from 'node:crypto'

export const name = 'dsh-web-relay'
// apiProxy must be a HARD inject (like dsh-side-window): ctx.get('apiProxy')
// returns undefined because the gateway registers later in composition order.
// shell stays optional via ctx.get (fallback: run_cmd reports unavailable).
export const inject = ['webServer', 'fs', 'sandboxPolicy', 'apiProxy']

/**
 * Canonical three-party protocol for the web-relay context (v0.5). Single
 * source of truth: returned by GET /dsh-web-relay/protocol and injected into
 * the packaged context (📦) for external models. The web-relay context is
 * fully decoupled from side-window: records + three-party traces live under
 * <workspace>/web-relay/.
 */
export const WEB_RELAY_PROTOCOL_VERSION = 'v1.2'
export const WEB_RELAY_PROTOCOL = [
  '三方主体（web-relay 语境）：用户 (the human) / 主 agent (the tool-using agent in the main harness session，负责执行与收口) / 外部AI (external web AI — Gemini/DeepSeek 网页版或 free API，负责提供方案与回答)。全程一致使用这三个称谓。',
  '协作规则：试验记录保存在 web-relay/experiments/，三方对话流水（轨迹）保存在 web-relay/traces/。用户在 web-relay 面板发起试验，外部AI 回答，主 agent 按需执行并收口；主 agent 的收口结论通过 POST /dsh-web-relay/trace 追加到对应轨迹，不再写入 side/。',
  '规则 8（Triage 分流）：小改动 → 直接给结论。复杂任务（多步实现/设计分歧/接口未验证）→ 回复生成时必须同时包含：① json:agent-action 代码块（含 wake_agent 动作，reason 说明）② 分步实施清单（Step List）。外部 AI 若未遵守，粘贴端将提示一键补全（见面板护栏）——但补全不改变内容本质，仅补格式。',
  '外部 AI Skill（v1.2 新增）：所有外部 AI 生成的内容必须遵循 web_relay_external_ai_protocol（版本 v1.2）——本协议的细化执行规范。三方称谓、规则 8 Triage 分流、json:agent-action Payload 格式、产出物与轨迹约定的完整说明见该 Skill 正文（常量 WEB_RELAY_EXTERNAL_AI_SKILL）。版本号：v1.2。'
].join('\n')

// v1.2: external-AI skill, the detailed execution spec referenced by the
// protocol. External AIs read this directly from the packaged context.
export const WEB_RELAY_EXTERNAL_AI_SKILL = [
  '# web_relay_external_ai_protocol · v1.2',
  '',
  '本 Skill 定义外部 AI（Gemini/DeepSeek 网页版等）在 dsh 协作体系中的职责与产出格式。生成任何方案、回答、代码前阅读并遵循本规范。',
  '',
  '## 三方称谓',
  '- [用户]：人类操作者，最终拍板方。',
  '- [主 agent]：执行方（读写文件、跑命令、调 harness 服务）。',
  '- [侧边 Agent]：方案与审查角色（无工具）；外部 AI 输出将经 relay 面板进入此体系。',
  '',
  '## 协作规则（规则 8 Triage，必须遵守）',
  '- 小改动 / 直接回答：直接给结论，无需 Payload。',
  '- 复杂任务（多步实现 / 设计分歧 / 接口未验证）：输出必须同时包含',
  '  ① json:agent-action 代码块（含 wake_agent 动作，reason 说明）',
  '  ② 分步实施清单（Step List）。',
  '  若未遵守，relay 粘贴端会提示一键补全——那只是补格式，不改变内容本质。',
  '',
  '## json:agent-action 格式',
  '```json',
  '[',
  '  { "action": "write_file", "path": "<workspace 相对路径>", "content": "..." },',
  '  { "action": "run_cmd", "command": "...", "cwd": ".", "timeout_ms": 30000 },',
  '  { "action": "wake_agent", "reason": "复杂任务，请主 agent 接管", "targetWorkspace": "<路径>", "context": "<引子，指向试验记录>" }',
  ']',
  '```',
  '- write_file：path 必须相对 workspace，不得越界。',
  '- run_cmd：必须带 timeout；高风险由用户在面板确认后执行。',
  '- wake_agent：context 是引子（前 1500 字 + 记录 id），完整内容在试验记录中。',
  '',
  '## 产出物约定',
  '- 方案经 relay 落盘：side/experiments/dsh-web-relay-<ts>.md',
  '- frontmatter：id / intent（general|project）/ channel（manual|gemini-free）/ status（pending|done）/ created',
  '- 执行轨迹：traces/<expr-id>.md，三方（用户/主 agent/外部 AI）可追加，幂等。',
  '',
  '## 安全护栏',
  '- 所有指令经 [用户] 确认后执行：面板勾选 → /parse 预览 → /execute。',
  '- 越界写文件、无 timeout 命令将被服务端拒绝（invalid）。',
  '- 一键补全只补格式，不代行执行意图。',
  '',
  '## 版本历史',
  '- v1.1：规则 8 Triage 分流硬编码。',
  '- v1.2：本 Skill 固化，作为规则 8 的细化执行规范。'
].join('\n')

// v0.5 record-domain constants: web-relay owns its own directory tree.
const EXPERIMENTS_DIR = 'web-relay/experiments'
const TRACES_DIR = 'web-relay/traces'
const LEGACY_EXPERIMENTS_DIR = 'side/experiments' // read-only compat for pre-v0.5 records
const TRACE_ID_RE = /^expr-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/
const ROLE_LABEL = { user: '用户', mainagent: '主 agent', external: '外部AI' }
const LABEL_ROLE = { '用户': 'user', '主 agent': 'mainagent', '外部AI': 'external' }

const GEMINI_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? ''
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash'

const RUN_CMD_TIMEOUT_DEFAULT = 30000
const RUN_CMD_TIMEOUT_MAX = 60000
// Capture up to 20k bytes per stream so the 2000-char display slice is the HEAD.
const OUTPUT_CAPTURE = 20000
const DISPLAY_LIMIT = 2000
const WRITE_FILE_MAX = 3
const RUN_CMD_MAX = 1

const CORS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type'
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const json = (res, code, payload) => {
  res.writeHead(code, CORS)
  res.end(JSON.stringify(payload))
}

async function callGemini(prompt) {
  const url = `${GEMINI_ROOT}/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  })
  const raw = await resp.text().catch(() => '')
  if (!resp.ok) return { ok: false, error: `Gemini HTTP ${resp.status}: ${raw.slice(0, 500)}` }
  let data
  try { data = JSON.parse(raw) } catch { return { ok: false, error: 'Gemini returned non-JSON response' } }
  const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')
  if (!text) return { ok: false, error: 'Gemini returned empty answer' }
  return { ok: true, text }
}

export function apply(ctx) {
  const { webServer, fs, sandboxPolicy, apiProxy } = ctx
  // shell is optional: run_cmd degrades to a clear error when unavailable.
  const shell = ctx.get('shell')

  const baseOf = (workspacePath) =>
    (workspacePath && String(workspacePath).trim())
      ? String(workspacePath).trim()
      : (sandboxPolicy?.workspaceRoot || process.cwd())

  const safePolicyFor = (base) =>
    sandboxPolicy?.resolve
      ? { ...sandboxPolicy.resolve({ mode: 'workspace-write' }), workspaceRoot: base }
      : { workspaceRoot: base, mode: 'workspace-write' }

  const clip = (s, n) => {
    const t = String(s || '')
    return t.length > n ? t.slice(0, n) + '…' : t
  }

  // ---------- server-side instruction parsing (single authority) ----------
  // Accepts several fenced-code shapes (never trusts a bare ```json block
  // unless its content validates as actions), plus a bare-JSON fallback so a
  // pasted Gemini Action Payload (```json or raw object) is still recognized:
  //   { sender, action: 'execute_batch', payload: { files: [{path, content}] }, needsAgent: true }
  //   -> normalized to write_file + wake_agent actions.
  function extractBlocks(text) {
    const blocks = [] // { raw, trusted: boolean }
    const src = text || ''
    const re = /```([^\n`]*)\n([\s\S]*?)```/g
    let m
    while ((m = re.exec(src)) !== null) {
      const lang = m[1].trim()
      const raw = m[2].trim()
      if (!raw) continue
      if (lang === 'json:agent-action' || lang.startsWith('json:agent-action ')) {
        blocks.push({ raw, trusted: true })
      } else if (lang === 'json' || lang === 'agent-action') {
        blocks.push({ raw, trusted: false }) // content-validated below
      }
      // other fence languages (plaintext etc.) are ignored to avoid false positives
    }
    // Bare-JSON fallback: a pasted raw object/array (e.g. copied straight from
    // Gemini), possibly with a short text prefix. Slice from the first { or [.
    if (blocks.length === 0) {
      const t = (text || '').trim()
      const start = t.search(/[[{]/)
      if (start >= 0) {
        const candidate = t.slice(start)
        try {
          const parsed = JSON.parse(candidate)
          if (parsed && typeof parsed === 'object') blocks.push({ raw: candidate, trusted: false })
        } catch (err) { /* not a clean JSON tail; ignore */ }
      }
    }
    return blocks
  }

  // Normalize a Gemini Action Payload protocol object into our action list.
  function geminiActions(obj) {
    const out = []
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out
    const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : {}
    const files = Array.isArray(payload.files) ? payload.files : []
    if (files.length > 0) {
      for (const f of files) {
        if (f && typeof f === 'object' && typeof f.path === 'string' && typeof f.content === 'string') {
          out.push({ action: 'write_file', path: f.path, content: f.content })
        }
      }
    }
    if (obj.needsAgent === true || obj.needsAgent === 'true') {
      out.push({
        action: 'wake_agent',
        reason: typeof obj.needsAgentReason === 'string' ? obj.needsAgentReason : '网页 AI 请求唤醒主 agent 接管'
      })
    }
    return out
  }

  /**
   * Parse the pasted text into a validated action list.
   * Returns { actions, needsAgent } where each action is
   * { index, type, summary, risk: 'low'|'medium'|'high', checked, detail, ...internals }.
   * `needsAgent` is null unless a plan action or the action count exceeds the threshold.
   */
  async function parseActions(text, base) {
    const blocks = extractBlocks(text)
    if (blocks.length === 0) return { actions: [], needsAgent: null }

    const baseTarget = await fs.resolve('.', { cwd: base })
    const actions = []
    let planSeen = false
    let writeCount = 0
    let cmdCount = 0

    const pushInvalid = (summary, detail) => {
      actions.push({ index: actions.length, type: 'invalid', summary, risk: 'high', checked: false, detail })
    }

    for (const block of blocks) {
      let parsed
      try { parsed = JSON.parse(block.raw) } catch (err) {
        if (block.trusted) pushInvalid('指令块 JSON 解析失败', String(err && err.message || err))
        continue // untrusted broken JSON: skip silently
      }
      // Normalize: array of actions | Gemini protocol object | single action object
      let list
      if (Array.isArray(parsed)) {
        list = parsed
      } else if (parsed && typeof parsed === 'object') {
        const g = geminiActions(parsed)
        list = g.length > 0 ? g : [parsed]
      } else {
        list = [parsed]
      }
      const before = actions.length
      for (const item of list) {
        if (!item || typeof item !== 'object') {
          pushInvalid('非对象指令项', '指令数组的每一项都必须是对象')
          continue
        }
        const action = String(item.action || item.type || '')

        if (action === 'write_file') {
          const path = typeof item.path === 'string' ? item.path.trim() : ''
          const content = typeof item.content === 'string' ? item.content : ''
          if (!path || !content) {
            pushInvalid('write_file 缺 path 或 content', 'write_file 需要 path 与 content 字段')
            continue
          }
          let target = null
          let inWorkspace = false
          try {
            target = await fs.resolve(path, { cwd: base })
            inWorkspace = fs.contains(baseTarget, target)
          } catch (err) { inWorkspace = false }
          if (!inWorkspace) {
            pushInvalid(`write_file 目标越界: ${path}`, `目标必须解析在 workspace 内（${base}）`)
            continue
          }
          const insideSide = path.split(/[\\/]/)[0] === 'side'
          const risk = insideSide ? 'low' : 'medium'
          writeCount += 1
          actions.push({
            index: actions.length,
            type: 'write_file',
            summary: `写入 ${clip(path, 60)}（${content.length} 字符）`,
            risk,
            checked: true, // low/medium default checked
            detail: `目标: ${target.displayPath || path}\n内容长度: ${content.length}`,
            // internals for execute (server-side re-parse rebuilds these)
            path, content
          })
        } else if (action === 'run_cmd') {
          const command = typeof item.command === 'string' ? item.command.trim() : ''
          if (!command) {
            pushInvalid('run_cmd 缺 command', 'run_cmd 需要 command 字段')
            continue
          }
          const cwdRel = typeof item.cwd === 'string' && item.cwd.trim() ? item.cwd.trim() : '.'
          let cwdAbs = base
          let inWorkspace = false
          try {
            const cwdTarget = await fs.resolve(cwdRel, { cwd: base })
            cwdAbs = fs.processPath(cwdTarget)
            inWorkspace = fs.contains(baseTarget, cwdTarget)
          } catch (err) { inWorkspace = false }
          if (!inWorkspace) {
            pushInvalid(`run_cmd cwd 越界: ${cwdRel}`, `cwd 必须解析在 workspace 内（${base}）`)
            continue
          }
          const timeoutMs = Math.min(Math.max(Number(item.timeout_ms) || RUN_CMD_TIMEOUT_DEFAULT, 1000), RUN_CMD_TIMEOUT_MAX)
          cmdCount += 1
          actions.push({
            index: actions.length,
            type: 'run_cmd',
            summary: `执行 ${clip(command, 60)}`,
            risk: 'high',
            checked: false, // high risk: never default-checked
            detail: `命令: ${command}\ncwd: ${cwdAbs}\ntimeout: ${timeoutMs}ms\n⚠ 高风险：确认后再勾选`,
            // internals for execute
            command, cwd: cwdAbs, timeoutMs
          })
        } else if (action === 'wake_agent') {
          actions.push({
            index: actions.length,
            type: 'wake_agent',
            summary: '唤醒主 Agent',
            risk: 'medium',
            checked: true, // wake-up is an explicit cooperation request, default checked
            detail: (typeof item.reason === 'string' && item.reason ? `原因: ${item.reason}\n` : '') + '将调用 apiProxy 注入唤醒主 agent 接管后续工作',
            reason: typeof item.reason === 'string' ? item.reason : ''
          })
        } else if (action === 'plan') {
          planSeen = true
          actions.push({
            index: actions.length,
            type: 'plan',
            summary: '计划型指令（需主 agent 接管）',
            risk: 'high',
            checked: false,
            detail: typeof item.description === 'string' ? item.description : '该指令需要主 agent 规划与执行'
          })
        } else {
          pushInvalid(`未知 action: ${action || '(空)'}`, '仅支持 write_file / run_cmd / wake_agent / plan；未知类型不执行')
        }
      }
      // Content validation for untrusted blocks (```json, bare JSON): roll back
      // the whole block if it produced nothing but invalid entries, so ordinary
      // JSON snippets in the answer are never mistaken for instructions.
      if (!block.trusted && actions.length > before && actions.slice(before).every((a) => a.type === 'invalid')) {
        actions.length = before
      }
    }

    let needsAgent = null
    if (planSeen) {
      needsAgent = { reason: '包含 plan 类型指令，需主 agent 规划执行', handoffText: null }
    } else if (writeCount > WRITE_FILE_MAX || cmdCount > RUN_CMD_MAX) {
      needsAgent = {
        reason: `指令规模超阈值（write_file=${writeCount}（上限${WRITE_FILE_MAX}）, run_cmd=${cmdCount}（上限${RUN_CMD_MAX}）），建议主 agent 接管`,
        handoffText: null
      }
    }
    return { actions, needsAgent }
  }

  // ---------- record persistence ----------
  async function saveRecord({ base, safePolicy, prompt, answer, channel, actions, results, selectedIndices, status, stamp }) {
    const stampFinal = stamp || new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    const id = `expr-${stampFinal}`
    const relPath = `${EXPERIMENTS_DIR}/dsh-web-relay-${stampFinal}.md`
    const fileTarget = await fs.resolve(relPath, { cwd: base })
    const content = [
      '---',
      `id: ${id}`,
      'intent: general',
      `channel: ${channel}`,
      `status: ${status}`,
      `created: ${new Date().toISOString()}`,
      '---',
      '',
      '## Prompt',
      '',
      prompt || '(无 prompt)',
      '',
      '## Answer',
      '',
      answer || '(无)',
      '',
      '## 指令解析',
      '',
      JSON.stringify(actions, null, 2),
      '',
      selectedIndices && selectedIndices.length > 0
        ? `## 执行所选（indices: [${selectedIndices.join(', ')}]）`
        : '## 执行所选\n\n（未执行任何指令）',
      '',
      results && results.length > 0
        ? results.map((r) => `- [${r.ok ? 'OK' : 'FAIL'}] #${r.index} ${r.type}: ${r.summary}\n  ${r.detail}`).join('\n')
        : '(无结果)',
      ''
    ].join('\n')
    await fs.writeText(fileTarget, content, undefined, undefined, safePolicy)
    return { id, relPath, fileTarget }
  }

  // ---------- v0.5: three-party trace (web-relay/traces) ----------
  // One trace file per experiment (same stamp/id as the record): a markdown
  // log of role-labelled entries [用户] / [主 agent] / [外部AI] appended over
  // time. The main agent appends its closure via POST /dsh-web-relay/trace.
  const TRACE_ENTRY_RE = /^## \[(用户|主 agent|外部AI)\] (.+)$/

  function traceEntriesFrom(text) {
    const entries = []
    const lines = String(text || '').split('\n')
    let cur = null
    for (const line of lines) {
      const m = line.match(TRACE_ENTRY_RE)
      if (m) {
        if (cur) entries.push(cur)
        cur = { role: LABEL_ROLE[m[1]] || m[1], at: m[2], text: [] }
      } else if (cur) {
        cur.text.push(line)
      }
    }
    if (cur) entries.push(cur)
    return entries.map((e) => ({ role: e.role, at: e.at, text: e.text.join('\n').trim() }))
  }

  async function loadTrace(base, exprId) {
    const target = await fs.resolve(`${TRACES_DIR}/${exprId}.md`, { cwd: base })
    try {
      const text = await fs.readText(target)
      const body = text.replace(/^---[\s\S]*?---\n/, '')
      return { target, entries: traceEntriesFrom(body) }
    } catch (err) {
      return { target, entries: [] }
    }
  }

  const traceEntry = (role, text) => ({ role, at: new Date().toISOString(), text: String(text || '') })

  async function appendTrace({ base, safePolicy, exprId, entries }) {
    const { target, entries: existing } = await loadTrace(base, exprId)
    const merged = existing.concat(entries)
    const content = [
      '---',
      `id: ${exprId}`,
      'kind: trace',
      'status: open',
      `created: ${new Date().toISOString()}`,
      '---',
      '',
      ...merged.map((e) => [`## [${ROLE_LABEL[e.role] || e.role}] ${e.at}`, '', e.text || '(空)', ''].join('\n'))
    ].join('\n')
    await fs.writeText(target, content, undefined, undefined, safePolicy)
    return { target }
  }

  async function wakeMainAgent({ sessionId, handoffText }) {
    if (!apiProxy || !sessionId || !handoffText) return { agentWoken: false, reason: 'apiProxy 或 sessionId 不可用' }
    try {
      const resp = await apiProxy.sessions.prompt({
        rpcId: randomUUID(),
        payload: {
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: handoffText }]
        }
      })
      const accepted = !!(resp && resp.result && resp.result.ok === true)
      return accepted
        ? { agentWoken: true, reason: null }
        : { agentWoken: false, reason: resp?.result?.error ? `${resp.result.error.code}: ${resp.result.error.message}` : 'unknown error' }
    } catch (err) {
      return { agentWoken: false, reason: String(err && err.message || err) }
    }
  }

  // ---------- routes ----------
  const statusHandler = (req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end()
    const mem = process.memoryUsage()
    json(res, 200, {
      ok: true,
      geminiConfigured: Boolean(GEMINI_KEY),
      model: GEMINI_MODEL,
      version: '0.5.0',
      shellAvailable: Boolean(shell),
      apiProxyAvailable: Boolean(apiProxy),
      uptime: Math.round(process.uptime()),
      memoryUsage: Math.round(mem.rss / 1024 / 1024) // MB
    })
  }

  const askHandler = async (req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end()
    let body = ''
    try { body = await readBody(req) } catch { return json(res, 400, { ok: false, error: 'bad body' }) }
    let payload
    try { payload = JSON.parse(body || '{}') } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }) }

    const provider = payload.provider
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
    const pasted = typeof payload.answer === 'string' ? payload.answer.trim() : ''
    const workspacePath = typeof payload.workspacePath === 'string' ? payload.workspacePath : null

    if (!provider) return json(res, 400, { ok: false, error: 'missing provider' })

    let providerLabel = provider
    let answer = ''

    try {
      if (provider === 'gemini-free') {
        providerLabel = 'Gemini Free API'
        if (!GEMINI_KEY) return json(res, 400, { ok: false, error: 'GEMINI_API_KEY 未配置；设置环境变量后重启 dsh web 再试。' })
        if (!prompt) return json(res, 400, { ok: false, error: '缺少 prompt' })
        const r = await callGemini(prompt)
        if (!r.ok) return json(res, 502, r)
        answer = r.text
      } else if (provider === 'manual') {
        providerLabel = '手动粘贴'
        if (!pasted) return json(res, 400, { ok: false, error: 'manual 模式需要粘贴回答' })
        answer = pasted
      } else {
        return json(res, 400, { ok: false, error: `未知 provider: ${provider}` })
      }

      const base = baseOf(workspacePath)
      const safePolicy = safePolicyFor(base)
      const { id, relPath, fileTarget } = await saveRecord({
        base, safePolicy, prompt, answer, channel: provider === 'gemini-free' ? 'gemini-free' : 'manual',
        actions: [], results: [], selectedIndices: [], status: 'pending'
      })
      // v0.5: seed the three-party trace (用户 prompt → 外部AI answer).
      await appendTrace({ base, safePolicy, exprId: id, entries: [
        traceEntry('user', prompt || '(无 prompt)'),
        traceEntry('external', answer || '(无)')
      ] }).catch(() => {}) // trace is best-effort; the record save is authoritative
      json(res, 200, { ok: true, answer, savedPath: fileTarget?.displayPath || relPath, id })
    } catch (err) {
      json(res, 500, { ok: false, error: String(err?.message || err) })
    }
  }

  // ---------- v0.5: record + trace listing (shared by context / traces routes) ----------
  async function listRecordSummaries(base) {
    const records = []
    const seen = new Set()
    // web-relay/experiments first, then legacy side/experiments (read-only compat).
    for (const rel of [EXPERIMENTS_DIR, LEGACY_EXPERIMENTS_DIR]) {
      let entries = []
      try {
        const dir = await fs.resolve(rel, { cwd: base })
        entries = await fs.listDir(dir)
      } catch (err) { /* dir not created yet */ }
      const files = entries
        .filter((e) => e.type === 'file' && e.name.endsWith('.md'))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const f of files) {
        if (seen.has(f.name)) continue
        seen.add(f.name)
        try {
          const text = await fs.readText(f.target)
          const meta = {}
          const fm = text.match(/^---\n([\s\S]*?)\n---/)
          if (fm) {
            for (const line of fm[1].split('\n')) {
              const m = line.match(/^([a-zA-Z]+):\s*(.*)$/)
              if (m) meta[m[1]] = m[2]
            }
          }
          const body = fm ? text.slice(fm[0].length).trim() : text
          records.push({
            file: f.name,
            id: meta.id || f.name,
            intent: meta.intent || 'general',
            channel: meta.channel || 'unknown',
            status: meta.status || 'pending',
            created: meta.created || '',
            snippet: body.split('\n').filter((l) => l.trim()).slice(0, 3).join(' ').slice(0, 140)
          })
        } catch (err) { /* skip unreadable */ }
      }
    }
    return records.sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0))
  }

  async function listTraces(base) {
    const traces = []
    let entries = []
    try {
      const dir = await fs.resolve(TRACES_DIR, { cwd: base })
      entries = await fs.listDir(dir)
    } catch (err) { /* dir not created yet */ }
    const files = entries
      .filter((e) => e.type === 'file' && e.name.endsWith('.md'))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(-20)
    for (const f of files) {
      try {
        const text = await fs.readText(f.target)
        const meta = {}
        const fm = text.match(/^---\n([\s\S]*?)\n---/)
        if (fm) {
          for (const line of fm[1].split('\n')) {
            const m = line.match(/^([a-zA-Z]+):\s*(.*)$/)
            if (m) meta[m[1]] = m[2]
          }
        }
        const body = fm ? text.slice(fm[0].length) : text
        traces.push({
          file: f.name,
          id: meta.id || f.name.replace(/\.md$/, ''),
          created: meta.created || '',
          entries: traceEntriesFrom(body)
        })
      } catch (err) { /* skip unreadable */ }
    }
    return traces
  }

  // GET /dsh-web-relay/context?cwd=...  → { ok, protocol, records, traces }
  // Step 1 (protocol hardening): the three-party protocol is a TOP-LEVEL field,
  // never mixed into records/traces, so any consumer (frontend, external AI,
  // scripts) reads it by name — the external AI always sees the contract even
  // when it calls this endpoint directly instead of /protocol.
  const contextHandler = async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end()
      const url = new URL(req.url || '/', 'http://localhost')
      const cwd = url.searchParams.get('cwd') || ''
      const base = cwd || sandboxPolicy?.workspaceRoot || process.cwd()
      const records = (await listRecordSummaries(base)).slice(0, 3)
      // v0.5: the packaged context carries the web-relay three-party traces
      // instead of the side-window conversation (fully decoupled).
      const traces = await listTraces(base)
      json(res, 200, {
        ok: true,
        protocol: { version: WEB_RELAY_PROTOCOL_VERSION, text: WEB_RELAY_PROTOCOL },
        skill: { name: 'web_relay_external_ai_protocol', version: WEB_RELAY_PROTOCOL_VERSION, text: WEB_RELAY_EXTERNAL_AI_SKILL },
        records,
        traces
      })
    } catch (err) {
      json(res, 500, { ok: false, error: String(err?.message || err) })
    }
  }

  // POST /dsh-web-relay/parse  body { text, workspacePath? } → { ok, actions, needsAgent }
  const parseHandler = async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end()
      const payload = JSON.parse((await readBody(req)) || '{}')
      const text = typeof payload.text === 'string' ? payload.text : ''
      const base = baseOf(payload.workspacePath)
      const { actions, needsAgent } = await parseActions(text, base)
      json(res, 200, { ok: true, actions, needsAgent })
    } catch (err) {
      json(res, 500, { ok: false, error: String(err?.message || err) })
    }
  }

  // POST /dsh-web-relay/execute  body { text, indices, workspacePath?, prompt?, sessionId? }
  // Server-side authority: re-parses text, executes only the selected indices, writes ONE record.
  const executeHandler = async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end()
      const payload = JSON.parse((await readBody(req)) || '{}')
      const text = typeof payload.text === 'string' ? payload.text : ''
      const workspacePath = typeof payload.workspacePath === 'string' ? payload.workspacePath : ''
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
      const rawIndices = Array.isArray(payload.indices)
        ? payload.indices.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0)
        : []

      // Precompute the record stamp once so wake/handoff messages can reference
      // the exact record path before it is written (Step 3 cross-workspace bridge).
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)

      const base = baseOf(workspacePath)
      const safePolicy = safePolicyFor(base)

      // NEVER trust client-provided actions: re-parse here.
      const { actions, needsAgent } = await parseActions(text, base)
      const byIndex = new Map(actions.map((a) => [a.index, a]))
      const selected = rawIndices.map((i) => byIndex.get(i)).filter(Boolean)

      const results = []
      const mainAgentTrace = [] // v0.5: 主 agent 唤醒/交接消息，随三方轨迹落盘
      for (const action of selected) {
        if (action.type === 'write_file') {
          try {
            const target = await fs.resolve(action.path, { cwd: base })
            await fs.writeText(target, action.content, undefined, undefined, safePolicy)
            results.push({ index: action.index, type: 'write_file', ok: true, summary: `已写入 ${action.path}`, detail: `${action.content.length} 字符` })
          } catch (err) {
            results.push({ index: action.index, type: 'write_file', ok: false, summary: `写入失败: ${action.path}`, detail: String(err && err.message || err) })
          }
        } else if (action.type === 'run_cmd') {
          if (!shell) {
            results.push({ index: action.index, type: 'run_cmd', ok: false, summary: 'shell 服务不可用', detail: 'host 未提供 ctx.shell，无法执行命令' })
            continue
          }
          try {
            const spec = shell.resolve({
              command: action.command,
              workdir: action.cwd,
              timeoutMs: action.timeoutMs,
              stdoutMaxBytes: OUTPUT_CAPTURE,
              sandboxPolicy: safePolicy
            })
            // shell.run never rejects business outcomes: check the result fields.
            const r = await shell.run(spec)
            const ok = r.exitCode === 0 && !r.timedOut && !r.aborted
            const out = clip((r.stdout && r.stdout.text) || '', DISPLAY_LIMIT)
            const errOut = clip((r.stderr && r.stderr.text) || '', DISPLAY_LIMIT)
            const cause = r.timedOut ? ' (timedOut)' : r.aborted ? ' (aborted)' : ''
            results.push({
              index: action.index, type: 'run_cmd', ok,
              summary: ok ? `命令完成 (exit ${r.exitCode})` : `命令未成功 (exit ${r.exitCode}${cause})`,
              detail: `命令: ${action.command}\n--- stdout ---\n${out || '(空)'}\n--- stderr ---\n${errOut || '(空)'}`
            })
          } catch (err) {
            results.push({ index: action.index, type: 'run_cmd', ok: false, summary: '命令执行异常', detail: String(err && err.message || err) })
          }
        } else if (action.type === 'wake_agent') {
          // Explicit wake-up request (e.g. Gemini Action Payload needsAgent: true):
          // inject a user-role message into the main agent session via apiProxy.
          // Step 3 (cross-workspace context bridge): carry the effective
          // workspace + record path so the main agent works against the injected
          // path instead of guessing from its own default cwd.
          const wsFallback = !(workspacePath && String(workspacePath).trim())
          const wakeText = [
            `【主 agent 请协助】dsh-web-relay 试验记录（即将落盘）`,
            '',
            '【跨工作区上下文桥接】',
            `workspacePath: ${base}${wsFallback ? '（fallback 值：client 未传 workspacePath，Host 使用部署根）' : ''}`,
            `试验记录: web-relay/experiments/dsh-web-relay-${stamp}.md（id: expr-${stamp}）`,
            `三方轨迹: web-relay/traces/expr-${stamp}.md（收口结论请追加到该轨迹）`,
            `摘要: actions ${actions.length} 条（${actions.map((a) => a.type).join('/') || '(空)'}）；本次执行 ${selected.length} 条`,
            '',
            '优先按注入的 workspacePath 处理该试验（读取记录、执行指令、回写结论都基于该路径），而非当前默认 cwd。',
            '',
            action.reason || '网页 AI 请求唤醒主 agent 接管',
            '',
            `请读取该试验记录并整合收口。`,
            '',
            '收口方式：把最终结论通过 POST /dsh-web-relay/trace 追加到三方轨迹（body {"workspacePath": "<项目路径>", "exprId": "' + `expr-${stamp}` + '", "role": "mainagent", "text": "<你的发言>"}）。'
          ].join('\n')
          mainAgentTrace.push(traceEntry('mainagent', wakeText))
          const wake = await wakeMainAgent({ sessionId, handoffText: wakeText })
          results.push({
            index: action.index, type: 'wake_agent', ok: wake.agentWoken,
            summary: wake.agentWoken ? '已唤醒主 Agent' : '唤醒失败',
            detail: wake.agentWoken ? 'apiProxy 注入成功' : (wake.reason || '注入不可达（缺少 sessionId 或 apiProxy）')
          })
        } else {
          results.push({ index: action.index, type: action.type, ok: false, summary: '未执行', detail: 'invalid/plan 指令不在勾选执行范围' })
        }
      }

      const executed = selected.length > 0
      const allOk = executed && results.length > 0 && results.every((r) => r.ok)
      // status rules (contract-pinned): only-execute + no needsAgent → done; anything else → pending
      const status = executed && allOk && !needsAgent ? 'done' : 'pending'

      const { id, relPath, fileTarget } = await saveRecord({
        base, safePolicy, prompt, answer: text,
        channel: 'manual',
        actions, results,
        selectedIndices: selected.map((a) => a.index),
        status,
        stamp
      })

      // v0.5: write the three-party trace (用户 prompt → 外部AI 回答 → 主 agent 唤醒消息).
      await appendTrace({ base, safePolicy, exprId: id, entries: [
        traceEntry('user', prompt || '(无 prompt)'),
        traceEntry('external', text || '(无)'),
        ...mainAgentTrace
      ] }).catch(() => {}) // trace is best-effort; the record save is authoritative

      // needsAgent → try apiProxy wake-up; fall back to a copyable handoff block.
      let agentWoken = false
      let wakeReason = null
      let handoffText = null
      if (needsAgent) {
        // Step 3 (cross-workspace context bridge): carry the effective
        // workspace + record path + a short summary in the handoff, so the main
        // agent works against the injected workspace instead of guessing from
        // its own default cwd (empty in a brand-new workspace).
        const wsFallback = !(workspacePath && String(workspacePath).trim())
        const recordText = await fs.readText(fileTarget).catch(() => '')
        const fm = (recordText.match(/^---\n([\s\S]*?)\n---/) || [])[1] || ''
        const fmHead = fm.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 2).join('; ')
        const resSec = (recordText.match(/## 执行所选[^\n]*\n([\s\S]*?)(?=\n## |$)/) || [])[1] || ''
        const summary = clip('frontmatter: ' + fmHead + ' | 执行结果: ' + resSec.trim().replace(/\s+/g, ' '), 200)
        handoffText = [
          `【主 agent 请协助】dsh-web-relay 试验记录 ${id}`,
          '',
          '【跨工作区上下文桥接】',
          `workspacePath: ${base}${wsFallback ? '（fallback 值：client 未传 workspacePath，Host 使用部署根）' : ''}`,
          `试验记录: ${fileTarget.displayPath || relPath}`,
          `三方轨迹: web-relay/traces/${id}.md（收口结论请追加到该轨迹）`,
          `摘要: ${summary}`,
          '',
          '优先按注入的 workspacePath 处理该试验（读取记录、执行指令、回写结论都基于该路径），而非当前默认 cwd。',
          '',
          `请读取并整合：${fileTarget.displayPath || relPath}`,
          '',
          `原因：${needsAgent.reason}`,
          '',
          '指令原文（已解析）：',
          '```json:agent-action',
          JSON.stringify(actions.filter((a) => a.type === 'write_file' || a.type === 'run_cmd' || a.type === 'plan'), null, 2),
          '```',
          '',
          `请按需执行并整合，把最终结论通过 POST /dsh-web-relay/trace 追加到三方轨迹（body {"workspacePath": "${base}", "exprId": "${id}", "role": "mainagent", "text": "<你的发言>"}）。`
        ].join('\n')
        // v0.5: log the handoff as a 主 agent trace entry too.
        await appendTrace({ base, safePolicy, exprId: id, entries: [traceEntry('mainagent', handoffText)] }).catch(() => {})
        const wake = await wakeMainAgent({ sessionId, handoffText })
        agentWoken = wake.agentWoken
        wakeReason = wake.reason
      }

      json(res, 200, {
        ok: true,
        results,
        recordPath: fileTarget?.displayPath || relPath,
        id,
        status,
        needsAgent: needsAgent
          ? { reason: needsAgent.reason, agentWoken, wakeReason, handoffText }
          : null
      })
    } catch (err) {
      json(res, 500, { ok: false, error: String(err?.message || err) })
    }
  }

  // GET /dsh-web-relay/traces?cwd=...  → { ok, traces } (trace page feed)
  const tracesHandler = async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end()
      const url = new URL(req.url || '/', 'http://localhost')
      const cwd = url.searchParams.get('cwd') || ''
      const base = baseOf(cwd)
      const traces = await listTraces(base)
      json(res, 200, { ok: true, traces })
    } catch (err) {
      json(res, 500, { ok: false, error: String(err?.message || err) })
    }
  }

  // GET /dsh-web-relay/record?cwd=...&id=expr-<ts>  → { ok, record: { id, text } }
  const recordHandler = async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end()
      const url = new URL(req.url || '/', 'http://localhost')
      const cwd = url.searchParams.get('cwd') || ''
      const id = url.searchParams.get('id') || ''
      const base = baseOf(cwd)
      if (!TRACE_ID_RE.test(id)) return json(res, 400, { ok: false, error: 'invalid record id' })
      const rel = `${EXPERIMENTS_DIR}/dsh-web-relay-${id.slice(5)}.md`
      const target = await fs.resolve(rel, { cwd: base })
      const text = await fs.readText(target)
      json(res, 200, { ok: true, record: { id, text } })
    } catch (err) {
      json(res, 404, { ok: false, error: String(err?.message || err) })
    }
  }

  // POST /dsh-web-relay/trace  body { workspacePath?, exprId, role, text }
  // Appends one three-party trace entry (role: user | mainagent | external).
  const traceHandler = async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end()
      const payload = JSON.parse((await readBody(req)) || '{}')
      const exprId = typeof payload.exprId === 'string' ? payload.exprId.trim() : ''
      const role = typeof payload.role === 'string' ? payload.role.trim() : ''
      const text = typeof payload.text === 'string' ? payload.text : ''
      if (!TRACE_ID_RE.test(exprId)) return json(res, 400, { ok: false, error: 'invalid exprId' })
      if (!Object.prototype.hasOwnProperty.call(ROLE_LABEL, role)) {
        return json(res, 400, { ok: false, error: `invalid role: ${role}（允许 user / mainagent / external）` })
      }
      if (!String(text).trim()) return json(res, 400, { ok: false, error: 'missing text' })
      const base = baseOf(payload.workspacePath)
      const safePolicy = safePolicyFor(base)
      await appendTrace({ base, safePolicy, exprId, entries: [traceEntry(role, text)] })
      json(res, 200, { ok: true, exprId, role })
    } catch (err) {
      json(res, 500, { ok: false, error: String(err?.message || err) })
    }
  }

  // GET /dsh-web-relay/protocol → { ok, version, text, skill } (web-relay three-party protocol)
  const protocolHandler = async (req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end()
    json(res, 200, {
      ok: true,
      version: WEB_RELAY_PROTOCOL_VERSION,
      text: WEB_RELAY_PROTOCOL,
      skill: { name: 'web_relay_external_ai_protocol', version: WEB_RELAY_PROTOCOL_VERSION, text: WEB_RELAY_EXTERNAL_AI_SKILL }
    })
  }

  ctx.effect(() => webServer.register({ kind: 'exact', path: '/dsh-web-relay/status', handler: statusHandler }), 'dsh-web-relay/status')
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/dsh-web-relay/ask', handler: askHandler }), 'dsh-web-relay/ask')
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/dsh-web-relay/context', handler: contextHandler }), 'dsh-web-relay/context')
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/dsh-web-relay/parse', handler: parseHandler }), 'dsh-web-relay/parse')
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/dsh-web-relay/execute', handler: executeHandler }), 'dsh-web-relay/execute')
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/dsh-web-relay/trace', handler: traceHandler }), 'dsh-web-relay/trace')
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/dsh-web-relay/traces', handler: tracesHandler }), 'dsh-web-relay/traces')
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/dsh-web-relay/record', handler: recordHandler }), 'dsh-web-relay/record')
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/dsh-web-relay/protocol', handler: protocolHandler }), 'dsh-web-relay/protocol')
}
