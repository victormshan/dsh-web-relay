// v3.6.0 Step4: 影子沙盒门禁测试（纯函数镜像 lib/shadow-gate.js；运行：node --test test/shadow-gate.test.js）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkL1Gate, resolveRepoPath, shouldUseShadow, runShadowGC, executeRollbackBaseline, runL2ShadowGate, getGitHead, gcScheduleMs, shadowRepoCandidates, resolveShadowRepo } from '../lib/shadow-gate.js'

const REPO = 'D:/DSH'
// ⚠ 2026-09-21 修正：此处原为硬编码 `'D:/dsh relay test'`，把它当作"非 git 工作区"的夹具 ——
//   而 2026-09-21 起该工作区**本身成了 git 仓库**（工具链纳入版本控制），于是这些用例全部失败：
//   断言把"世界的瞬时状态"编码进了测试（L-087/L-090 同型）。实现是对的，夹具错了。
//   改为**临时目录**：由测试自己创建，保证在任何环境下都不是 git 仓库（父目录 %TEMP% 亦非仓库）。
const NON_REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-nonrepo-'))
// v3.9 Step1 用例用：本仓库真实根（不依赖硬编码 Windows 路径，WSL/Windows 两侧都能算出）。
const LIB_DIR = path.dirname(fileURLToPath(new URL('../lib/shadow-gate.js', import.meta.url)))
const REAL_REPO_ROOT = resolveRepoPath(LIB_DIR)

test('TC-Green: repoPath 识别 + L1 语法预检通过（合法文件）', () => {
  // v4.11.0 步8：resolveRepoPath 新增仓库特征校验（package.json.name==='dsh-web-relay'）。
  // D:/DSH 是外层聚合 git 仓库（本身不含 package.json），只满足"是 git 根"，不再被误判为插件仓库根——
  // 这条断言曾经是 'D:/DSH'，那正是本次要修的缺陷本体（旧逻辑把"任意 git 根"当作合法结果）。
  assert.equal(resolveRepoPath(REPO), null)
  assert.equal(resolveRepoPath(REAL_REPO_ROOT), REAL_REPO_ROOT) // 真正插件仓库根：git 根 + 特征吻合 → 采纳
  assert.equal(resolveRepoPath(NON_REPO), null)
  const r = checkL1Gate({ cwd: REPO, files: ['D:/DSH/dsh-web-relay/lib/shadow-gate.js'] })
  assert.equal(r.ok, true)
  assert.equal(r.errors.length, 0)
})

// ---- v4.11.0 步8：反向夹具 —— 候选 base 是 git 仓库但不含 dsh-web-relay 的 package.json ----
test('反向夹具：candidate base 是 git 仓库但缺 dsh-web-relay package.json → 修前误判为仓库根，修后正确越过它解析到插件仓库根', () => {
  const fakeHost = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-fakehost-'))
  const qq = (p) => '"' + String(p).replace(/"/g, '\\"') + '"'
  execSync(`git init -q ${qq(fakeHost)}`, { encoding: 'utf8' })
  try {
    // 修前逻辑镜像（仅 git 根判定，无仓库特征校验）：会把 fakeHost 自己判成"仓库根"——这是缺陷本体，
    // 证明它是一个"看起来合法"的错误结果（不是空仓库根，而是一个真实但错误的 git 根）。
    const legacyRoot = execSync(`git -C ${qq(fakeHost)} rev-parse --show-toplevel`, { encoding: 'utf8' }).trim()
    assert.ok(legacyRoot.length > 0)
    assert.notEqual(legacyRoot, REAL_REPO_ROOT) // 错误命中：不是真正的插件仓库根
    // 修后：resolveRepoPath 对 fakeHost 做特征校验（无 package.json）→ null，不再被候选循环短路采纳
    assert.equal(resolveRepoPath(fakeHost), null)
    // resolveShadowRepo：candidate 顺序与 env 覆盖语义不变，仅 base 候选因不满足特征被跳过，
    // 循环 continue 到下一候选（moduleDir，缺省为本模块所在目录）→ 正确解析到插件仓库根
    const got = resolveShadowRepo({ base: fakeHost, payload: {}, env: {} })
    assert.equal(got, REAL_REPO_ROOT)
  } finally {
    fs.rmSync(fakeHost, { recursive: true, force: true })
  }
})

test('TC-Red: L1 拦截（注入语法错误的文件 → ok:false + 错误清单）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-shadow-gate-'))
  const bad = path.join(tmp, 'bad.js')
  fs.writeFileSync(bad, 'const x = ;\n')
  const r = checkL1Gate({ cwd: tmp, files: ['bad.js'] })
  assert.equal(r.ok, false)
  assert.ok(r.errors.length >= 1)
  assert.ok(r.errors[0].file.includes('bad.js'))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('TC-Context/Trigger Matrix: shouldUseShadow 判定（off/auto/on/l1/l2/degraded）', () => {
  const stepHigh = { importance: 'high', artifacts: ['lib/index.js'], breakthrough_type: 'structural' }
  assert.equal(shouldUseShadow(stepHigh, { repoPath: REPO, shadowGate: 'auto' }), 'l2')       // structural → L2
  assert.equal(shouldUseShadow({ importance: 'high', artifacts: ['lib/index.js'] }, { repoPath: REPO, shadowGate: 'auto', needsTests: true }), 'l2')
  assert.equal(shouldUseShadow({ importance: 'high', artifacts: ['lib/index.js'] }, { repoPath: REPO, shadowGate: 'auto' }), 'l1') // 仅 high+源码 → L1
  assert.equal(shouldUseShadow(stepHigh, { repoPath: REPO, shadowGate: 'off' }), 'off')
  assert.equal(shouldUseShadow(stepHigh, { repoPath: null, shadowGate: 'auto' }), 'degraded') // 非 git
  assert.equal(shouldUseShadow({ importance: 'medium', artifacts: ['lib/index.js'] }, { repoPath: REPO }), 'off')
  assert.equal(shouldUseShadow({ importance: 'high', artifacts: ['docs/a.md'] }, { repoPath: REPO }), 'off') // 无源码产物
})

