// Check residual hardcoded zh strings outside the locale dict
const fs = require('fs')
const lines = fs.readFileSync('D:/DSH/dsh-web-relay/lib/client.js', 'utf8').split('\n')
const pats = ['解析并预览', 'manual 模式需要粘贴回答', '查看协作记录', '收起协作记录', '用户任务', '过程概述', '成果摘要', '保存中', '仅保存记录']
let found = 0
for (let i = 0; i < lines.length; i++) {
  for (const p of pats) {
    // skip lines that are dict values: "'key': '...中文...'"
    const isDictValue = new RegExp("'[A-Za-z0-9]+':\\s*'[^']*" + p).test(lines[i])
    if (lines[i].includes(p) && !isDictValue) {
      console.log((i + 1) + '|' + p + '|' + lines[i].trim().slice(0, 100))
      found++
    }
  }
}
console.log('residual:', found)
