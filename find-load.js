// Locate the two Step List load blocks in client.js
const fs = require('fs')
const lines = fs.readFileSync('D:/DSH/dsh-web-relay/lib/client.js', 'utf8').split('\n')
const hits = []
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('loadStepState(stepLoadId)')) hits.push(i + 1)
}
console.log('loadStepState(stepLoadId) 出现行:', hits.join(','))
for (const start of hits) {
  console.log('=== 第 ' + start + ' 行附近 ===')
  for (let i = Math.max(0, start - 8); i < Math.min(lines.length, start + 6); i++) {
    console.log((i + 1) + '|' + lines[i])
  }
  console.log('')
}
