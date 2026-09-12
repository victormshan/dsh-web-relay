// 兼容性元数据回归（v4.9.7）：
//  1) package.json 的 dsh.compat 必须同时声明 rc.7 线（原生可用）与新线 0.1.5+（需 shim）
//  2) 声明的 shim 载体必须真实存在、进 files 清单、且实现契约（防「文档说支持、包里没东西」）
//  3) 兼容矩阵文档覆盖当前版本号与两条版本线
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const doc = readFileSync(join(root, 'docs', 'COMPATIBILITY.md'), 'utf8')
const shimLib = readFileSync(join(root, 'shim', 'dsh-apiproxy-shim', 'lib', 'index.js'), 'utf8')

test('v4.9.7: dsh.compat 声明 rc.7 原生可用 + 新线需 shim', () => {
  const c = pkg.dsh && pkg.dsh.compat
  assert.ok(c, 'package.json 应有 dsh.compat 元数据')
  assert.match(c.harnessRc7, /rc\.7/, '应声明 rc.7 线')
  assert.match(c.harnessNewLine, /0\.1\.5/, '应声明新线 0.1.5+')
  assert.match(c.newLineRequires, /dsh-apiproxy-shim/, '应声明新线依赖 shim')
  assert.ok(c.requiresServices.includes('apiProxy'), '应声明 apiProxy 硬依赖')
})

test('v4.9.7: shim 载体存在、进 files 清单、且实现桥接契约', () => {
  const shimDir = join(root, 'shim', 'dsh-apiproxy-shim')
  for (const f of ['package.json', 'lib/index.js', 'test/selftest.mjs']) {
    assert.ok(existsSync(join(shimDir, f)), `shim 文件应存在: ${f}`)
    assert.ok(
      pkg.files.includes(`shim/dsh-apiproxy-shim/${f}`),
      `package.json files 应包含: shim/dsh-apiproxy-shim/${f}`
    )
  }
  assert.match(shimLib, /sessionController/, 'shim 应桥接到新线 sessionController')
  assert.match(shimLib, /provide\('apiProxy'/, 'shim 应注册 apiProxy 服务')
  assert.match(shimLib, /sessions: \{ prompt \}/, 'shim 应暴露 sessions.prompt')
})

test('v4.9.7: 兼容矩阵覆盖当前版本号与两条版本线', () => {
  assert.ok(doc.includes('兼容矩阵'), 'COMPATIBILITY.md 应有兼容矩阵')
  assert.ok(doc.includes(pkg.version), `兼容矩阵应含当前版本号 ${pkg.version}`)
  assert.ok(doc.includes('0.1.0-rc.7'), '应覆盖 rc.7 线')
  assert.ok(doc.includes('0.1.5+'), '应覆盖新线')
  assert.ok(doc.includes('shim/dsh-apiproxy-shim'), '应指出随包 shim 位置')
})
