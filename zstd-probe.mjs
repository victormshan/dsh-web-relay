// 解压主会话 zstd 轨迹并搜索 DSPy/LangGraph 相关上下文
import fs from 'node:fs'
import { decompressSync } from 'fzstd'

const ZSTD = process.env.DSH_SESSION_JSONL
console.log('zstd 文件:', ZSTD, '| 大小:', fs.statSync(ZSTD).size)

const compressed = fs.readFileSync(ZSTD)
console.log('压缩数据读取完成，开始解压...')
const t0 = Date.now()
const raw = decompressSync(compressed)
console.log(`解压完成: ${raw.length} bytes（${((Date.now() - t0) / 1000).toFixed(1)}s）`)

const out = 'D:\\dsh relay test\\session-main.jsonl'
fs.writeFileSync(out, raw)
console.log('已写入:', out)

// 搜索关键词
const text = raw.toString('utf8')
const patterns = [/DSPy/g, /LangGraph/g, /LangChain/g, /CrewAI/g, /AutoGen/g, /重型框架/g, /业界框架/g, /业界实践/g]
for (const p of patterns) {
  const matches = [...text.matchAll(p)]
  console.log(`\n=== 关键词 ${p.source}: ${matches.length} 处 ===`)
  for (const m of matches.slice(0, 8)) {
    const start = Math.max(0, m.index - 300)
    const snippet = text.slice(start, m.index + 300).replace(/\s+/g, ' ').slice(0, 400)
    console.log(`--- @${m.index} ---`)
    console.log(snippet)
  }
}
