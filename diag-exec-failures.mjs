// 诊断：把某轮候选修复抽出来，逐条看探针为何失败（区分"模型没修好"与"我的探针要求了没写进题面的东西"）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CC = 'D:\\cc-tasks';
const WORK = 'D:\\dsh relay test';
const picks = [['P', '01', 1], ['P', '01', 3], ['E', '01', 1], ['E', '01', 3]];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
for (const [arm, round, caseId] of picks) {
  const id = `ccexec-20260917-${arm.toLowerCase()}${round}`;
  const rp = path.join(CC, 'tasks', id, 'out', 'report.md');
  if (!fs.existsSync(rp)) { console.log(`  ${id} 报告缺失`); continue; }
  const t = fs.readFileSync(rp, 'utf8');
  const b = t.indexOf(`===EXEC-FIX ${caseId} BEGIN===`);
  const e = t.indexOf(`===EXEC-FIX ${caseId} END===`);
  const src = t.slice(b + `===EXEC-FIX ${caseId} BEGIN===`.length, e).trim()
    .replace(/^```[a-zA-Z]*\s*\n/, '').replace(/\n```\s*$/, '').trim();
  const f = path.join(tmp, `${arm}${round}-c${caseId}.mjs`);
  fs.writeFileSync(f, src, 'utf8');
  console.log(`\n=== ${arm}${round} 案例${caseId}（源码 ${Buffer.byteLength(src, 'utf8')} 字节）===`);
  const r = spawnSync(process.execPath, [path.join(WORK, 'probes', 'run-probe.mjs'), String(caseId), f], { encoding: 'utf8' });
  console.log(`${r.stdout || ''}${r.stderr || ''}`.split('\n').filter((l) => /FAIL|RESULT/.test(l)).join('\n'));
  // 打印关键实现行，便于判断"是否只是接口没猜中"
  const keys = caseId === 1 ? /slice\(|statSync|isFile|-uall|filter|readFileSync/
    : /failCount|attempts|failures|retry|count|stop|maxAttempts/;
  console.log('  --- 关键实现行 ---');
  for (const line of src.split('\n')) if (keys.test(line)) console.log('    ' + line.trim().slice(0, 130));
}
fs.rmSync(tmp, { recursive: true, force: true });
