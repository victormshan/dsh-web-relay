// v4.12.1: 安装链路回归（"下载即可用"必须可断言）
// 背景（2026-09-23 实测）：新线 dsh 0.1.5+ 移除了 apiProxy 服务，只装插件不装 shim 会 pending、
// 宿主启动断言失败（N entries did not activate）。而两个一键脚本与 INSTALL-NEW-ENV 都没有 shim 一步
// （grep shim 命中 0），package.json 的 files 也漏了 5 个被文档引用的脚本 —— "照文档装完用不了"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (rel) => readFileSync(root + rel, 'utf8')

const PS1 = 'scripts/install-new-env.ps1'
const SH = 'scripts/install-new-env.sh'

// ---- 一键脚本必须安装并注册 shim（新线必需）----
test('[POS] PowerShELL 安装脚本含 shim 安装与注册', () => {
  const s = read(PS1)
  assert.match(s, /dsh-apiproxy-shim/, 'ps1 必须提到 dsh-apiproxy-shim')
  assert.match(s, /shimDst/, 'ps1 应把 shim 复制到 profile node_modules')
  assert.match(s, /append shim row/, 'ps1 应把 shim 行追加进 cordis.patch.yml')
  assert.match(s, /selftest\.mjs/, 'ps1 应跑 shim 自检')
})

test('[POS] bash 安装脚本含 shim 安装与注册', () => {
  const s = read(SH)
  assert.match(s, /dsh-apiproxy-shim/, 'sh 必须提到 dsh-apiproxy-shim')
  assert.match(s, /SHIM_TARGET/, 'sh 应定义 shim 目标路径')
  assert.match(s, /registering dsh-apiproxy-shim/, 'sh 应把 shim 行追加进 cordis.patch.yml')
  assert.match(s, /selftest\.mjs/, 'sh 应跑 shim 自检')
})

test('[POS] 一键脚本离线复制必须覆盖 shim/skills/docs/scripts（不限于 lib+bin）', () => {
  const ps1 = read(PS1)
  assert.match(ps1, /foreach \(\$d in 'shim','skills','docs','scripts'\)/, 'ps1 应复制这四个目录')
  const sh = read(SH)
  assert.match(sh, /for d in shim skills docs scripts/, 'sh 应复制这四个目录')
})

// ---- package.json files 必须覆盖被文档引用的脚本（防再次漏项）----
test('[POS] files 清单覆盖被文档引用的安装/校验脚本', () => {
  const pkg = JSON.parse(read('package.json'))
  const need = ['scripts/install-new-env.ps1', 'scripts/install-new-env.sh', 'scripts/task-schema-cli.mjs', 'scripts/verify-files-coverage.mjs', 'scripts/verify-cc-gates.sh']
  for (const n of need) {
    assert.ok(pkg.files.includes(n), `files 缺少被引用的脚本: ${n}`)
    assert.ok(existsSync(root + n), `files 声明的文件在仓库里不存在: ${n}`)
  }
})

test('[NEG] files 声明的每条路径都必须真实存在（防"清单写了但没这个文件"）', () => {
  const pkg = JSON.parse(read('package.json'))
  const missing = pkg.files.filter((f) => !existsSync(root + f))
  assert.deepEqual(missing, [], `files 里存在仓库中不存在的路径: ${missing.join(', ')}`)
})

// ---- 文档必须讲清 shim 与"未发布 npm"----
test('[POS] INSTALL-NEW-ENV 含 shim 必装小节，README 标注未发布 npm', () => {
  const doc = read('docs/INSTALL-NEW-ENV.md')
  assert.match(doc, /shim 必须一起装|shim 必装/, 'INSTALL-NEW-ENV 应有 shim 必装小节')
  assert.match(doc, /dsh-apiproxy-shim/, 'INSTALL-NEW-ENV 应给出 shim 包名')
  const readme = read('README.md')
  assert.match(readme, /未发布到 npm|未发布 npm/, 'README 应说明未发布 npm')
  assert.match(readme, /selftest\.mjs|dsh-apiproxy-shim/, 'README 应给出 shim 安装/自检指引')
})

// ---- shim 自身可运行（装了才可能通过）----
test('[POS] 仓库内 shim 自检 10/10（安装后即可验证的那条命令）', async () => {
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync(process.execPath, [root + 'shim/dsh-apiproxy-shim/test/selftest.mjs'], { encoding: 'utf8' })
  assert.match(out, /10\/10 passed/, 'shim 自检应报 10/10 passed')
})
