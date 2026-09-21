// Replace autoReviewHandler (lines 1462-1625, 1-based) with the v1.5 three-tier version.
const fs = require('fs')
const p = 'D:/DSH/dsh-web-relay/lib/index.js'
const lines = fs.readFileSync(p, 'utf8').split('\n')
let start = -1
for (let i = 0; i < lines.length; i++) { if (lines[i].includes('const autoReviewHandler')) { start = i; break } }
if (start < 0) { console.error('autoReviewHandler not found'); process.exit(1) }
// find handler end: next top-level const xxxHandler
let end = -1
for (let i = start + 1; i < lines.length; i++) {
  if (/^const \w+Handler = async/.test(lines[i].trim()) && !lines[i].includes('autoReview')) { end = i; break }
}
if (end < 0) { console.error('handler end not found'); process.exit(1) }
console.log('replacing lines', start + 1, '..', end, '(indices', start, '..', end - 1, ')')

const NEW = `    const autoReviewHandler = async (req, res) => {
      try {
        if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end()
        const payload = JSON.parse((await readBody(req)) || '{}')
        const exprId = typeof payload.exprId === 'string' ? payload.exprId.trim() : ''
        const stepId = payload.stepId != null ? String(payload.stepId) : ''
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
        if (!TRACE_ID_RE.test(exprId)) return json(res, 400, { ok: false, error: 'invalid exprId' })

        const base = baseOf(payload.workspacePath)
        const safePolicy = safePolicyFor(base)
        const state = await readStepState(base, exprId)
        if (!state.steps || state.steps.length === 0) return json(res, 400, { ok: false, error: 'no steps found' })
        if (state.status === 'stopped') return json(res, 400, { ok: false, error: '任务已停止，不能自动审核' })

        const step = (stepId ? state.steps.find((s) => String(s.id) === String(stepId)) : null)
          || state.steps.find((s) => s.status === 'review')
          || null
        if (!step) return json(res, 404, { ok: false, error: 'no review step found' })
        if (step.status !== 'review') return json(res, 400, { ok: false, error: \`Step \${step.id} 不在 review 状态，不能自动审核\` })

        // v1.5 状态锁：8 秒内同一 Step 拒绝重复审核/唤醒
        if (!lockReview(\`\${exprId}:\${step.id}\`)) {
          return json(res, 200, { ok: true, skipped: true, error: '该步骤正在审核中，请勿重复触发' })
        }

        // 审核上下文：任务记录 + 三方轨迹
        const recordPath = \`\${EXPERIMENTS_DIR}/dsh-web-relay-\${exprId.slice(5)}.md\`
        const recordTarget = await fs.resolve(recordPath, { cwd: base })
        const recordText = await fs.readText(recordTarget).catch(() => '')
        const trace = await loadTrace(base, exprId)
        const traceText = (trace.entries || [])
          .map((e) => \`[\${ROLE_LABEL[e.role] || e.role}] \${e.text}\`)
          .join('\\n')

        // ---- v1.5 三级降级链：外部AI → 对话模型(无工具) → 手动 ----
        let reviewer = 'external'   // external | dialog | manual
        let fallbackReason = ''
        let r = { ok: false }
        let prompt = ''

        if (GEMINI_KEY) {
          prompt = buildReviewPrompt(exprId, step, recordText, traceText, '外部 AI（Gemini）')
          r = await callGemini(prompt)
          if (r.ok) reviewer = 'external'
          else fallbackReason = r.error
        } else {
          fallbackReason = 'GEMINI_API_KEY 未配置'
        }

        if (!r.ok) {
          prompt = buildReviewPrompt(exprId, step, recordText, traceText, '对话模型（无工具）')
          r = await callDialogModel(prompt)
          if (r.ok) reviewer = 'dialog'
          else fallbackReason = fallbackReason || r.error
        }

        let result = ''
        let reason = ''
        if (r.ok) {
          const parsed = parseReview(r.text)
          result = parsed.result
          reason = parsed.reason
          if (result !== 'approved' && result !== 'rejected') {
            fallbackReason = fallbackReason || '审核回复无法识别'
            r = { ok: false }
          }
        }

        if (!r.ok) {
          // 降级到手动：前端展开审核框
          return json(res, 200, {
            ok: true,
            manual: true,
            fallbackReason,
            exprId,
            stepId: String(step.id),
            step: { id: step.id, title: step.title, detail: step.detail, acceptance: step.acceptance },
            traceText: clip(traceText, 3000)
          })
        }

        const reviewerLabel = reviewer === 'external' ? '外部 AI' : reviewer === 'dialog' ? '对话模型（无工具）' : '用户'
        const role = reviewer === 'manual' ? 'user' : 'external'
        let traceTextEntry = ''
        if (result === 'approved') {
          step.status = 'approved'
          traceTextEntry = \`\${reviewerLabel} 自动审核通过 Step \${step.id}：\${step.title}\\n\${reason}\`
        } else {
          step.status = 'rejected'
          traceTextEntry = \`\${reviewerLabel} 自动打回 Step \${step.id}：\${step.title}\\n\${reason}\`
        }

        // v1.5 审核来源
        step.reviewedBy = reviewer
        if (state.steps.every((s) => s.status === 'approved')) state.status = 'done'

        step.notes = step.notes || []
        step.notes.push({ role, at: new Date().toISOString(), action: result, text: reason, reviewedBy: reviewer })
        const updated = await writeStepState(base, exprId, state, safePolicy)
        await appendTrace({ base, safePolicy, exprId, entries: [traceEntry(role, traceTextEntry)] }).catch(() => {})

        // After an approved step, wake the main agent to continue with the next pending step.
        let wake = null
        let nextStep = null
        let handoffText = null
        if (result === 'approved') {
          const idx = updated.steps.findIndex((s) => String(s.id) === String(step.id))
          nextStep = updated.steps.slice(idx + 1).find((s) => s.status === 'pending') || null
          if (nextStep) {
            handoffText = [
              '【主 agent 请协助】dsh-web-relay 自动审核已通过，请继续下一步',
              '',
              \`任务: \${exprId}\`,
              \`已通过 Step: \${step.id} \${step.title}\`,
              \`审核来源: \${reviewerLabel}\`,
              '',
              \`下一步 Step \${nextStep.id}: \${nextStep.title}\`,
              \`详情: \${nextStep.detail || '(无)'}\`,
              \`验收标准: \${nextStep.acceptance || '(无)'}\`,
              '',
              \`请执行 Step \${nextStep.id}，完成后写入三方轨迹并置为 review。\`
            ].join('\\n')
            if (sessionId) {
              wake = await wakeMainAgent({ sessionId, handoffText })
            }
            await appendTrace({ base, safePolicy, exprId, entries: [traceEntry('mainagent', handoffText)] }).catch(() => {})
          } else if (updated.status === 'done') {
            handoffText = [
              '【主 agent 请协助】dsh-web-relay 自动审核已完成全部步骤，请收口',
              '',
              \`任务: \${exprId}\`,
              '全部 Step 已 approved，整体状态 done。',
              '',
              '请完成最终收口：确认 steps.json 与任务记录状态为 done，并将最终结论追加到三方轨迹。'
            ].join('\\n')
            if (sessionId) {
              wake = await wakeMainAgent({ sessionId, handoffText })
            }
            await appendTrace({ base, safePolicy, exprId, entries: [traceEntry('mainagent', handoffText)] }).catch(() => {})
          }
        } else if (result === 'rejected') {
          handoffText = [
            '【主 agent 请协助】dsh-web-relay 自动审核已打回，请修改后重新提交',
            '',
            \`任务: \${exprId}\`,
            \`Step: \${step.id} \${step.title}\`,
            \`审核意见: \${reason}\`,
            '',
            \`请根据审核意见修改 Step \${step.id}，完成后重新置为 review 并提交审核。\`
          ].join('\\n')
          if (sessionId) {
            wake = await wakeMainAgent({ sessionId, handoffText })
          }
          await appendTrace({ base, safePolicy, exprId, entries: [traceEntry('mainagent', handoffText)] }).catch(() => {})
        }

        json(res, 200, {
          ok: true,
          stepState: updated,
          step: updated.steps.find((s) => String(s.id) === String(step.id)),
          reviewedBy: reviewer,
          reviewerLabel,
          nextStep,
          wake,
          handoffText
        })
      } catch (err) {
        json(res, 500, { ok: false, error: String(err?.message || err) })
      }
    }`

const replaced = [...lines.slice(0, start), ...NEW.split('\n'), ...lines.slice(end)]
fs.writeFileSync(p, replaced.join('\n'))
console.log('done. new total lines:', replaced.length)
