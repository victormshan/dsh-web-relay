// Extract all write/edit tool calls targeting dsh-web-relay files from a decoded session log.
// Usage: node extract-relay-writes.js <decoded.jsonl> [maxLines]
const fs = require('fs')

const file = process.argv[2]
const maxLines = Number(process.argv[3] ?? 0)
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
let count = 0
for (const line of lines) {
  if (!line.trim()) continue
  if (maxLines && count >= maxLines) break
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  if (ev.type !== 'tool/call') continue
  const args = ev.data?.arguments
  if (typeof args !== 'string') continue
  if (!/dsh-web-relay/.test(args)) continue
  let a
  try { a = JSON.parse(args) } catch { continue }
  const path = a.path ?? ''
  if (!/dsh-web-relay/.test(path)) continue
  const cmd = a.command ?? ''
  const brief = {
    seq: ev.seq,
    turn: ev.data?.turn,
    step: ev.data?.step,
    name: ev.data?.name,
    file: path.includes('index.js') ? 'index.js' : path.includes('client.js') ? 'client.js' : 'other',
    cmd
  }
  // include short arg preview for edit/str_replace
  let preview = ''
  if (cmd === 'str_replace' || cmd === 'edit') {
    preview = (a.old_string ?? '').slice(0, 80).replace(/\n/g, '\\n')
  } else if (cmd === 'write_file' || cmd === 'create' || cmd === 'write') {
    preview = (a.content ?? '').slice(0, 80).replace(/\n/g, '\\n')
  }
  count++
  console.log(JSON.stringify({ ...brief, preview }))
}
console.log(`--- total: ${count}`)
