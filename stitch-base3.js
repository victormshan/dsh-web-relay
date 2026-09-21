// Correct stitch: view format is `${String(n).padStart(6,' ')}  ${line}`.
// Line regex: ^\s*(\d+)\s{2}(.*)$ — keep content incl. leading whitespace.
// Drop rows after a <response clipped> marker inside a view.
const fs = require('fs')
const LOG = 'C:/Users/Administrator/.dsh/sessions/--D-dsh~0020relay~0020test--/session-3fc0a01b-fac8-47fc-b290-a8b08a324c3c/session.jsonl.zstd.decoded'
const events = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

function stitch(target, isBaseTotal, maxSeq) {
  function parseView(ev) {
    const cont = ev.data?.message?.content?.[0]?.content?.[0]?.text
    if (typeof cont !== 'string') return null
    const m = cont.match(/^Here's the content of (.+?) with line numbers \(which has a total of (\d+) lines\)(?: with view_range=\[(\d+), (\d+)\])?:$/m)
    if (!m) return null
    if (!m[1].endsWith(`\\lib\\${target}`)) return null
    if (Number(m[2]) !== isBaseTotal) return null
    const rows = new Map()
    let clipped = false
    for (const l of cont.split(/\r?\n/).slice(1)) {
      if (/<response clipped>/.test(l)) { clipped = true; break }
      const mm = l.match(/^\s*(\d+)\s{2}(.*)$/)
      if (mm) rows.set(Number(mm[1]), mm[2])
    }
    return { seq: ev.seq, rows, clipped }
  }
  const views = events.filter((e) => e.type === 'tool/result').map(parseView).filter((v) => v && v.seq < maxSeq)
  const stitched = new Map()
  const conflicts = []
  for (const v of views) {
    for (const [no, text] of v.rows) {
      if (!stitched.has(no)) { stitched.set(no, text); continue }
      const prev = stitched.get(no)
      if (prev !== text) {
        if (text.length > prev.length) { conflicts.push({ line: no }); stitched.set(no, text) }
        else conflicts.push({ line: no })
      }
    }
  }
  const missing = []
  for (let i = 1; i <= isBaseTotal; i++) if (!stitched.has(i)) missing.push(i)
  const out = []
  for (let i = 1; i <= isBaseTotal; i++) out.push(stitched.has(i) ? stitched.get(i) : `__MISSING_${i}__`)
  return { out, missing, conflicts }
}

const idx = stitch('index.js', 923, 42000)
fs.writeFileSync('D:/dsh relay test/base-index-A.js', idx.out.join('\n') + '\n')
console.log(`index: rows=${923 - idx.missing.length}/923 missing=${idx.missing.join(',') || 'none'} conflicts=${idx.conflicts.length}`)

const cli = stitch('client.js', 715, 42000)
fs.writeFileSync('D:/dsh relay test/base-client-A.js', cli.out.join('\n') + '\n')
console.log(`client: rows=${715 - cli.missing.length}/715 missing=${cli.missing.join(',') || 'none'} conflicts=${cli.conflicts.length}`)

// diff version A vs installed version B (index)
const vb = fs.readFileSync('C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-web-relay/lib/index.js', 'utf8').split('\n')
let diffLines = []
for (let i = 0; i < idx.out.length && i < vb.length; i++) {
  if (idx.out[i].startsWith('__MISSING_')) continue
  if (idx.out[i] !== vb[i]) diffLines.push(i + 1)
}
console.log(`index versionA-vs-B differing lines: ${diffLines.length} (of non-missing)`)
console.log('  lines:', diffLines.slice(0, 60).join(','))
