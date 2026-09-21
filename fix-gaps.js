// Patch __MISSING_N__ placeholders in a stitched base from the installed file's Nth line.
const fs = require('fs')
const basePath = process.argv[2]
const srcPath = process.argv[3]
let base = fs.readFileSync(basePath, 'utf8').split('\n')
const src = fs.readFileSync(srcPath, 'utf8').split('\n')
let patched = 0
for (let i = 0; i < base.length; i++) {
  const m = base[i].match(/^__MISSING_(\d+)__$/)
  if (!m) continue
  const n = Number(m[1])
  if (src[n - 1] !== undefined) { base[i] = src[n - 1]; patched++ }
}
// drop trailing empty element from the extra newline
if (base[base.length - 1] === '') base.pop()
fs.writeFileSync(basePath, base.join('\n') + '\n')
console.log(`patched ${patched} gaps; final lines=${base.length}`)
