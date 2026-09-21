// Print the first frame (session/header) of each dsh session.jsonl.zstd.
// Usage: node session-titles.js <dir-with-sessions> (recursive)
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const root = process.argv[2]
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name === 'session.jsonl.zstd') out.push(p)
  }
  return out
}

for (const file of walk(root)) {
  try {
    const buf = fs.readFileSync(file)
    let idx = buf.indexOf(MAGIC)
    if (idx < 0) { console.log(`NO-MAGIC  ${file}`); continue }
    // frame = from this magic to the next magic
    const next = buf.indexOf(MAGIC, idx + 4)
    const slice = buf.subarray(idx, next < 0 ? idx + 200000 : next)
    const text = zlib.zstdDecompressSync(slice).toString('utf8')
    const line = text.split(/\r?\n/).find((l) => l.trim())
    let title = '?', id = '?', mtime = '?'
    try {
      const ev = JSON.parse(line)
      const d = ev.data ?? {}
      title = d.title ?? d.agentPreset ?? ''
      id = d.id ?? ''
    } catch { /* keep defaults */ }
    console.log(`${path.basename(path.dirname(file))} | title="${title}" | preset=${JSON.stringify(((() => { try { const ev = JSON.parse(line); return ev.data?.agentPreset } catch { return null } })()))} | first=${String(line).slice(0, 180)}`)
  } catch (e) {
    console.log(`ERR ${file}: ${e.message}`)
  }
}