test('TC-GC: Shadow GC（worktree prune + 统计；不误伤）', () => {
  const r = runShadowGC(REPO)
  assert.equal(r.ok, true)
  assert.equal(typeof r.pruned, 'number')
  assert.ok(r.active <= r.max || r.active === undefined || r.max >= 0) // 不超上限即安全
  assert.equal(runShadowGC(null).ok, true)
})

test('TC-Rollback: 回滚基线（非 git 降级提示；缺 commit 报错；无效 commit 返回错误且不破坏仓库）', () => {
  const d = executeRollbackBaseline(null, 'abc1234')
  assert.equal(d.ok, false)
  assert.equal(d.degraded, true)
  assert.ok(d.reason.includes('non-git'))
  const noBase = executeRollbackBaseline(REPO, null)
  assert.equal(noBase.ok, false)
  assert.ok(noBase.error.includes('iterationBaseCommit'))
  const badCommit = executeRollbackBaseline(REPO, '0000000000000000000000000000000000000000')
  assert.equal(badCommit.ok, false) // 无效 commit → 不执行 reset（不破坏工作区）
})

test('source 标记：lib/index.js 已接入 shadow-gate（v3.6.0 Step2）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const sg = fs.readFileSync(new URL('../lib/shadow-gate.js', import.meta.url), 'utf8')
  assert.ok(src.includes("from './shadow-gate.js'"))
  assert.ok(src.includes('blocked: \'shadow-l1\''))
  assert.ok(src.includes('shadow-l2'))
  assert.ok(sg.includes('v3.6.0'))
})

// ---- v3.7.0 P2：回滚基线 + rollback 端点 ----
test('getGitHead：git 仓库返回 HEAD（40hex），非 git 返回 null', () => {
  const head = getGitHead(REPO)
  assert.ok(typeof head === 'string' && /^[0-9a-f]{40}$/.test(head))
  assert.equal(getGitHead(NON_REPO), null)
  assert.equal(getGitHead(null), null)
})

test('source 标记：rollback 端点与 GC 自动挂载（lib/index.js + client.js，v3.7.0 P2）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('const rollbackHandler'))
  assert.ok(src.includes("'/dsh-web-relay/steps/rollback'"))
  assert.ok(src.includes('iterationBaseCommit'))
  assert.ok(src.includes('Shadow GC 清理孤儿 worktree'))
  assert.ok(client.includes('rollbackToBase'))
  assert.ok(client.includes("'/dsh-web-relay/steps/rollback'"))
})

