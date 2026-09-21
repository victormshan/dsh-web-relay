// Rename 试验 -> 任务 in client.js UI strings
const fs = require('fs')
const p = 'D:/DSH/dsh-web-relay/lib/client.js'
let t = fs.readFileSync(p, 'utf8')
const subs = [
  ["'最近试验:'", "'最近任务:'"],
  ["'试验记录读取失败'", "'任务记录读取失败'"],
  ["'试验 prompt 会作为问题发给 Gemini：'", "'任务 prompt 会作为问题发给 Gemini：'"],
  ['试验记录在 web-relay/experiments/', '任务记录在 web-relay/experiments/'],
]
let total = 0
for (const [a, b] of subs) {
  const n = t.split(a).length - 1
  if (n > 0) { t = t.split(a).join(b); total += n } else { console.log('NOT FOUND:', a.slice(0, 50)) }
}
fs.writeFileSync(p, t)
console.log('替换', total, '处；残留「试验」:', (t.match(/试验/g) || []).length)
