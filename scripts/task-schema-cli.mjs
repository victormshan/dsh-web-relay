#!/usr/bin/env node
// dsh-web-relay cc-task-schema v2 CLI（scripts/task-schema-cli.mjs）
// 用法：
//   node scripts/task-schema-cli.mjs validate-task <task.json>
//   node scripts/task-schema-cli.mjs validate-result <taskDir>   （校验 done.flag 根位置/result.json/expectArtifacts）
//   node scripts/task-schema-cli.mjs report <taskDir>
// exit code: 0 通过 / 1 校验失败 / 2 用法错误
import { readFileSync } from 'node:fs'
import { validateTask, validateResultText, validateResult } from '../lib/task-schema-v2.mjs'

const [, , cmd, target] = process.argv
function fail(msg, code = 2) { console.error(msg); process.exit(code) }
if (!cmd || !target) fail('用法: task-schema-cli.mjs validate-task <task.json> | validate-result <taskDir> | report <taskDir>')

const path = (await import('node:path')).default
// BOM 防御（PS5.1 写 UTF8 带 BOM 会破坏 JSON.parse——lesson 004）
const readJson = (p) => {
  let raw = readFileSync(p, 'utf8')
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
  return JSON.parse(raw)
}

if (cmd === 'validate-task') {
  let task
  try { task = readJson(target) } catch (e) { fail(`无法读取 task.json: ${e.message}`) }
  const r = validateTask(task)
  console.log(JSON.stringify({ cmd: 'validate-task', ok: r.ok, errors: r.errors }, null, 2))
  process.exit(r.ok ? 0 : 1)
} else if (cmd === 'validate-result' || cmd === 'report') {
  const taskDir = target
  const resultPath = path.join(taskDir, 'result.json')
  let task = {}
  try { task = readJson(path.join(taskDir, 'task.json')) } catch { /* task.json 可选 */ }
  // 读取 result.json（若存在）做文本校验提示
  let text = null
  try { text = readFileSync(resultPath, 'utf8'); if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1) } catch { /* pending */ }
  const textCheck = text ? validateResultText(text) : { ok: false, errors: ['result.json missing (pending?)'] }
  const r = await validateResult({ taskDir, task })
  const out = {
    cmd, ok: r.ok && textCheck.ok, taskDir,
    doneFlagAtRoot: r.details.doneFlagAtRoot,
    resultPending: r.details.resultPending,
    artifacts: r.details.artifacts,
    errors: [...r.errors, ...(textCheck.ok ? [] : textCheck.errors.filter(e => !r.errors.includes(e)))]
  }
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.ok ? 0 : 1)
} else {
  fail(`未知命令: ${cmd}`)
}
