// 通用轨迹追加器（node 写 UTF-8，避免 PowerShell/内联 node 多行字符串踩坑——教训 066/067/068）
// 用法: node append-trace.mjs <bodyFile> [--role 主agent] [--expr <exprId>] [--dry-run]
// 说明:
//   - bodyFile 为 UTF-8 纯文本正文（用 write 工具生成，勿用 PowerShell 重定向以免编码损坏）；
//   - 自动加 `\n## [role] <ISO 时间>\n\n` 头部后追加到权威轨迹；
//   - --dry-run 只打印将追加的字节数与首行，不写入。
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2)
const bodyFile = args.find((a) => !a.startsWith('--'))
const role = (() => { const i = args.indexOf('--role'); return i >= 0 ? String(args[i + 1] || '主agent') : '主agent' })()
const exprId = (() => { const i = args.indexOf('--expr'); return i >= 0 ? String(args[i + 1] || '') : 'expr-2026-09-13_17-36-07' })()
const dryRun = args.includes('--dry-run')

if (!bodyFile) {
  console.error('usage: node append-trace.mjs <bodyFile> [--role 主agent] [--expr <exprId>] [--dry-run]')
  process.exit(2)
}
if (!fs.existsSync(bodyFile)) {
  console.error(`[append-trace] 正文文件不存在: ${bodyFile}`)
  process.exit(2)
}

const TRACE_DIR = path.join('D:\\dsh relay test', 'web-relay', 'traces')
const trace = path.join(TRACE_DIR, `${exprId}.md`)
if (!fs.existsSync(trace)) {
  console.error(`[append-trace] 轨迹文件不存在: ${trace}`)
  process.exit(2)
}

const body = fs.readFileSync(bodyFile, 'utf8')
if (!body.trim()) {
  console.error('[append-trace] 正文为空，拒绝追加空记录')
  process.exit(2)
}
// 编码卫生：拒绝明显双重编码/乱码特征（与 cc 规格门控同源判据）
if (/\uFFFD/.test(body)) {
  console.error('[append-trace] 正文含替换字符 U+FFFD（编码已损坏），请用 write 工具重写正文文件')
  process.exit(2)
}

const stamp = new Date().toISOString()
const entry = `\n## [${role}] ${stamp}\n\n${body.trimEnd()}\n`

if (dryRun) {
  console.log(`[append-trace] DRY-RUN 目标=${trace}`)
  console.log(`[append-trace] 将追加 ${Buffer.byteLength(entry, 'utf8')} 字节 | 正文首行: ${body.trim().split('\n')[0]}`)
  process.exit(0)
}

const before = fs.statSync(trace).size
fs.appendFileSync(trace, entry, 'utf8')
const after = fs.statSync(trace).size
console.log(`[append-trace] OK 角色=${role} 追加=${after - before} 字节 轨迹总字节=${after}`)
