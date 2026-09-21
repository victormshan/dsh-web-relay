// Print chat transcript (user/message + assistant/message text content) of a session file.
// Usage: node extract-chat.js <session.jsonl.zstd> [max-snippet-chars] [out.txt]
const fs = require('fs')
const zlib = require('zlib')

const file = process.argv[2]
const maxLen = Number(process.argv[3] || 800)
const outFile = process.argv[4] || ''
let outBuf = ''
const print = (s) => { outBuf += s + '\n' }
const finish = () => { if (outFile) fs.writeFileSync(outFile, outBuf, 'utf8'); else process.stdout.write(outBuf) }

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
  if (e.type !== 'user/message' && e.type !== 'assistant/message') continue
  const d = e.data || {}
  const msg = d.message || {}
  if (msg.role !== 'user' && msg.role !== 'assistant') continue
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
  if (e.type === 'user/message') pull(d.content)
  else pull(msg.content)
  const text = txts.join(' ').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\s+/g, ' ').trim()
  if (!text) continue
  const kind = e.type === 'user/message' ? 'USER' : 'ASST'
  print(`\n=== ${kind} | L${lines.indexOf(line)} | seq=${e.seq} | time=${new Date(e.time).toISOString()} ===`)
  print(text.slice(0, maxLen))
}
finish()
