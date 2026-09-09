#!/usr/bin/env node
// dsh-web-relay cc-task-schema v2 CLI（scripts/task-schema-cli.mjs）
// 用法：
//   node scripts/task-schema-cli.mjs validate-task <task.json>
//   node scripts/task-schema-cli.mjs validate-result <taskDir>   （done.flag 根/result.json/expectArtifacts/acceptanceScript）
//   node scripts/task-schema-cli.mjs report <taskDir|parentDir>  （单任务，或父目录批量 JSON/Markdown 汇总）
// exit code: 0 通过 / 1 校验失败 / 2 用法错误
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { validateTask, validateResultText, validateResult, runAcceptanceScript } from '../lib/task-schema-v2.mjs'

const [, , cmd, target] = process.argv
function fail(msg, code = 2) { console.error(msg); process.exit(code) }
if (!cmd || !target) fail('用法: task-schema-cli.mjs validate-task <task.json> | validate-result <taskDir> | report <taskDir|parentDir>')

const path = (await import('node:path')).default
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
  let acceptance = null
  if (typeof task.acceptanceScript === 'string' && task.acceptanceScript.trim()) {
    acceptance = runAcceptanceScript({ script: task.acceptanceScript, cwd: taskDir })
  }
  const errors = [...r.errors, ...(textCheck.ok ? [] : textCheck.errors.filter(e => !r.errors.includes(e)))]
  const ok = r.ok && textCheck.ok && (!acceptance || acceptance.ok)
  if (acceptance && !acceptance.ok) errors.push(`[acceptance-script] ${acceptance.error}`)
  return {
    taskDir, ok, errors,
    doneFlagAtRoot: r.details.doneFlagAtRoot,
    resultErrorCode: r.details.resultErrorCode ?? null,
    doneFlagErrorCode: r.details.doneFlagErrorCode ?? null,
    resultPending: r.details.resultPending,
    artifacts: r.details.artifacts,
    acceptance: acceptance ? { ok: acceptance.ok, error: acceptance.error || null } : null
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
  const md = ['# cc-task-schema v2 report', '', `| task | status | resultErrorCode | doneFlagErrorCode | artifacts |`, '|---|---|---|---|---|']
  for (const r of results) {
    md.push(`| ${path.basename(r.taskDir)} | ${r.ok ? 'OK' : 'FAIL'} | ${r.resultErrorCode || '-'} | ${r.doneFlagErrorCode || '-'} | ${(r.artifacts || []).map((a) => `${a.name}:${a.exists ? '✓' : '✗'}`).join(' ') || '-'} |`)
  }
  const fmt = process.argv[4] === 'md' ? md.join('\n') : JSON.stringify({ cmd: 'report', ok: okAll, count: results.length, results }, null, 2)
  console.log(fmt)
  process.exit(okAll ? 0 : 1)
} else {
  fail(`未知命令: ${cmd}`)
}
