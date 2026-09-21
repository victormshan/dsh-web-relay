// 配额重置时间解析：用**真实文案**测两个解析器（链条侧 / relay 侧）
// 真实文案（来自 2026-09-16 03:00 A4 任务失败时的 claude.log，60 字节全文）：
//   You've hit your session limit · resets 7am (Asia/Shanghai)
// 注意它**只有小时、没有分钟**，而既有正则要求 H:MM。
const SAMPLES = [
  ["You've hit your session limit · resets 7am (Asia/Shanghai)", '真实文案（仅小时）'],
  ['resets 7am (Asia/Shanghai)', '仅小时·短'],
  ['resets 3:20am (Asia/Shanghai)', 'H:MM 形态'],
  ['resets 12am (Asia/Shanghai)', '边界：12am（应为 00:00）'],
  ['resets 12pm (Asia/Shanghai)', '边界：12pm（应为 12:00）'],
  ['resets 11:05pm (Asia/Shanghai)', 'H:MM pm'],
  ['You\'ve hit your session limit', '无 resets 段'],
]
const now = new Date();
const show = (iso) => (iso ? `${iso}  [${new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })} 本地]` : 'null')

console.log('  当前时间: ' + now.toISOString() + ' / 本地 ' + now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }))

// ---------- 链条侧 ----------
let chainParse = null
try {
  const m = await import('file:///D:/dsh relay test/cc-chain.mjs')
  chainParse = m.parseQuotaResetsAt
  console.log('\n  === cc-chain.mjs parseQuotaResetsAt（import 成功，无致命副作用）===')
} catch (e) {
  console.log('\n  === cc-chain.mjs import 失败：' + String(e && e.message).slice(0, 120) + ' ===')
}
// ---------- relay 侧 ----------
let relayParse = null
try {
  const m2 = await import('file:///D:/dsh-web-relay/lib/cc-channel.js')
  relayParse = m2.parseResetsAt
  console.log('  === lib/cc-channel.js parseResetsAt（import 成功）===\n')
} catch (e) {
  console.log('  === relay 侧 import 失败：' + String(e && e.message).slice(0, 120) + ' ===\n')
}

let bad = 0
for (const [text, label] of SAMPLES) {
  const c = chainParse ? chainParse(text) : '(跳过)'
  const r = relayParse ? relayParse(text) : '(跳过)'
  const fmt = (v) => (typeof v === 'string' ? show(v) : String(v))
  console.log(`  ${label.padEnd(22)} chain=${fmt(c)}`)
  console.log(`  ${''.padEnd(22)} relay=${fmt(r)}`)
  // 判定：真实文案若两者皆为 null，即为「解析失败」缺陷
  if (label.startsWith('真实文案') && (c === null || c === undefined) ) bad += 1
}
console.log('\n  === 结论 ===')
console.log(`  真实文案「resets 7am」链条侧解析${chainParse && chainParse(SAMPLES[0][0]) ? '成功 ✅' : '失败 ❌'}`)
console.log(`  真实文案「resets 7am」relay  侧解析${relayParse && relayParse(SAMPLES[0][0]) ? '成功 ✅' : '失败 ❌'}`)
console.log(`  → 失败意味着：配额文案是「仅小时」形态时，已知耗尽短路（含 resetsAt）不生效，会白耗派发尝试。`)
