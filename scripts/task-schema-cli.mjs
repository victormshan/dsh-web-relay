#!/usr/bin/env node
// dsh-web-relay cc-task-schema v2 CLI（scripts/task-schema-cli.mjs）
// 用法：
//   node scripts/task-schema-cli.mjs validate-task <task.json>
//   node scripts/task-schema-cli.mjs validate-result <taskDir>   （done.flag 根/result.json/expectArtifacts/acceptanceScript）
//   node scripts/task-schema-cli.mjs report <taskDir|parentDir>  （单任务，或父目录批量 JSON/Markdown 汇总）
//   node scripts/task-schema-cli.mjs recover <tasksParentDir>    （s2v5_1: watchdog 崩溃/重启恢复——悬挂任务补 result / 列 re-run）
//   node scripts/task-schema-cli.mjs invalid list|revalidate|recover|clean <ccTasksRoot> [file]
//       （s2v5_3: cc-watchdog REJECT 隔离（queue/.invalid/）人工复检闭环）
// exit code: 0 通过 / 1 校验失败 / 2 用法错误
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateTask, validateResultText, validateResult, runAcceptanceScript, classifyTaskRecovery, recoveryAction } from '../lib/task-schema-v2.mjs'

const [, , cmd, target] = process.argv
function fail(msg, code = 2) { console.error(msg); process.exit(code) }
if (!cmd || !target) fail('用法: task-schema-cli.mjs validate-task <task.json> | validate-result <taskDir> | report <taskDir|parentDir> | recover <tasksParentDir> | invalid list|revalidate|recover|clean <ccTasksRoot> [file]')

const path = (await import('node:path')).default
// acceptanceScript 脚本 token 形态的「仓库根」：本校验器所在仓库（dsh-web-relay）自身
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// BOM 防御（PS5.1 写 UTF8 带 BOM 会破坏 JSON.parse——lesson 004）
const readJson = (p) => {
  let raw = readFileSync(p, 'utf8')
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
  return JSON.parse(raw)
}

// 校验单任务目录 → { ok, errors, details, acceptance? }
async function checkTaskDir(taskDir) {
  const resultPath = path.join(taskDir, 'result.json')
  let task = {}
  try { task = readJson(path.join(taskDir, 'task.json')) } catch { /* task.json 可选 */ }
  let text = null
  try { text = readFileSync(resultPath, 'utf8'); if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1) } catch { /* pending */ }
  const textCheck = text ? validateResultText(text) : { ok: false, errors: ['result.json missing (pending?)'] }
  const r = await validateResult({ taskDir, task })
  // s2v2_3: acceptanceScript 内联执行（task.acceptanceScript 存在 → runAcceptanceScript）
  // 结局三分：ok / fail（产物不合格，探针跑完给出否定）/ instrument（工具错误：文件缺失/超时/无法启动）
  // 错误文本自带 [acceptance-script][FAIL] 或 [acceptance-script][INSTRUMENT] 标记，此处不再二次加前缀。
  let acceptance = null
  if (typeof task.acceptanceScript === 'string' && task.acceptanceScript.trim()) {
    acceptance = runAcceptanceScript({ script: task.acceptanceScript, cwd: taskDir, taskId: task.taskId, repoRoot: REPO_ROOT })
  }
  const errors = [...r.errors, ...(textCheck.ok ? [] : textCheck.errors.filter(e => !r.errors.includes(e)))]
  const ok = r.ok && textCheck.ok && (!acceptance || acceptance.ok)
  if (acceptance && !acceptance.ok) errors.push(acceptance.error)
  return {
    taskDir, ok, errors,
    doneFlagAtRoot: r.details.doneFlagAtRoot,
    resultErrorCode: r.details.resultErrorCode ?? null,
    doneFlagErrorCode: r.details.doneFlagErrorCode ?? null,
    resultPending: r.details.resultPending,
    artifacts: r.details.artifacts,
    acceptance: acceptance ? { ok: acceptance.ok, kind: acceptance.kind, error: acceptance.error || null } : null
  }
}

