// cc 任务派发器：读 JS 规格模块 → 构建 task.json（node 序列化）→ v2 门控预检 → 入队。
// 用法: node cc-dispatch.mjs <specModule.mjs>
// spec 模块需默认导出（或具名 export const task）一个对象：
//   { taskId?, kind, title, prompt, refs?, acceptance, expectArtifacts?, outputDir?, acceptanceScript? }
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: node cc-dispatch.mjs <specModule.mjs>');
  process.exit(2);
}

// 规格前置检查：模板字面量未转义反引号 / 嵌套 ${} 会让 import 直接崩（本会话已踩 4 次），
// 这里先做 node --check 给出可读诊断，避免把一个坏规格带进稀缺的额度窗口。
const specCheck = spawnSync(process.execPath, ['--check', specPath], { encoding: 'utf8' });
if (specCheck.status !== 0) {
  console.error('[gate] 规格语法检查失败：' + specPath);
  console.error('  常见原因：prompt 模板字面量里出现未转义的反引号，或嵌套 ${...} 被当表达式求值。');
  console.error('  ' + String(specCheck.stderr || '').split('\n').slice(0, 5).join('\n  '));
  process.exit(1);
}

const mod = await import(pathToFileURL(specPath).href);
const spec = mod.task ?? mod.default;
if (!spec || typeof spec !== 'object') {
  console.error('spec 模块必须导出 task（或 default）对象');
  process.exit(2);
}

const CC_ROOT = 'D:\\cc-tasks';
const VALIDATOR = 'D:\\dsh-web-relay\\scripts\\task-schema-cli.mjs';
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
const taskId = spec.taskId ?? `cc-${stamp}`;

const task = {
  taskId,
  kind: spec.kind ?? 'implement',
  title: spec.title ?? '',
  refs: Array.isArray(spec.refs) ? spec.refs : [],
  acceptance: spec.acceptance ?? '',
  prompt: spec.prompt ?? '',
  outputDir: spec.outputDir ?? 'out',
};
if (Array.isArray(spec.expectArtifacts) && spec.expectArtifacts.length) {
  task.expectArtifacts = spec.expectArtifacts;
}
if (typeof spec.acceptanceScript === 'string' && spec.acceptanceScript.trim()) {
  task.acceptanceScript = spec.acceptanceScript;
}

const staging = path.join(CC_ROOT, `staging-${taskId}.json`);
const queued = path.join(CC_ROOT, 'queue', `${taskId}.task.json`);
if (fs.existsSync(queued)) {
  console.error(`已存在同名任务，拒绝重复派发: ${queued}`);
  process.exit(1);
}

fs.writeFileSync(staging, JSON.stringify(task, null, 2), 'utf8');
console.log(`[spec] taskId=${taskId} kind=${task.kind} prompt=${task.prompt.length}字符 artifacts=${(task.expectArtifacts || []).join(',') || '(无)'}`);

// 编码自检（防 L-2026-0914-061：PowerShell 转写造成 UTF-8 双重编码污染 prompt 并写坏权威状态）
// 判据：分段检测——对每段 ≥4 个连续 Latin-1 高位字符做 latin1→utf8 尝试，若解出 CJK 且无替换字符则判为双重编码。
// （整串 round-trip 会被混入的真中文/Latin-1 干扰；分段可同时覆盖「整串乱码」与「中文+乱码混合」两种情形）
const mojibakeHit = (() => {
  const runs = task.prompt.match(/[\u0080-\u00ff]{4,}/g) || [];
  for (const run of runs) {
    const decoded = Buffer.from(run, 'latin1').toString('utf8');
    if (!decoded.includes('\ufffd') && /[\u4e00-\u9fff]/.test(decoded)) return run.slice(0, 12);
  }
  return null;
})();
if (mojibakeHit) {
  console.error(`[gate] prompt 疑似双重编码（片段 ${JSON.stringify(mojibakeHit)} 可还原为中文），拒绝入队。staging 保留在: ` + staging);
  process.exit(1);
}
console.log('[gate] 编码自检通过（无双重编码特征）');

const v = spawnSync(process.execPath, [VALIDATOR, 'validate-task', staging], { encoding: 'utf8' });
const out = (v.stdout || '').trim();
console.log('[gate] ' + out.replace(/\s+/g, ' '));
if (v.status !== 0) {
  console.error('[gate] 预检未通过，未入队。staging 保留在: ' + staging);
  process.exit(1);
}

fs.mkdirSync(path.join(CC_ROOT, 'queue'), { recursive: true });
fs.renameSync(staging, queued);
console.log('[queued] ' + queued);
console.log('[next] 监控: D:\\cc-tasks\\tasks\\' + taskId + '\\result.json');