// ---- v3.8 Step2：GC 定时化（保留 finalize 触发语义）----
test('gcScheduleMs：周期解析（默认 600000 / 0 与非法关闭 / 上限 24h）', () => {
  assert.equal(gcScheduleMs(undefined), 0)          // 无 env → 0？不：index 侧传默认 600000；纯函数对 undefined 视为禁用
  assert.equal(gcScheduleMs('600000'), 600000)
  assert.equal(gcScheduleMs(600000), 600000)
  assert.equal(gcScheduleMs('0'), 0)                // 显式 0 → 关闭定时（仅 finalize 触发）
  assert.equal(gcScheduleMs(0), 0)
  assert.equal(gcScheduleMs(-1), 0)                 // 负值 → 关闭
  assert.equal(gcScheduleMs('abc'), 0)              // 非法 → 关闭
  assert.equal(gcScheduleMs(null), 0)
  assert.equal(gcScheduleMs(1000), 1000)
  assert.equal(gcScheduleMs(25 * 60 * 60 * 1000), 24 * 60 * 60 * 1000) // 超上限截断 24h
})

test('source 标记：GC 定时化挂载（lib/index.js 定时器 + shadow-gate gcScheduleMs，v3.8 Step2）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const sg = fs.readFileSync(new URL('../lib/shadow-gate.js', import.meta.url), 'utf8')
  assert.ok(src.includes('scheduledGcTimer'))
  assert.ok(src.includes('DSH_RELAY_GC_MS'))
  assert.ok(src.includes('定时 Shadow GC 已启用'))
  assert.ok(sg.includes('gcScheduleMs'))
  assert.ok(sg.includes('v3.8 Step2'))
})

// ---- v3.9 Step1：repoPath 自持回退（lib/ 上溯），不再依赖 DSH_RELAY_REPO_PATH ----
test('shadowRepoCandidates：候选顺序固定为 base → payload.repoPath → env.DSH_RELAY_REPO_PATH → env.DSH_RELAY_REPO → moduleDir', () => {
  const cands = shadowRepoCandidates({
    base: NON_REPO,
    payload: { repoPath: '/p' },
    env: { DSH_RELAY_REPO_PATH: '/e1', DSH_RELAY_REPO: '/e2' },
    moduleDir: '/m'
  })
  assert.deepEqual(cands, [NON_REPO, '/p', '/e1', '/e2', '/m'])
})

test('resolveShadowRepo：候选优先级——payload.repoPath 优先于 env（两者都可用时取 payload）', () => {
  const got = resolveShadowRepo({ base: NON_REPO, payload: { repoPath: REAL_REPO_ROOT }, env: { DSH_RELAY_REPO_PATH: '/__nowhere_env1__', DSH_RELAY_REPO: '/__nowhere_env2__' } })
  assert.equal(got, REAL_REPO_ROOT)
})

test('resolveShadowRepo：候选优先级——env.DSH_RELAY_REPO_PATH 优先于 env.DSH_RELAY_REPO（payload 缺省时）', () => {
  const got = resolveShadowRepo({ base: NON_REPO, payload: {}, env: { DSH_RELAY_REPO_PATH: REAL_REPO_ROOT, DSH_RELAY_REPO: '/__nowhere_env2__' } })
  assert.equal(got, REAL_REPO_ROOT)
})

test('resolveShadowRepo：**无 env** + base 非 git 工作区，仍能靠 moduleDir（lib/ 上溯）解析出仓库根', () => {
  const got = resolveShadowRepo({ base: NON_REPO, payload: {}, env: {} })
  assert.equal(got, REAL_REPO_ROOT)
  assert.ok(typeof got === 'string' && got.length > 0)
})

test('resolveShadowRepo：全部来源不可用 → null（不得凭空构造路径）', () => {
  const nowhere = process.platform === 'win32' ? 'D:\\__nowhere__' : '/__nowhere__'
  const got = resolveShadowRepo({ base: nowhere, payload: {}, env: {}, moduleDir: nowhere })
  assert.equal(got, null)
})

test('定时 GC 门槛：resolveShadowRepo 在无 env（启动期调用形状 base=null,payload={}）时也应解析出仓库根 → gcRepo 真值，定时器应启用', () => {
  const gcRepo = resolveShadowRepo({ base: null, payload: {}, env: {} })
  assert.equal(gcRepo, REAL_REPO_ROOT)
  assert.ok(Boolean(gcRepo)) // 与 lib/index.js 的 `gcMs > 0 && gcRepo` 门槛条件一致——无 env 也应为真
})
