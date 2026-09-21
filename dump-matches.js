// Dump matching raw lines from one session.jsonl.zstd to a UTF-8 file.
// Usage: node dump-matches.js <session.jsonl.zstd> <out.txt> <term> [term...]
const fs = require('fs')
const zlib = require('zlib')

const file = process.argv[2]
const outFile = process.argv[3]
const terms = process.argv.slice(4)

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
const hits = []
for (let i = 0; i < lines.length; i++) {
  const s = lines[i]
  if (terms.some((t) => s.includes(t))) hits.push(`L${i} | ${s}`)
}
fs.writeFileSync(outFile, `terms=[${terms.join(',')}] totalLines=${lines.length} hits=${hits.length}\n` + hits.join('\n'), 'utf8')
console.log(`done hits=${hits.length} -> ${outFile}`)
