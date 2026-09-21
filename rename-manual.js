// Rename 试验记录 -> 任务记录 in manual (terms unified; experiments/ dir name kept)
const fs = require('fs')
const p = 'D:/DSH/dsh-web-relay/docs/dsh-web-relay-说明书.md'
let t = fs.readFileSync(p, 'utf8')
const before = (t.match(/试验/g) || []).length
t = t.split('试验记录').join('任务记录')
// 剩余的"试验"（不带"记录"）
t = t.split('试验').join('任务')
fs.writeFileSync(p, t)
console.log('替换完成：替换前「试验」' + before + ' 处；替换后「试验」残留 ' + (t.match(/试验/g) || []).length + '，「任务」出现 ' + (t.match(/任务/g) || []).length)