// s2v5_2: 把单任务校验结果归类为一眼可读的状态（done/pending/failed）
//   done    = 全部通过（ok）
//   pending = result.json 缺失（执行中/未落盘——watchdog 重启恢复场景）
//   failed  = 结构/产物校验失败（含 misplaced/missing/errorCode 违例）
function classifyRowStatus(r) {
  if (r.ok) return 'done'
  if (r.resultPending) return 'pending'
  return 'failed'
}

// s2v5_2: report 分组汇总——各状态计数 + 每组首个问题原因（一眼可读，不淹没在长 JSON 里）
function buildSummary(results) {
  const groups = { done: [], pending: [], failed: [] }
  for (const r of results) groups[classifyRowStatus(r)].push(r)
  const firstIssue = (list) => {
    if (!list.length) return null
    const r = list[0]
    return {
      task: path.basename(r.taskDir),
      ok: r.ok,
      resultErrorCode: r.resultErrorCode ?? null,
      doneFlagErrorCode: r.doneFlagErrorCode ?? null,
      firstError: (r.errors && r.errors[0]) || null,
    }
  }
  return {
    total: results.length,
    done: groups.done.length,
    pending: groups.pending.length,
    failed: groups.failed.length,
    okAll: results.every((r) => r.ok),
    firstPending: firstIssue(groups.pending),
    firstFailed: firstIssue(groups.failed),
  }
}

