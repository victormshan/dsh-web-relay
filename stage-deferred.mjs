// 延迟派发暂存器：构建 task.json → v2 门控校验 → 写入 D:\cc-tasks\deferred\（不直接入队）
// 用途：配额耗尽期间先暂存，由 deferred-dispatch.ps1 在通道恢复后自动入队。
// 用法: node stage-deferred.mjs <specModule.mjs>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const specPath = process.argv[2];
if (!specPath) { console.error('usage: node stage-deferred.mjs <specModule.mjs>'); process.exit(2); }

const mod = await import(pathToFileURL(specPath).href);
const spec = mod.task ?? mod.default;
const CC_ROOT = 'D:\\cc-tasks';
const VALIDATOR = 'D:\\dsh-web-relay\\scripts\\task-schema-cli.mjs';
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
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
if (Array.isArray(spec.expectArtifacts) && spec.expectArtifacts.length) task.expectArtifacts = spec.expectArtifacts;
if (typeof spec.acceptanceScript === 'string' && spec.acceptanceScript.trim()) task.acceptanceScript = spec.acceptanceScript;

const staging = path.join(CC_ROOT, `staging-${taskId}.json`);
fs.writeFileSync(staging, JSON.stringify(task, null, 2), 'utf8');
console.log(`[spec] taskId=${taskId} kind=${task.kind} prompt=${task.prompt.length}字符`);

const v = spawnSync(process.execPath, [VALIDATOR, 'validate-task', staging], { encoding: 'utf8' });
console.log('[gate] ' + (v.stdout || '').trim().replace(/\s+/g, ' '));
if (v.status !== 0) { console.error('[gate] 预检未通过，未暂存'); process.exit(1); }

// 编码自检：分段检测双重编码（与 cc-dispatch.mjs 同判据），命中则拒绝暂存
const mojibakeHit = (() => {
  const runs = task.prompt.match(/[\u0080-\u00ff]{4,}/g) || [];
  for (const run of runs) {
    const decoded = Buffer.from(run, 'latin1').toString('utf8');
    if (!decoded.includes('\ufffd') && /[\u4e00-\u9fff]/.test(decoded)) return run.slice(0, 12);
  }
  return null;
})();
if (mojibakeHit) { console.error(`[gate] prompt 疑似双重编码（片段 ${JSON.stringify(mojibakeHit)}），拒绝暂存`); process.exit(1); }
console.log('[gate] 编码自检通过（无双重编码特征）');

const dir = path.join(CC_ROOT, 'deferred');
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, `${taskId}.task.json`);
fs.renameSync(staging, target);
console.log('[deferred] ' + target);
