// Print session header + user/message lines (optionally filtered by a term).
// Usage: node extract-user-msgs.js <session.jsonl.zstd> [filter-term] [max-snippet-chars]
const fs = require('fs')
const zlib = require('zlib')

const file = process.argv[2]
const filter = process.argv[3] || ''
const maxLen = Number(process.argv[4] || 500)

const buf = fs.readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decode(b) {
  if (b.length < 4 || !b.subarray(0, 4).equals(MAGIC)) return b.toString('utf8')
  const offs = []
  for (let i = 0; i + 4 <= b.length; i++) if (b.subarray(i, i + 4).equals(MAGIC)) offs.push(i)
  let out = ''
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : b.length
    try { out += zlib.zstdDecompressSync(b.subarray(offs[k], end)).toString('utf8') } catch (e) { out += `<<frame-err ${k}>>` }
  }
  return out
}

const lines = decode(buf).split(/\r?\n/).filter((l) => l.trim())
for (const line of lines) {
  let e
  try { e = JSON.parse(line) } catch { continue }
  if (e.type === 'session' || e.type === 'session/title') {
    console.log(`HEADER ${JSON.stringify(e).slice(0, 400)}`)
    continue
  }
  if (e.type !== 'user/message' && e.type !== 'agent/inbox/spliced') continue
  const d = e.data || {}
  const txts = []
  const pull = (c) => {
    if (!c) return
    if (typeof c === 'string') txts.push(c)
    else if (Array.isArray(c)) c.forEach(pull)
    else if (c && typeof c === 'object') {
      if (typeof c.text === 'string') txts.push(c.text)
      if (c.content) pull(c.content)
    }
  }
  pull(d.content)
  const text = txts.join(' ').replace(/\s+/g, ' ')
  if (filter && !text.includes(filter)) continue
  console.log(`L${lines.indexOf(line)} | ${e.type} | seq=${e.seq} | time=${new Date(e.time).toISOString()} | ${text.slice(0, maxLen)}`)
}
