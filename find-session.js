// Walk a dsh sessions dir, decompress each session.jsonl.zstd (multi-frame),
// and report files whose text contains any of the given terms.
// Usage: node find-session.js <sessions-root> <term> [term...]
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const root = process.argv[2]
const terms = process.argv.slice(3)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decode(buf) {
  if (buf.length < 4 || !buf.subarray(0, 4).equals(MAGIC)) return buf.toString('utf8')
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.subarray(i, i + 4).equals(MAGIC)) offsets.push(i)
  let out = ''
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try { out += zlib.zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8') } catch (e) { out += `<<frame-err ${k}>>` }
  }
  return out
}

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
    const text = decode(fs.readFileSync(file))
    const hits = terms.filter((t) => text.includes(t))
    if (hits.length === 0) continue
    const lines = text.split(/\r?\n/)
    console.log(`=== HIT ${path.relative(root, file)} | terms=[${hits.join(',')}] | chars=${text.length} | lines=${lines.length}`)
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i]
      if (terms.some((t) => s.includes(t))) {
        console.log(`  L${i} | ${s.slice(0, 400)}`)
      }
    }
  } catch (e) {
    console.log(`ERR ${file}: ${e.message}`)
  }
}
