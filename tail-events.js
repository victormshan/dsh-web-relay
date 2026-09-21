// Decode only the LAST N frames of a dsh session.jsonl.zstd (multi-frame zstd)
// and print lines matching a filter regex. Usage: node tail-events.js <file.zstd> <n> <regex>
const fs = require('fs')
const zlib = require('zlib')

const file = process.argv[2]
const n = Number(process.argv[3] ?? 30)
const re = new RegExp(process.argv[4] ?? 'settings/document-updated|agent-preset')
const buf = fs.readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const offsets = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf.subarray(i, i + 4).equals(MAGIC)) offsets.push(i)
}
console.log(`frames total: ${offsets.length}, decoding last ${Math.min(n, offsets.length)}`)

let ok = 0, fail = 0
const startIdx = Math.max(0, offsets.length - n)
for (let k = startIdx; k < offsets.length; k++) {
  const start = offsets[k]
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
  const slice = buf.subarray(start, end)
  try {
    const text = zlib.zstdDecompressSync(slice).toString('utf8')
    ok++
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() && re.test(line)) console.log(line.slice(0, 2000))
    }
  } catch (e) {
    fail++
  }
}
console.log(`decoded ok=${ok} fail=${fail}`)
