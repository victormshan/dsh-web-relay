// Apply ghost-button standardization rules (one-shot replace, no loops).
const fs = require('fs')
const p = 'D:/DSH/dsh-web-relay/lib/client.js'
let t = fs.readFileSync(p, 'utf8')
const rules = [
  ["onClick: () => execute([]), disabled: sending, style: { ...btnGhostStyle",
   "onClick: () => execute([]), disabled: sending, className: 'dwr-ghost', style: { ...btnGhostStyle"],
  ["style: { ...btnGhostStyle, opacity: sending ? 0.6 : 1 }",
   "className: 'dwr-ghost', style: { ...btnGhostStyle, opacity: sending ? 0.6 : 1 }"],
  ["onClick: () => loadStepState(stepLoadId), disabled: stepBusy, style: { ...btnGhostStyle, padding: '4px 10px', fontSize: 12 } }, '载入'",
   "onClick: () => loadStepState(stepLoadId), disabled: stepBusy, className: 'dwr-ghost', style: { ...btnGhostStyle, padding: '4px 10px', fontSize: 12 } }, '载入'"],
  ["onClick: () => refreshStepState(), disabled: stepBusy || !exprId, style: { ...btnGhostStyle, padding: '4px 10px', fontSize: 12 }",
   "onClick: () => refreshStepState(), disabled: stepBusy || !exprId, className: 'dwr-ghost', style: { ...btnGhostStyle, padding: '4px 10px', fontSize: 12 }"],
  ["onClick: toggleAutoReview, disabled: stepBusy, style: { ...btnGhostStyle, padding: '2px 8px', fontSize: 11, marginLeft: 6 }",
   "onClick: toggleAutoReview, disabled: stepBusy, className: 'dwr-ghost', style: { ...btnGhostStyle, padding: '2px 8px', fontSize: 11, marginLeft: 6 }"],
  ["onClick: () => setExperimentPhase('executing'), disabled: stepBusy, style: { ...btnGhostStyle, padding: '2px 8px', fontSize: 11",
   "onClick: () => setExperimentPhase('executing'), disabled: stepBusy, className: 'dwr-ghost', style: { ...btnGhostStyle, padding: '2px 8px', fontSize: 11"],
  ["onClick: () => setTraceOrder(traceOrder === 'asc' ? 'desc' : 'asc'),",
   "onClick: () => setTraceOrder(traceOrder === 'asc' ? 'desc' : 'asc'),"],
  ["style: { ...btnGhostStyle, padding: '3px 10px', fontSize: 12 } }",
   "className: 'dwr-ghost', style: { ...btnGhostStyle, padding: '3px 10px', fontSize: 12 } }"],
  ["style: { ...btnGhostStyle, padding: '3px 10px', fontSize: 12, marginLeft: 'auto', opacity: traceLoading ? 0.6 : 1 }",
   "className: 'dwr-ghost', style: { ...btnGhostStyle, padding: '3px 10px', fontSize: 12, marginLeft: 'auto', opacity: traceLoading ? 0.6 : 1 }"],
  ["onClick: loadTraces, disabled: traceLoading, style: { ...btnGhostStyle, opacity: traceLoading ? 0.6 : 1 }",
   "onClick: loadTraces, disabled: traceLoading, className: 'dwr-ghost', style: { ...btnGhostStyle, opacity: traceLoading ? 0.6 : 1 }"],
  ["style: { ...btnWarnStyle, opacity: sending ? 0.6 : 1 }",
   "className: 'dwr-ghost', style: { ...ghostRed, opacity: sending ? 0.6 : 1 }"],
  ["onClick: packContext, style: { ...btnStyle, background: '#6d28d9' }",
   "onClick: packContext, style: btnStyle"],
  ["style: architectMode ? { ...btnStyle, background: '#7c3aed' } : btnGhostStyle",
   "className: 'dwr-ghost', style: architectMode ? ghostPurple : btnGhostStyle"],
  ["style: { ...btnWarnStyle, padding: '4px 10px', fontSize: 12 }",
   "className: 'dwr-ghost', style: { ...ghostRed, padding: '4px 10px', fontSize: 12 }"],
]
let total = 0
for (const [oldStr, newStr] of rules) {
  const n = t.split(oldStr).length - 1
  if (n > 0) { t = t.split(oldStr).join(newStr); total += n }
  else console.log('NOT FOUND: ' + oldStr.slice(0, 70))
}
fs.writeFileSync(p, t)
console.log('applied: ' + total)
