// Inspect a dsh session.jsonl.zstd: count entries, show structure, look for
// context/compaction markers. Usage: node inspect-session.js <file.zstd> [tail|head|compact]
const fs = require('fs')
const zlib = require('zlib')

const file = process.argv[2]
const mode = process.argv[3] || 'compact'

const buf = fs.readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
let text
if (buf.length >= 4 && buf.subarray(0, 4).equals(MAGIC)) {
  // concatenated zstd frames: decode each frame independently
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.subarray(i, i + 4).equals(MAGIC)) offsets.push(i)
  let out = ''
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try { out += zlib.zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8') } catch (e) { /* skip bad frame */ }
  }
  text = out
} else {
  text = buf.toString('utf8')
}
const lines = text.split(/\r?\n/).filter((l) => l.trim())

let parsed = 0, failed = 0
const entries = []
for (const line of lines) {
  try { entries.push(JSON.parse(line)); parsed++ } catch (e) { failed++ }
}

const show = (e) => {
  const keys = Object.keys(e)
  const role = e.role || (e.message && e.message.role) || ''
  const type = e.type || ''
  const id = e.id || ''
  const ts = e.ts || e.timestamp || ''
  let content = e.content
  if (typeof content === 'string') content = content.slice(0, 80).replace(/\n/g, ' ')
  else if (Array.isArray(content)) content = JSON.stringify(content).slice(0, 80)
  else if (content && typeof content === 'object') content = JSON.stringify(content).slice(0, 80)
  else content = ''
  return `${id} | ${type} | ${role} | ${ts} | keys=[${keys.join(',')}] | ${content}`
}

console.log(`file: ${file}`)
console.log(`chars: ${text.length} | lines: ${lines.length} | parsed: ${parsed} | failed: ${failed}`)

if (mode === 'head' || mode === 'compact') {
  console.log('--- FIRST 8 ---')
  entries.slice(0, 8).forEach((e) => console.log(show(e)))
}
if (mode === 'tail' || mode === 'compact') {
  console.log('--- LAST 30 ---')
  entries.slice(-30).forEach((e) => console.log(show(e)))
}

// search for compaction / context-limit markers anywhere
console.log('--- MARKERS ---')
const markers = []
entries.forEach((e, i) => {
  const s = JSON.stringify(e)
  if (/compact|context limit|contextLimit|overflow|token|truncat/i.test(s) && /compact|overflow|limit|truncat/i.test(s)) {
    markers.push(`line ${i}: ${s.slice(0, 200)}`)
  }
})
if (markers.length === 0) console.log('(none)')
else markers.slice(-20).forEach((m) => console.log(m))
