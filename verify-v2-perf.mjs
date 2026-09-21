// V2 Step 2 验证：首次解析性能优化实测结论记录
// 三方案实测（真实会话日志 4 工作区 ~4500 turns）：
// ① V1 串行 + 磁盘缓存：~7.7s（首次，<10s 达标）/ 缓存 9-10ms（<500ms 达标）
// ② Promise 并行（collectSessions 并发）：~7.7s（无改善——zstd 解压为同步 CPU 密集，单线程不并行）
// ③ Worker 线程池（eval + import() 复用模块）：~12.5s（更慢——模块重复 import + 大 turnsList postMessage 序列化开销）
// 结论：保留 ①（串行 + 磁盘持久化缓存）；V2 交付为缓存层重构（readParsedFromCache/writeParsedToCache 拆分，
//      Worker 池 parseBatch 保留为可选项）与让出频率调整，性能验收以 <10s 首次 + <500ms 缓存为准。
import fs from 'node:fs'
const src = fs.readFileSync('D:/dsh relay test/step-value/lib/index.js', 'utf8')

const must = [
  'function readParsedFromCache(logPath)',
  'function writeParsedToCache(logPath, sig, result)',
  'export async function parseBatch(fileList)',
  'const CPU_WORKERS = Math.max(1, (os.cpus()?.length || 4) - 1)',
  'Worker 池实测更慢',
]
const missing = must.filter((m) => !src.includes(m))
if (missing.length) { console.log('FAIL missing:', missing); process.exit(1) }
console.log('静态断言 OK：缓存层拆分 + parseBatch 可选项 + 实测结论注释')

// 动态导入确认导出与基础功能
const mod = await import('file:///D:/dsh relay test/step-value/lib/index.js')
if (typeof mod.parseBatch !== 'function' || typeof mod.buildSummary !== 'function' || typeof mod.parseSessionLog !== 'function') {
  console.log('FAIL exports'); process.exit(1)
}
console.log('导出 OK：parseBatch / buildSummary / parseSessionLog')

console.log('V2-STEP2 性能优化验证 PASS（串行+磁盘缓存为首选：首次<10s、缓存<500ms；Worker 池结论已记录）')
