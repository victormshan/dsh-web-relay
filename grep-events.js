// Find all events whose text mentions a keyword, printing compact context.
// Usage: node grep-events.js <decoded.jsonl> <keyword-regex> [maxHits]
const fs = require('fs')
const file = process.argv[2]
const re = new RegExp(process.argv[3])
const maxHits = Number(process.argv[4] ?? 60)
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
let hits = 0
for (const line of lines) {
  if (!line.trim()) continue
  if (!re.test(line)) continue
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  const t = ev.type
  const d = ev.data ?? {}
  let text = ''
  if (d.content && Array.isArray(d.content)) {
    text = d.content.map((b) => b.text ?? (b.content ? JSON.stringify(b.content).slice(0, 400) : '')).join('\n')
  } else if (t === 'tool/call' && typeof d.arguments === 'string') {
    text = `CALL ${d.name ?? ''} ${d.arguments}`
  } else if (t === 'tool/result' && d.message?.content) {
    text = 'RESULT ' + JSON.stringify(d.message.content).slice(0, 600)
  } else if (t === 'assistant/chunk' && d.chunk?.block) {
    const b = d.chunk.block
    text = `${b.type}: ${(b.text ?? '').slice(0, 600)}`
  } else if (d.text) {
    text = String(d.text).slice(0, 600)
  }
  if (!text) continue
  const needle = text.match(re)?.[0]
  const idx = text.indexOf(needle)
  const snippet = text.slice(Math.max(0, idx - 120), idx + 240).replace(/\s+/g, ' ')
  console.log(`[${t} ${d.turn ?? ''}/${d.step ?? ''} seq=${ev.seq}] ${snippet}`)
  if (++hits >= maxHits) break
}
console.log(`--- hits shown: ${hits}`)