if (cmd === 'validate-task') {
  let task
  try { task = readJson(target) } catch (e) { fail(`无法读取 task.json: ${e.message}`) }
  const r = validateTask(task)
  console.log(JSON.stringify({ cmd: 'validate-task', ok: r.ok, errors: r.errors }, null, 2))
  process.exit(r.ok ? 0 : 1)
} else if (cmd === 'validate-result') {
  const out = await checkTaskDir(target)
  console.log(JSON.stringify({ cmd, ...out }, null, 2))
  process.exit(out.ok ? 0 : 1)
} else if (cmd === 'report') {
  // 单任务 or 父目录批量
  const isTaskDir = existsSync(path.join(target, 'task.json'))
  const dirs = isTaskDir ? [target] : readdirSync(target).filter((d) => existsSync(path.join(target, d, 'task.json'))).map((d) => path.join(target, d))
  if (dirs.length === 0) fail(`无任务目录: ${target}`)
  const results = []
  for (const d of dirs) results.push(await checkTaskDir(d))
  const okAll = results.every((r) => r.ok)
  // s2v5_2: 分组汇总（done/pending/failed + 首条问题）——一眼可读；--verbose 保留完整 results
  const summary = buildSummary(results)
  const verbose = process.argv.includes('--verbose')
  const md = [
    '# cc-task-schema v2 report',
    '',
    `> mixed 汇总：total=${summary.total} · done=${summary.done} · pending=${summary.pending} · failed=${summary.failed}${okAll ? ' · ✅ 全部通过' : ''}`,
    '',
    `| task | status | resultErrorCode | doneFlagErrorCode | artifacts |`,
    '|---|---|---|---|---|',
  ]
  for (const r of results) {
    md.push(`| ${path.basename(r.taskDir)} | ${classifyRowStatus(r)} | ${r.resultErrorCode || '-'} | ${r.doneFlagErrorCode || '-'} | ${(r.artifacts || []).map((a) => `${a.name}:${a.exists ? '✓' : '✗'}`).join(' ') || '-'} |`)
  }
  const payload = { cmd: 'report', ok: okAll, count: results.length, summary, ...(verbose ? { results } : {}) }
  const fmt = process.argv[4] === 'md' ? md.join('\n') : JSON.stringify(payload, null, 2)
  console.log(fmt)
  process.exit(okAll ? 0 : 1)
} else if (cmd === 'recover') {
  // s2v5_1: watchdog 崩溃/重启恢复——扫描 tasks/ 下悬挂任务，执行恢复动作：
  //   done + needsResultWrite → 补写 result.json（runner 写 result 前被杀）
  //   in-progress → 列出待 re-run（调用方重派 runner）
  //   failed → 原样保留（不误改）
  const { promises: fsp } = await import('node:fs')
  const isTaskDir = existsSync(path.join(target, 'task.json'))
  const dirs = isTaskDir ? [target] : readdirSync(target).filter((d) => existsSync(path.join(target, d, 'task.json'))).map((d) => path.join(target, d))
  if (dirs.length === 0) fail(`无任务目录: ${target}`)
  const recovered = []
  const rerun = []
  const untouched = []
  for (const d of dirs) {
    let task = {}
    try { task = readJson(path.join(d, 'task.json')) } catch { /* task.json 缺失 → 无法恢复，跳过 */ }
    const cls = await classifyTaskRecovery({ taskDir: d, task })
    const action = recoveryAction(cls)
    if (action === 'write-result') {
      // 补写 result.json：终态由根 done.flag 决定（契约完成），恢复 runner 被杀中断的收尾
      const resultJson = JSON.stringify({ status: 'done', recovered: true, at: new Date().toISOString(), reason: 'done.flag at root, result.json missing (runner killed) — recovered by watchdog' }, null, 2)
      writeFileSync(path.join(d, 'result.json'), resultJson, 'utf8')
      recovered.push({ taskDir: d, state: cls.state, action })
    } else if (action === 're-run') {
      rerun.push({ taskDir: d, state: cls.state, action })
    } else {
      untouched.push({ taskDir: d, state: cls.state, action, reasons: cls.reasons })
    }
  }
  console.log(JSON.stringify({ cmd: 'recover', recovered, rerun, untouched, summary: { recovered: recovered.length, rerun: rerun.length, untouched: untouched.length } }, null, 2))
  process.exit(0)
} else if (cmd === 'invalid') {
  // s2v5_3: cc-watchdog REJECT 隔离（queue/.invalid/）人工复检闭环
  //   invalid list <ccTasksRoot>                       → 列出隔离任务 + reject 原因（validate-task 重放）
  //   invalid revalidate <ccTasksRoot> <file>          → 修复后重跑 validate-task（exit 0=可恢复）
  //   invalid approve <ccTasksRoot> <file>             → 人工确认废弃 → 打 approved 标记（幂等）
  //   invalid recover <ccTasksRoot> <file>             → revalidate 通过 → 移回 queue/（重新入队）
  //   invalid clean <ccTasksRoot> [file]               → 仅删除已 approved 标记的隔离任务；未 approved 拒删
  // argv: [node, cli, 'invalid', <sub>, <ccRoot>, <file>]
  const sub = target
  const ccRoot = process.argv[4]
  if (!['list', 'revalidate', 'approve', 'recover', 'clean'].includes(sub) || !ccRoot) {
    fail('用法: task-schema-cli.mjs invalid list|revalidate|approve|recover|clean <ccTasksRoot> [file]')
  }
  const invalidDir = path.join(ccRoot, 'queue', '.invalid')
  if (!existsSync(invalidDir)) fail(`隔离目录不存在: ${invalidDir}`)
  const invalidFiles = () => readdirSync(invalidDir).filter((f) => f.endsWith('.task.json')).sort()
  const approvedMark = (f) => path.join(invalidDir, f + '.approved')
  const readTask = (f) => { try { return readJson(path.join(invalidDir, f)) } catch { return null } }
  const taskIdOf = (t) => (t && typeof t.taskId === 'string' ? t.taskId : path.basename(f).replace(/\.\d+\.task\.json$/, '').replace(/\.task\.json$/, ''))

  if (sub === 'list') {
    const rows = invalidFiles().map((f) => {
      const t = readTask(f)
      const v = t ? validateTask(t) : { ok: false, errors: ['task.json 无法解析'] }
      return {
        file: f, approved: existsSync(approvedMark(f)),
        taskId: t && t.taskId ? t.taskId : null,
        validNow: v.ok, rejectReason: v.errors.slice(0, 3),
      }
    })
    console.log(JSON.stringify({ cmd: 'invalid list', ccRoot, count: rows.length, rows }, null, 2))
    process.exit(0)
  }

  const file = process.argv[5]

  if (sub === 'revalidate' || sub === 'approve' || sub === 'recover') {
    if (!file) fail('缺少隔离文件名（invalid list 可查看）')
    if (!invalidFiles().includes(file)) fail(`隔离文件不存在: ${file}`)
  }

  if (sub === 'revalidate') {
    const t = readTask(file)
    const v = t ? validateTask(t) : { ok: false, errors: ['task.json 无法解析'] }
    console.log(JSON.stringify({ cmd: 'invalid revalidate', file, ok: v.ok, errors: v.errors.slice(0, 5) }, null, 2))
    process.exit(v.ok ? 0 : 1)
  }

  if (sub === 'approve') {
    const mark = approvedMark(file)
    if (!existsSync(mark)) writeFileSync(mark, `approved ${new Date().toISOString()}\n`, 'utf8')
    console.log(JSON.stringify({ cmd: 'invalid approve', file, approved: true }, null, 2))
    process.exit(0)
  }

  if (sub === 'recover') {
    const t = readTask(file)
    const v = t ? validateTask(t) : { ok: false, errors: ['task.json 无法解析'] }
    if (!v.ok) {
      console.log(JSON.stringify({ cmd: 'invalid recover', file, ok: false, errors: v.errors.slice(0, 5), hint: '先修复 task.json 字段再 recover（或 approve 废弃）' }, null, 2))
      process.exit(1)
    }
    // 防覆盖：queue 中已有同名 taskId（新任务在排）→ 拒绝
    const q = path.join(ccRoot, 'queue')
    if (!existsSync(q)) fail(`queue 目录不存在: ${q}`)
    const tid = taskIdOf(t)
    const dest = path.join(q, `${tid}.task.json`)
    if (existsSync(dest)) {
      console.log(JSON.stringify({ cmd: 'invalid recover', file, ok: false, error: `queue 已存在 ${tid}.task.json（新任务在排）——先处理冲突` }, null, 2))
      process.exit(1)
    }
    const src = path.join(invalidDir, file)
    writeFileSync(dest, readFileSync(src, 'utf8'), 'utf8')
    unlinkSync(src)
    if (existsSync(approvedMark(file))) unlinkSync(approvedMark(file))
    console.log(JSON.stringify({ cmd: 'invalid recover', file, ok: true, restoredTo: dest }, null, 2))
    process.exit(0)
  }

  if (sub === 'clean') {
    // 无 file（undefined）→ 清理全部已 approved；有 file → 仅该文件（未 approved 拒删）
    const all = invalidFiles()
    const targets = !file ? all : (all.includes(file) ? [file] : [])
    if (!file && !targets.length) fail(`隔离目录为空: ${invalidDir}`)
    if (file && !targets.length) fail(`隔离文件不存在: ${file}`)
    const deleted = []
    const refused = []
    for (const f of targets) {
      if (existsSync(approvedMark(f))) {
        unlinkSync(path.join(invalidDir, f))
        if (existsSync(approvedMark(f))) unlinkSync(approvedMark(f))
        deleted.push(f)
      } else {
        refused.push(f)
      }
    }
    console.log(JSON.stringify({ cmd: 'invalid clean', deleted, refused, hint: refused.length ? '未 approved 的任务需先 invalid approve 确认废弃（或 invalid recover 修复重入队）' : '' }, null, 2))
    process.exit(refused.length ? 1 : 0)
  }
} else {
  fail(`未知命令: ${cmd}`)
}
