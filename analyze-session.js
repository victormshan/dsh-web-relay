// Analyze a dsh session.jsonl.zstd byte layout: find zstd frame magic offsets.
// Usage: node analyze-session.js <file.zstd>
const fs = require('fs')

const file = process.argv[2]
const buf = fs.readFileSync(file)
console.log(`file: ${file} (${buf.length} bytes)`)

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SKIP_MAGIC_LO = Buffer.from([0x50, 0x2a, 0x4d, 0x18])
const SKIP_MAGIC_HI = Buffer.from([0x5f, 0x2a, 0x4d, 0x18])

const hex = (b, n) => Array.from(b.subarray(0, n)).map((x) => x.toString(16).padStart(2, '0')).join(' ')
console.log('first 32 bytes:', hex(buf, 32))

const offsets = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf.subarray(i, i + 4).equals(ZSTD_MAGIC)) offsets.push({ off: i, kind: 'zstd' })
  else if (buf.subarray(i, i + 4).equals(SKIP_MAGIC_LO) || buf.subarray(i, i + 4).equals(SKIP_MAGIC_HI)) offsets.push({ off: i, kind: 'skippable' })
}
console.log(`found ${offsets.length} frame starts`)
offsets.slice(0, 60).forEach((o) => {
  const frameHeader = hex(buf.subarray(o.off, o.off + 16), 16)
  console.log(`  @${o.off} (${o.kind}): ${frameHeader}`)
})
if (offsets.length > 60) console.log(`  ... and ${offsets.length - 60} more`)
