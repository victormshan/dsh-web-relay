window.__ModuleLoader__.load({
  id: 'dsh-web-relay',
  factory: (require) => {
    // 规则1：browser bundle 无 Node module/exports，必须自备
    var module = { exports: {} }; var exports = module.exports;

    // 规则2：只用小写闭包绑定 react
    const react = require('react')
    const { useState, useEffect, useRef } = react
    const h = react.createElement

    // ---- 规则4：跨组件状态用 window CustomEvent ----
    const PANEL_EVENT = 'dsh-web-relay:panel-toggle'
    const dispatchToggle = () => {
      window.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: { ts: Date.now() } }))
    }
    const usePanelOpen = () => {
      const [open, setOpen] = useState(false)
      useEffect(() => {
        const on = () => setOpen((v) => !v)
        window.addEventListener(PANEL_EVENT, on)
        return () => window.removeEventListener(PANEL_EVENT, on)
      }, [])
      return [open, setOpen]
    }

    // ---- 真实 state 形状：WorkspaceListState = { items, recentWorkspaceId }；WorkspaceView = { workspaceId, path, ... } ----
    const recentWorkspacePath = (ws) => {
      const items = ws?.items
      if (!Array.isArray(items)) return null
      const target = ws.recentWorkspaceId
      const item = target != null ? items.find((w) => w?.workspaceId === target) : items[0]
      return item?.path ?? null
    }

    // ---- 样式 ----
    const panelStyle = {
      position: 'fixed', top: 60, right: 20, zIndex: 2147483000,
      width: 400, maxHeight: 'calc(100vh - 140px)',
      display: 'flex', flexDirection: 'column',
      background: '#1e1e2e', color: '#e4e4e7',
      border: '1px solid #3f3f46', borderRadius: 8,
      boxShadow: '0 8px 24px rgba(0,0,0,.4)', padding: 12,
      fontFamily: 'system-ui, sans-serif', fontSize: 13, lineHeight: 1.5,
      pointerEvents: 'auto',   // 规则3：shell.overlay 是 click-through 层
      transition: 'opacity .2s ease'
    }
    const panelBodyStyle = { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }
    const panelFootStyle = { flex: '0 0 auto', marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
    const inputStyle = {
      width: '100%', boxSizing: 'border-box', margin: '6px 0',
      background: '#18181b', color: '#e4e4e7', border: '1px solid #3f3f46',
      borderRadius: 6, padding: '6px 8px', fontFamily: 'inherit', fontSize: 13, resize: 'vertical'
    }
    const btnStyle = {
      padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
      background: '#3b82f6', color: '#fff', fontSize: 13
    }
    const btnGhostStyle = { ...btnStyle, background: '#52525b' }
    const btnWarnStyle = { ...btnStyle, background: '#dc2626' }
    const hintStyle = { color: '#a1a1aa', fontSize: 12, margin: '4px 0' }
    const warnStyle = { color: '#fbbf24', fontSize: 12, margin: '4px 0' }
    const savedStyle = { color: '#4ade80', fontSize: 12, wordBreak: 'break-all', marginTop: 6 }
    const preStyle = {
      background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6,
      padding: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflow: 'auto'
    }
    const riskColor = (risk) =>
      risk === 'low' ? '#4ade80' : risk === 'medium' ? '#fbbf24' : '#f87171'
    const riskLabel = (risk) =>
      risk === 'low' ? '低风险' : risk === 'medium' ? '中风险' : '高风险'
    const typeLabel = (t) =>
      t === 'write_file' ? '写入文件' : t === 'run_cmd' ? '执行命令' : t === 'plan' ? '计划任务' : t === 'wake_agent' ? '唤醒主 Agent' : '无效指令'

    // ---- v0.5: web-relay three-party roles (用户 / 主 agent / 外部AI) ----
    const ROLE_LABEL = { user: '用户', mainagent: '主 agent', external: '外部AI' }
    const ROLE_COLOR = { user: '#3b82f6', mainagent: '#f59e0b', external: '#a855f7' }
    const tabBtnStyle = {
      flex: 1, padding: '5px 0', borderRadius: 6, border: '1px solid #3f3f46',
      background: 'transparent', color: '#a1a1aa', cursor: 'pointer', fontSize: 12
    }
    const tabActiveStyle = { ...tabBtnStyle, background: '#3b82f6', color: '#fff', borderColor: '#3b82f6' }

    // ---- footer 按钮 ----
    const FooterButton = (props) => {
      const [open] = usePanelOpen()
      return h('button', {
        onClick: dispatchToggle,
        title: 'dsh-web-relay: 免费试验台（Gemini / 手动粘贴 / 指令执行）',
        'aria-label': 'dsh-web-relay free experiment relay',
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, borderRadius: 6, border: 'none',
          background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 14
        }
      }, open ? '✕' : '⇄')
    }

    // ---- overlay 面板 ----
    const RelayPanel = (props) => {
      const [open] = usePanelOpen()
      const [provider, setProvider] = useState('manual')
      const [prompt, setPrompt] = useState('')
      const [pasted, setPasted] = useState('')
      const [sending, setSending] = useState(false)
      const [answer, setAnswer] = useState('')
      const [savedPath, setSavedPath] = useState('')
      const [error, setError] = useState('')
      const [config, setConfig] = useState(null)
      const [contextRecords, setContextRecords] = useState(null)
      const [contextText, setContextText] = useState('')
      const [contextCopied, setContextCopied] = useState(false)
      const [showContextPreview, setShowContextPreview] = useState(false)
      // v0.3: instruction preview state
      const [actions, setActions] = useState(null)       // parsed actions or null (not parsed yet)
      const [checks, setChecks] = useState({})           // { index: boolean }
      const [expanded, setExpanded] = useState({})       // { index: boolean }
      const [needsAgent, setNeedsAgent] = useState(null) // { reason, agentWoken, wakeReason, handoffText }
      const [execResults, setExecResults] = useState(null)
      const [phase, setPhase] = useState('input')        // input | parsing | preview | working | done
      const [hover, setHover] = useState(false)          // v0.4.1: hover transparency (0.92 -> 1)
      // v0.5: drag + collapse (Step 2/3)
      const [pos, setPos] = useState({ top: null, left: null }) // null = use CSS top/right defaults
      const [collapsed, setCollapsed] = useState(false)
      const dragRef = useRef(null) // { startX, startY, origTop, origLeft, moved }
      // v0.5 (record-domain independence): tab = experiment form | three-party trace page
      const [tab, setTab] = useState('main') // 'main' | 'trace'
      const [traces, setTraces] = useState(null)
      const [traceError, setTraceError] = useState('')
      const [traceLoading, setTraceLoading] = useState(false)
      const [expandedTrace, setExpandedTrace] = useState({}) // id -> bool
      const [traceRecord, setTraceRecord] = useState({})     // id -> record text
      // v0.5.1 Step 2: protocol auto-mount — fetched on panel open (covers new
      // sessions), shown as a quiet version line + collapsible full text.
      const [protocol, setProtocol] = useState(null)
      const [showProtocol, setShowProtocol] = useState(false)
      // v0.5.2 Step 2: rule-8 payload guardrail state
      const [showGuard, setShowGuard] = useState(false)

      const workspacePath = props.useWorkspaces ? props.useWorkspaces(recentWorkspacePath) : null
      // sessionId: the RAW value of useSessions((st) => st.current) — a SessionId string, not an object.
      let sessionId = ''
      try {
        sessionId = props && props.useSessions
          ? props.useSessions((st) => st.current) || ''
          : ''
      } catch (err) { sessionId = '' }

      // Step 2: auto-mount the three-party protocol every time the panel opens,
      // so a new session/workspace never degrades to a plain chat AI.
      useEffect(() => {
        if (!open) return
        let cancelled = false
        fetch('/dsh-web-relay/protocol')
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { if (!cancelled && d && d.ok) setProtocol({ version: d.version, text: d.text }) })
          .catch(() => { /* fallback: packContext re-fetches */ })
        return () => { cancelled = true }
      }, [open])

      useEffect(() => {
        fetch('/dsh-web-relay/status')
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => setConfig(d))
          .catch(() => setConfig({ ok: false, geminiConfigured: false }))
      }, [])

      // reset preview when the pasted text changes
      useEffect(() => {
        setActions(null); setChecks({}); setNeedsAgent(null); setExecResults(null)
        setPhase('input')
      }, [pasted, provider])

      // ---- v0.5.2 Step 2: rule-8 payload guardrail ----
      // Detect "a solution without a json:agent-action payload" and offer
      // one-click wrapping. Never pops for pure questions or texts that
      // already carry a payload. Purely a format aid — ignorable.
      const SOLUTION_WORDS = ['实现', '方案', '步骤', '修改', '需要执行', '落地', '改造', '升级', '新增']
      const guardHint = '这是格式辅助提示，可忽略，不影响保存。'
      useEffect(() => {
        if (provider !== 'manual' || !pasted.trim()) { setShowGuard(false); return }
        const hasPayload = /```json:agent-action|"action"\s*:\s*"wake_agent"/.test(pasted)
        const hasSolution = SOLUTION_WORDS.some((w) => pasted.includes(w))
        setShowGuard(!hasPayload && hasSolution)
      }, [pasted, provider])

      // One-click wrap: append a wake_agent payload (format only, no write_file
      // auto-actions). context is a pointer, not the full carrier — the full
      // text lives in the record; the reason tells the main agent what/where.
      const wrapPayload = () => {
        const body = pasted.trim()
        const contextText = body.slice(0, 1500)
        const wrapped = body + '\n\n```json:agent-action\n' +
          JSON.stringify([{
            action: 'wake_agent',
            reason: '复杂任务，请主 agent 按规则 8 接管（含方案但缺 Payload，已由护栏补全格式）',
            targetWorkspace: workspacePath || '',
            context: contextText
          }], null, 2) + '\n```'
        setPasted(wrapped)
        setShowGuard(false)
      }

      const packContext = async () => {
        setContextCopied(false); setContextText(''); setContextRecords(null)
        try {
          const resp = await fetch('/dsh-web-relay/context?cwd=' + encodeURIComponent(workspacePath || ''))
          const data = await resp.json().catch(() => ({ ok: false, error: 'bad response' }))
          if (!data.ok) { setError(data.error || 'context fetch failed'); return }
          setContextRecords(data.records || [])
          // Step 1 hardening: /context now returns protocol as a top-level field
          // (never mixed into records/traces); use it directly, fall back to the
          // protocol state fetched at panel open, then to a local default.
          let protocolText = ''
          if (data.protocol && data.protocol.text) {
            protocolText = data.protocol.text
          } else if (protocol && protocol.text) {
            protocolText = protocol.text
          }
          if (!protocolText) {
            protocolText = '三方主体（web-relay 语境）：用户 (the human) / 主 agent (the tool-using agent in the main harness session，负责执行与收口) / 外部AI (external web AI — Gemini/DeepSeek 网页版或 free API，负责提供方案与回答)。试验记录在 web-relay/experiments/，三方轨迹在 web-relay/traces/。（/dsh-web-relay/protocol 不可用时的兜底文本）'
          }
          const lines = [
            '【三方协作机制（web-relay 语境，每次回答都必须遵循）】',
            ...protocolText.split('\n'),
            '',
            '【外部 AI Skill：web_relay_external_ai_protocol（本协议的细化执行规范，必须遵循）】',
            ...(data.skill && data.skill.text ? data.skill.text.split('\n') : []),
            '',
            '【项目上下文】',
            'workspace: ' + (workspacePath || '(未知)'),
            '最近试验:'
          ]
          for (const r of (data.records || [])) {
            lines.push('  - ' + r.id + ' [' + r.intent + '/' + r.status + '] ' + r.snippet)
          }
          if (data.traces && data.traces.length > 0) {
            lines.push('', '【三方轨迹（最近 ' + data.traces.length + ' 条，web-relay 语境）】')
            for (const t of data.traces) {
              lines.push('### ' + t.id)
              for (const e of (t.entries || [])) {
                lines.push((ROLE_LABEL[e.role] || e.role) + ': ' + String(e.text || '').replace(/\s+/g, ' ').slice(0, 300))
              }
            }
          }
          lines.push('', '【我要提问】', prompt || '(未填写，可留空后自行补充)')
          const text = lines.join('\n')
          setContextText(text)
          try {
            await navigator.clipboard.writeText(text)
            setContextCopied(true)
          } catch (e) {
            setContextCopied(false)
          }
          setShowContextPreview(true)
        } catch (e) { setError(String(e?.message || e)) }
      }

      // ---- v0.5: three-party trace page ----
      const loadTraces = async () => {
        setTraceLoading(true); setTraceError('')
        try {
          const resp = await fetch('/dsh-web-relay/traces?cwd=' + encodeURIComponent(workspacePath || ''))
          const data = await resp.json().catch(() => ({ ok: false, error: 'bad response' }))
          if (!data.ok) { setTraceError(data.error || 'traces fetch failed'); return }
          setTraces(data.traces || [])
        } catch (e) { setTraceError(String(e?.message || e)) }
        finally { setTraceLoading(false) }
      }

      const expandRecord = async (id) => {
        const next = { ...expandedTrace, [id]: !expandedTrace[id] }
        setExpandedTrace(next)
        if (next[id] && !traceRecord[id]) {
          try {
            const resp = await fetch('/dsh-web-relay/record?cwd=' + encodeURIComponent(workspacePath || '') + '&id=' + encodeURIComponent(id))
            const data = await resp.json().catch(() => null)
            if (data && data.ok && data.record) setTraceRecord((r) => ({ ...r, [id]: data.record.text }))
            else setTraceError('试验记录读取失败')
          } catch (e) { setTraceError(String(e?.message || e)) }
        }
      }

      // load the trace page on first visit
      useEffect(() => {
        if (tab === 'trace' && traces === null) loadTraces()
      }, [tab])

      // manual: submit → parse → preview (or plain save when no instructions)
      const submitManual = async () => {
        if (!pasted.trim()) { setError('manual 模式需要粘贴回答'); return }
        setError(''); setSending(true); setPhase('parsing'); setAnswer(''); setSavedPath('')
        try {
          const resp = await fetch('/dsh-web-relay/parse', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: pasted, workspacePath })
          })
          const data = await resp.json().catch(() => ({ ok: false, error: 'bad response' }))
          if (!data.ok) { setError(data.error || 'parse failed'); setPhase('input'); return }
          const acts = data.actions || []
          setNeedsAgent(data.needsAgent || null)
          if (acts.length === 0) {
            // no instructions → plain save (status pending)
            await plainSave()
            return
          }
          setActions(acts)
          const chk = {}
          for (const a of acts) chk[a.index] = !!a.checked
          setChecks(chk)
          setPhase('preview')
        } catch (e) { setError(String(e?.message || e)); setPhase('input') }
        finally { setSending(false) }
      }

      // plain save without executing anything (no instructions found)
      const plainSave = async () => {
        try {
          const resp = await fetch('/dsh-web-relay/ask', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: 'manual', prompt, answer: pasted, workspacePath })
          })
          const data = await resp.json().catch(() => ({ ok: false, error: 'bad response' }))
          if (!data.ok) { setError(data.error || 'request failed'); return }
          setAnswer(data.answer || '')
          setSavedPath(data.savedPath || '')
          setPhase('done')
        } catch (e) { setError(String(e?.message || e)) }
        finally { setSending(false) }
      }

      // execute: save-only (indices=[]) or execute selected indices
      const execute = async (indices) => {
        setSending(true); setError(''); setExecResults(null); setNeedsAgent(null); setPhase('working')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 75000) // > run_cmd cap (60s)
        try {
          const resp = await fetch('/dsh-web-relay/execute', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text: pasted,
              indices,
              workspacePath,
              prompt,
              sessionId
            }),
            signal: controller.signal
          })
          const data = await resp.json().catch(() => ({ ok: false, error: 'bad response' }))
          if (!data.ok) { setError(data.error || 'execute failed'); setPhase('preview'); return }
          setExecResults(data.results || [])
          setSavedPath(data.recordPath || '')
          if (data.needsAgent) setNeedsAgent(data.needsAgent)
          setPhase('done')
        } catch (e) {
          setError('执行超时或失败: ' + String(e?.message || e))
          setPhase('preview')
        } finally {
          clearTimeout(timer)
          setSending(false)
        }
      }

      // gemini-free: plain question (no instruction flow in this version)
      const submitGemini = async () => {
        if (!prompt.trim()) { setError('请填写提问内容'); return }
        setError(''); setSending(true); setAnswer(''); setSavedPath(''); setPhase('working')
        try {
          const resp = await fetch('/dsh-web-relay/ask', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: 'gemini-free', prompt, answer: '', workspacePath })
          })
          const data = await resp.json().catch(() => ({ ok: false, error: 'bad response' }))
          if (!data.ok) { setError(data.error || 'request failed'); return }
          setAnswer(data.answer || '')
          setSavedPath(data.savedPath || '')
          setPhase('done')
        } catch (e) { setError(String(e?.message || e)) }
        finally { setSending(false) }
      }

      const copyHandoff = async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          setError('')
        } catch (e) {
          setError('剪贴板不可用，请手动复制下方文本')
        }
      }

      // ---- v0.5 Step 2: header drag ----
      // mousedown on header starts a potential drag; real drag only begins after
      // 3px movement (so clicks on header buttons still work). mousemove/mouseup
      // are window-scoped and removed on mouseup.
      useEffect(() => {
        const onMove = (e) => {
          const d = dragRef.current
          if (!d) return
          if (!d.moved) {
            const dx = e.clientX - d.startX
            const dy = e.clientY - d.startY
            if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return
            d.moved = true
          }
          const curTop = d.origTop
          const curLeft = d.origLeft
          const nextTop = Math.max(8, curTop + (e.clientY - d.startY))
          const nextLeft = Math.max(8, curLeft + (e.clientX - d.startX))
          setPos({ top: nextTop, left: nextLeft })
          d.origTop = nextTop
          d.origLeft = nextLeft
          d.startX = e.clientX
          d.startY = e.clientY
        }
        const onUp = () => { dragRef.current = null }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        return () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
      }, [])

      const onHeaderMouseDown = (e) => {
        if (e.button !== 0) return // left button only
        // current position: explicit pos if dragged before, else defaults
        const baseTop = 60
        const baseLeft = window.innerWidth - 20 - 400 // right:20 + width:400
        const origTop = pos.top != null ? pos.top : baseTop
        const origLeft = pos.left != null ? pos.left : baseLeft
        dragRef.current = {
          startX: e.clientX, startY: e.clientY,
          origTop, origLeft, moved: false
        }
      }

      const stop = (e) => e.stopPropagation()

      if (!open) return null

      const onEnterSubmit = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          if (provider === 'gemini-free') submitGemini()
          else if (phase === 'input') submitManual()
        }
      }

      const checkedIndices = actions
        ? actions.filter((a) => checks[a.index]).map((a) => a.index)
        : []

      // footer actions depend on phase
      let footer = null
      if (provider === 'gemini-free') {
        footer = h('button', { onClick: submitGemini, disabled: sending, style: { ...btnStyle, opacity: sending ? 0.6 : 1 } },
          sending ? '提问中…' : '提问')
      } else if (phase === 'input' || phase === 'parsing') {
        footer = h('button', { onClick: submitManual, disabled: sending || phase === 'parsing', style: { ...btnStyle, opacity: (sending || phase === 'parsing') ? 0.6 : 1 } },
          (phase === 'parsing') ? '解析中…' : '解析并预览')
      } else if (phase === 'preview') {
        footer = h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', width: '100%' } },
          h('button', { onClick: () => execute([]), disabled: sending, style: { ...btnGhostStyle, opacity: sending ? 0.6 : 1 } },
            sending ? '保存中…' : '仅保存记录'),
          h('button', {
            onClick: () => execute(checkedIndices),
            disabled: sending || checkedIndices.length === 0,
            style: { ...btnStyle, opacity: (sending || checkedIndices.length === 0) ? 0.6 : 1 }
          }, sending ? '执行中…' : `执行所选 (${checkedIndices.length})`)
        )
      } else if (phase === 'working') {
        footer = h('button', { disabled: true, style: { ...btnStyle, opacity: 0.6 } }, '处理中…')
      } else if (phase === 'done') {
        footer = h('button', {
          onClick: () => { setActions(null); setChecks({}); setNeedsAgent(null); setExecResults(null); setPhase('input'); setSavedPath('') },
          style: btnGhostStyle
        }, '新的一次')
      }

      return h('div', {
        style: {
          ...panelStyle,
          opacity: hover ? 1 : 0.92,
          // v0.5 Step 2: explicit position once dragged (defaults keep CSS top/right)
          ...(pos.top != null ? { top: pos.top, right: undefined } : {}),
          ...(pos.left != null ? { left: pos.left } : {}),
          // v0.5 Step 3: collapse body only
          ...(collapsed ? { maxHeight: 56, overflow: 'hidden' } : {})
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false)
      },
        // v0.5 Step 2: header is the drag handle; buttons stopPropagation
        h('div', {
          onMouseDown: onHeaderMouseDown,
          style: {
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: collapsed ? 0 : 8, cursor: 'grab', userSelect: 'none'
          },
          title: '拖动移动面板'
        },
          h('strong', null, 'dsh-web-relay · 免费试验台'),
          h('div', { style: { display: 'flex', gap: 4 } },
            h('button', {
              onClick: (e) => { stop(e); setCollapsed(!collapsed) },
              'aria-label': collapsed ? '展开' : '最小化',
              title: collapsed ? '展开' : '最小化',
              style: { background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 14 }
            }, collapsed ? '▣' : '—'),
            h('button', { onClick: (e) => { stop(e); dispatchToggle() }, 'aria-label': 'close', style: { background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' } }, '✕')
          )
        ),
        // v0.5: tab bar (experiment form | three-party trace page)
        !collapsed &&
        h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
          h('button', { onClick: () => setTab('main'), style: tab === 'main' ? tabActiveStyle : tabBtnStyle }, '试验'),
          h('button', { onClick: () => setTab('trace'), style: tab === 'trace' ? tabActiveStyle : tabBtnStyle }, '轨迹')
        ),
        !collapsed && tab === 'main' &&
        h('div', { style: panelBodyStyle },
          config && !config.geminiConfigured
            ? h('div', { style: warnStyle }, '⚠ 未检测到 GEMINI_API_KEY，gemini-free 不可用；可用 manual 粘贴模式。')
            : (config && h('div', { style: hintStyle }, `v${config.version || '?'} · ${config.geminiConfigured ? 'Gemini 已就绪 · model: ' + config.model : 'Gemini 未配置'} · shell: ${config.shellAvailable ? '✓' : '✗'} · apiProxy: ${config.apiProxyAvailable ? '✓' : '✗'}`)),
          // Step 2: quiet protocol version line + collapsible full text (locks
          // the external-AI role on every session, without stealing the UI).
          protocol && h('div', { style: { margin: '2px 0' } },
            h('button', {
              onClick: () => setShowProtocol(!showProtocol),
              style: { background: 'none', border: 'none', color: '#a1a1aa', cursor: 'pointer', fontSize: 12, padding: 0, fontFamily: 'inherit' }
            }, showProtocol ? '▼ 三方协议 ' + (protocol.version || '') : '▶ 三方协议 ' + (protocol.version || '')),
            showProtocol && h('div', { style: { ...preStyle, marginTop: 4, maxHeight: 160, fontSize: 12 } }, protocol.text)
          ),
          h('select', {
            value: provider,
            onChange: (e) => setProvider(e.target.value),
            style: { ...inputStyle, width: 'auto' }
          },
            h('option', { value: 'manual' }, '手动粘贴（DeepSeek/Gemini 网页）'),
            h('option', { value: 'gemini-free' }, 'Gemini Free API（官方免费）')
          ),
          provider === 'manual'
            ? h('div', { style: hintStyle }, '粘贴网页 AI 的回答；含 ```json:agent-action 指令块时会先解析预览，逐条确认后才执行。')
            : h('div', { style: hintStyle }, '试验 prompt 会作为问题发给 Gemini：'),
          h('textarea', {
            value: prompt,
            onChange: (e) => setPrompt(e.target.value),
            onKeyDown: onEnterSubmit,
            placeholder: '试验 prompt / 问题……（Enter 提交，Shift+Enter 换行）',
            rows: 2, style: inputStyle
          }),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0' } },
            h('button', { onClick: packContext, style: { ...btnStyle, background: '#6d28d9' } }, '📦 打包上下文'),
            contextCopied && h('span', { style: { ...savedStyle, marginTop: 0 } }, '已复制，去网页 Ctrl+V'),
            !contextCopied && contextText && h('span', { style: hintStyle }, '剪贴板不可用，请手动复制预览区')
          ),
          contextText && h('div', { style: { margin: '4px 0' } },
            h('button', {
              onClick: () => setShowContextPreview(!showContextPreview),
              style: { background: 'none', border: 'none', color: '#93c5fd', cursor: 'pointer', fontSize: 12, padding: 0 }
            }, showContextPreview ? '收起预览 ▲' : '展开预览 ▼'),
            showContextPreview && h('div', { style: preStyle }, contextText)
          ),
          provider === 'manual' &&
            h('textarea', {
              value: pasted,
              onChange: (e) => setPasted(e.target.value),
              onKeyDown: onEnterSubmit,
              placeholder: '从网页版粘贴回答……（Enter 解析，Shift+Enter 换行）',
              rows: 6, style: inputStyle
            }),
          // v0.5.2 Step 2: rule-8 payload guardrail card
          showGuard && h('div', { style: { margin: '4px 0', border: '1px solid #f59e0b', borderRadius: 6, padding: 8, background: 'rgba(245,158,11,.08)' } },
            h('div', { style: { color: '#fbbf24', fontSize: 12, fontWeight: 600 } }, '⚠ 检测到方案但缺少规则 8 Payload'),
            h('div', { style: { ...hintStyle, marginTop: 2 } }, '复杂任务需包含 json:agent-action 代码块（wake_agent + Step List）才能让主 agent 接管。'),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' } },
              h('button', { onClick: wrapPayload, style: { ...btnStyle, padding: '4px 10px', fontSize: 12 } }, '一键封装规则 8 Payload'),
              h('span', { style: hintStyle }, guardHint)
            )
          ),

          // v0.3: instruction cards
          actions && actions.length > 0 && h('div', { style: { marginTop: 8 } },
            h('div', { style: { ...hintStyle, fontWeight: 600, color: '#93c5fd' } }, '检测到可执行指令，逐条确认：'),
            actions.map((a) => h('div', {
              key: a.index,
              style: {
                display: 'flex', alignItems: 'flex-start', gap: 8,
                background: '#18181b', border: '1px solid #3f3f46',
                borderRadius: 6, padding: '6px 8px', marginTop: 6
              }
            },
              h('input', {
                type: 'checkbox',
                checked: !!checks[a.index],
                disabled: a.type === 'invalid' || a.type === 'plan' || sending,
                onChange: (e) => setChecks((c) => ({ ...c, [a.index]: e.target.checked })),
                style: { marginTop: 3 }
              }),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: 12, color: '#a1a1aa' } }, `#${a.index} ${typeLabel(a.type)}`),
                  h('span', { style: { fontSize: 11, color: riskColor(a.risk), border: '1px solid ' + riskColor(a.risk), borderRadius: 4, padding: '0 4px' } }, riskLabel(a.risk)),
                  a.type === 'run_cmd' && h('span', { style: { fontSize: 11, color: '#f87171' } }, '高风险·确认后再勾')
                ),
                h('div', { style: { marginTop: 2, wordBreak: 'break-word' } }, a.summary),
                h('button', {
                  onClick: () => setExpanded((x) => ({ ...x, [a.index]: !x[a.index] })),
                  style: { background: 'none', border: 'none', color: '#93c5fd', cursor: 'pointer', fontSize: 12, padding: 0, marginTop: 2 }
                }, expanded[a.index] ? '收起 ▲' : '详情 ▼'),
                expanded[a.index] && h('div', { style: { ...preStyle, marginTop: 4, fontSize: 12 } }, a.detail)
              )
            ))
          ),

          // needsAgent card
          needsAgent && h('div', { style: { marginTop: 8, border: '1px solid #f59e0b', borderRadius: 6, padding: 8, background: 'rgba(245,158,11,.08)' } },
            h('div', { style: { color: '#fbbf24', fontWeight: 600 } }, '⚠ 该指令需主 agent 接管'),
            h('div', { style: { ...hintStyle, marginTop: 4 } }, needsAgent.reason || ''),
            needsAgent.agentWoken
              ? h('div', { style: { ...savedStyle, marginTop: 6 } }, '✅ 已唤醒主 agent（注入成功），请到主会话查看。')
              : h('div', { style: { marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { style: hintStyle }, needsAgent.wakeReason
                    ? `注入不可达（${needsAgent.wakeReason}），请复制 handoff：`
                    : '请复制 handoff 文本交给主 agent：'),
                  needsAgent.handoffText && h('button', {
                    onClick: () => copyHandoff(needsAgent.handoffText),
                    style: { ...btnWarnStyle, padding: '4px 10px', fontSize: 12 }
                  }, '复制 handoff 文本')
                ),
            needsAgent.handoffText && h('div', { style: { ...preStyle, marginTop: 6, maxHeight: 160 } }, needsAgent.handoffText)
          ),

          // execution results
          execResults && execResults.length > 0 && h('div', { style: { marginTop: 8 } },
            h('div', { style: { ...hintStyle, fontWeight: 600, color: '#93c5fd' } }, '执行结果：'),
            execResults.map((r) => h('div', {
              key: r.index,
              style: { background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, padding: 6, marginTop: 6 }
            },
              h('div', { style: { color: r.ok ? '#4ade80' : '#f87171', fontWeight: 600 } },
                `${r.ok ? '✓' : '✗'} #${r.index} ${typeLabel(r.type)} · ${r.summary}`),
              h('div', { style: { ...preStyle, marginTop: 4, fontSize: 12 } }, r.detail)
            ))
          ),

          error && h('div', { style: { ...warnStyle, whiteSpace: 'pre-wrap' } }, error),
          answer && h('div', { style: { marginTop: 8 } },
            h('div', { style: hintStyle }, '回答：'),
            h('div', { style: preStyle }, answer)
          ),
          savedPath && h('div', { style: savedStyle }, `记录：${savedPath}`)
        ),
        // v0.5: three-party trace page (用户 / 主 agent / 外部AI)
        !collapsed && tab === 'trace' &&
        h('div', { style: panelBodyStyle },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
            h('span', { style: { ...hintStyle, margin: 0, fontWeight: 600, color: '#93c5fd' } }, '三方轨迹（用户 / 主 agent / 外部AI）'),
            h('span', { style: hintStyle }, traces ? `${traces.length} 条` : ''),
            h('button', {
              onClick: loadTraces,
              disabled: traceLoading,
              style: { ...btnGhostStyle, padding: '3px 10px', fontSize: 12, marginLeft: 'auto', opacity: traceLoading ? 0.6 : 1 }
            }, traceLoading ? '刷新中…' : '刷新')
          ),
          traceError && h('div', { style: warnStyle }, traceError),
          traces === null
            ? h('div', { style: hintStyle }, '加载中…')
            : traces.length === 0
              ? h('div', { style: hintStyle }, '暂无轨迹。执行一次试验（含唤醒/收口）后，这里会显示三方对话流水（web-relay/traces/）。')
              : traces.map((t) => h('div', { key: t.id, style: { background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, padding: 8, marginBottom: 8 } },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
                    h('span', { style: { color: '#93c5fd', fontWeight: 600, fontSize: 12, wordBreak: 'break-all' } }, t.id),
                    h('button', {
                      onClick: () => expandRecord(t.id),
                      style: { background: 'none', border: 'none', color: '#93c5fd', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }
                    }, expandedTrace[t.id] ? '收起试验记录 ▲' : '查看试验记录 ▼')
                  ),
                  (t.entries || []).map((e, i) => h('div', { key: i, style: { marginTop: 6, borderLeft: '2px solid ' + (ROLE_COLOR[e.role] || '#52525b'), paddingLeft: 8 } },
                    h('div', { style: { fontSize: 11, color: ROLE_COLOR[e.role] || '#a1a1aa' } },
                      (ROLE_LABEL[e.role] || e.role) + ' · ' + String(e.at || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z')),
                    h('div', { style: { ...preStyle, marginTop: 2, maxHeight: 140, fontSize: 12 } }, e.text || '(空)')
                  )),
                  expandedTrace[t.id] && traceRecord[t.id] && h('div', { style: { ...preStyle, marginTop: 6, maxHeight: 220, fontSize: 12 } }, traceRecord[t.id])
                ))
        ),
        !collapsed &&
        h('div', { style: panelFootStyle },
          tab === 'trace'
            ? h('button', { onClick: loadTraces, disabled: traceLoading, style: { ...btnGhostStyle, opacity: traceLoading ? 0.6 : 1 } }, traceLoading ? '刷新中…' : '刷新轨迹')
            : footer,
          h('span', { style: hintStyle }, 'Enter 提交 · Shift+Enter 换行')
        )
      )
    }

    const apply = (ctx) => {
      const slots = ctx.get('slots')
      slots.inject('sidebar.footer.action', () =>
        slots.register({ name: 'sidebar.footer.action', id: 'dsh-web-relay', order: 120 }, FooterButton)
      )
      slots.inject('shell.overlay', () =>
        slots.register({ name: 'shell.overlay', id: 'dsh-web-relay-panel', order: 120 }, RelayPanel)
      )
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  }
})
