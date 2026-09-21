// Decode a dsh session.jsonl.zstd that is a concatenation of many zstd frames
// (each appended entry = one independent frame). Usage: node decode-all.js <file.zstd>
const fs = require('fs')
const zlib = require('zlib')

const file = process.argv[2]
const buf = fs.readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const offsets = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf.subarray(i, i + 4).equals(MAGIC)) offsets.push(i)
}
console.log(`frames: ${offsets.length}`)

let out = ''
let ok = 0, fail = 0
for (let k = 0; k < offsets.length; k++) {
  const start = offsets[k]
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
  const slice = buf.subarray(start, end)
  try {
    out += zlib.zstdDecompressSync(slice).toString('utf8')
    ok++
  } catch (e) {
    fail++
  }
}
const lines = out.split(/\r?\n/).filter((l) => l.trim())
console.log(`decoded frames ok=${ok} fail=${fail} | total chars=${out.length} | lines=${lines.length}`)
const dest = file + '.decoded'
fs.writeFileSync(dest, out)
console.log(`written: ${dest}`)
