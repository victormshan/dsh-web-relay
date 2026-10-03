// v4.12.2: deploy.ps1 在 Windows PowerShell 5.1 下的编码安全（移植自 2026-09-01 auto-iterate 修复）。
// 无 BOM 时 PS 5.1 按 ANSI 代码页解析，中文字符串变乱码 → 语法错误；读 package.json 不带
// -Encoding UTF8 同理，ConvertFrom-Json 失败。这里静态守住三点，防止回退。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url))

test('deploy.ps1 以 UTF-8 BOM 开头（PowerShell 5.1 才能正确解析中文）', () => {
  const buf = read('deploy.ps1')
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf])
})

test('deploy.ps1 读取 package.json 的 Get-Content 都显式 -Encoding UTF8', () => {
  const src = read('deploy.ps1').toString('utf8')
  const reads = src.match(/Get-Content[^\n|]*package\.json[^\n|]*/g) || []
  assert.equal(reads.length, 2)
  for (const r of reads) assert.match(r, /-Encoding UTF8/, r)
})

test('.editorconfig 对 *.ps1 指定 utf-8-bom，防止编辑器保存时去掉 BOM', () => {
  const cfg = read('.editorconfig').toString('utf8')
  assert.match(cfg, /\[\*\.ps1\]\s*\ncharset = utf-8-bom/)
})
