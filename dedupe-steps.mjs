// 去重：steps.json 中 id 1-4 重复两遍，保留前 4 步
import fs from 'node:fs'
const p = 'D:/dsh relay test/web-relay/experiments/expr-2026-08-27_15-26-14.steps.json'
const s = JSON.parse(fs.readFileSync(p, 'utf8'))
const seen = new Set()
const uniq = []
for (const step of s.steps) {
  const key = String(step.id)
  if (seen.has(key)) continue
  seen.add(key)
  uniq.push(step)
}
s.steps = uniq
s.protocolVersion = 'v1.9'
s.iterations = 1
s.currentIteration = 1
s.rejectStreak = 0
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8')
console.log('去重完成:', s.steps.length, '步（', uniq.map((x) => x.id).join(',') + '）')
