// Replay v2: fix isError detection (tc.isError, not nested content), path-based checkpoints.
// Usage: node replay-v07.js <decoded.jsonl> <target> <baseFile> <outFile>
const fs = require('fs')
const LOG = process.argv[2]
const TARGET = process.argv[3]
const BASE = process.argv[4]
const OUT = process.argv[5]

const events = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
let content = fs.readFileSync(BASE, 'utf8')

const results = new Map()
for (const e of events) {
  if (e.type !== 'tool/result') continue
  const callId = e.data?.message?.source?.callId
  if (!callId) continue
  const tc = e.data?.message?.content?.[0]
  // tc is a tool-result object: { type:'tool-result', toolCallId, content:[{type:'text',text}], isError }
  const isError = tc?.isError === true
  results.set(callId, { isError, seq: e.seq })
}

// checkpoints: parse view results whose path ends with dsh-web-relay\lib\<target>
const checkpoints = []
for (const e of events) {
  if (e.type !== 'tool/result') continue
  const cont = e.data?.message?.content?.[0]?.content?.[0]?.text
  if (typeof cont !== 'string') continue
  const m = cont.match(/^Here's the content of (.+?) with line numbers \(which has a total of (\d+) lines\)(?: with view_range=\[(\d+), (\d+)\])?:$/m)
  if (!m) continue
  if (!m[1].includes('dsh-web-relay')) continue
  if (!m[1].endsWith(`\\lib\\${TARGET}`)) continue
  checkpoints.push({ seq: e.seq, lines: Number(m[2]) })
}
checkpoints.sort((a, b) => a.seq - b.seq)

function countLines(s) { return s.split('\n').length }

let applied = 0, skippedFail = 0, skippedOther = 0, noResult = 0
let cpIdx = 0
const problems = []
let lastEditSeq = 0

for (const e of events) {
  if (e.type !== 'tool/call') continue
  const d = e.data ?? {}
  if (typeof d.arguments !== 'string') continue
  let args
  try { args = JSON.parse(d.arguments) } catch { continue }
  const p = args.path ?? ''
  if (!p.includes('dsh-web-relay') || !p.includes(`\\lib\\${TARGET}`)) continue
  const cmd = args.command
  if (cmd !== 'str_replace' && cmd !== 'insert') { skippedOther++; continue }
  lastEditSeq = e.seq
  while (cpIdx < checkpoints.length && checkpoints[cpIdx].seq < e.seq) {
    const cp = checkpoints[cpIdx++]
    const got = countLines(content)
    if (got !== cp.lines) problems.push(`CHECKPOINT seq=${cp.seq} expected=${cp.lines} got=${got}`)
  }
  const res = results.get(d.callId)
  if (!res) { noResult++; continue }
  if (res.isError) { skippedFail++; continue }
  if (cmd === 'str_replace') {
    const oldStr = args.old_str
    const newStr = args.new_str ?? ''
    const idx = content.indexOf(oldStr)
    if (idx === -1) { problems.push(`MISSING seq=${e.seq} turn=${d.turn}/${d.step}: ${JSON.stringify(oldStr).slice(0, 150)}`); continue }
    if (content.indexOf(oldStr, idx + 1) !== -1) { problems.push(`AMBIGUOUS seq=${e.seq} turn=${d.turn}/${d.step}`); continue }
    content = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length)
    applied++
  } else if (cmd === 'insert') {
    const insertLine = args.insert_line
    const newStr = args.new_str ?? ''
    const lines = content.split('\n')
    if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) { problems.push(`BAD insert_line ${insertLine} seq=${e.seq}`); continue }
    content = [...lines.slice(0, insertLine), ...newStr.split('\n'), ...lines.slice(insertLine)].join('\n')
    applied++
  }
}
while (cpIdx < checkpoints.length) {
  const cp = checkpoints[cpIdx++]
  const got = countLines(content)
  if (got !== cp.lines) problems.push(`CHECKPOINT seq=${cp.seq} expected=${cp.lines} got=${got}`)
}

fs.writeFileSync(OUT, content)
const expected = checkpoints.length ? checkpoints[checkpoints.length - 1].lines : '?'
console.log(`target=${TARGET}`)
console.log(`base=${countLines(fs.readFileSync(BASE, 'utf8'))} final=${countLines(content)} expected=${expected}`)
console.log(`applied=${applied} skippedFail=${skippedFail} skippedOther=${skippedOther} noResult=${noResult} lastEditSeq=${lastEditSeq} checkpoints=${checkpoints.length}`)
if (problems.length) {
  console.log(`PROBLEMS ${problems.length}:`)
  for (const p of problems.slice(0, 60)) console.log('  ' + p)
} else {
  console.log('ALL CHECKPOINTS PASSED')
}
