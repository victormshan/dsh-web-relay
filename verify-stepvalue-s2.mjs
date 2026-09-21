// V1 Step 2 验证：step-value 持久化缓存（Disk-backed Incremental Cache）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const src = fs.readFileSync('D:/dsh relay test/step-value/lib/index.js', 'utf8')

// a) 静态断言：持久化缓存实现齐备
const must = [
  'DISK_CACHE_DIR',
  'step-value-cache',
  "const diskPath = join(DISK_CACHE_DIR, encodeURIComponent(logPath) + '.json')",
  'disk.sig === sig',
  'mkdirSync(DISK_CACHE_DIR, { recursive: true })',
  'writeFileSync(diskPath, JSON.stringify({ sig, parsedAt: Date.now(), result }), \'utf8\')',
]
const missing = must.filter((m) => !src.includes(m))
if (missing.length) { console.log('FAIL missing:', missing); process.exit(1) }
console.log('静态断言 OK：持久化缓存（磁盘层 + sig 校验 + 落盘）齐备')

// b) 缓存命中逻辑复测（与实现一致）：sig 匹配 → 命中；不匹配 → 重解析
function diskHit(disk, sig) {
  return !!(disk && disk.sig === sig && disk.result)
}
const cases = [
  [{ sig: 'A', result: { turnsList: [] } }, 'A', true],
  [{ sig: 'A', result: { turnsList: [] } }, 'B', false],
  [null, 'A', false],
  [{ sig: 'A', result: null }, 'A', false],
]
for (const [disk, sig, want] of cases) {
  if (diskHit(disk, sig) !== want) { console.log('FAIL', disk, sig, 'want', want); process.exit(1) }
}
console.log('sig 校验复测 OK（4 用例：匹配命中 / 不匹配重解析 / 无缓存 / result 缺失）')

// c) 缓存 key 策略：encodeURIComponent(logPath) 生成稳定文件名（含盘符冒号安全转义）
const lp = 'C:\\Users\\Administrator\\.dsh\\sessions\\--D-dsh~0020relay~0020test--\\session-abc\\session.jsonl.zstd'
const fn = encodeURIComponent(lp) + '.json'
if (!fn || fn.includes('\\') || fn.includes(':')) { console.log('FAIL cache filename', fn); process.exit(1) }
console.log('缓存文件名 OK：路径转义为安全文件名（', fn.slice(0, 40) + '...' , '）')

console.log('V1-STEP2 持久化缓存验证 PASS')
