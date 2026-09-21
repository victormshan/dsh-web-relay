// Streaming-decompress a (possibly multi-frame) dsh session.jsonl.zstd.
// Usage: node decode-session.js <file.zstd>
const fs = require('fs')
const zlib = require('zlib')

const file = process.argv[2]
const out = file + '.decoded'

const input = fs.createReadStream(file)
const output = fs.createWriteStream(out)
const dec = zlib.createZstdDecompress()

input.pipe(dec).pipe(output)
output.on('finish', () => {
  const st = fs.statSync(out)
  console.log(`decoded ${st.size} bytes -> ${out}`)
})
output.on('error', (e) => { console.log('decode FAIL:', e.message); process.exit(1) })
