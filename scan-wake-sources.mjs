// 干净扫描：① 证明新代码已生效（autoIterDeclAudit.source 只可能由 517b0fc 之后的新代码写出）
//          ② 找是否仍有「可能合法产生唤醒」的 expr（未归档 + status=open + 非 isTest）
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'D:\\dsh relay test\\web-relay\\experiments';
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.steps.json'));

const rows = [];
for (const f of files) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    rows.push({
      f, exprId: s.exprId, status: s.status, finalized: s.finalized === true,
      isTest: s.isTest === true, archived: !!s.archivedAt, step: s.currentStep,
      auditSource: s.autoIterDeclAudit ? s.autoIterDeclAudit.source : null,
      auditAt: s.autoIterDeclAudit ? s.autoIterDeclAudit.at : null,
      mtime: fs.statSync(path.join(DIR, f)).mtime.toISOString(),
    });
  } catch (e) { rows.push({ f, error: String(e.message).slice(0, 60) }); }
}

console.log(`扫描 ${files.length} 个 steps.json\n`);

console.log('=== ① 交付生效证据：autoIterDeclAudit.source ===');
const withAudit = rows.filter((r) => r.auditSource);
if (!withAudit.length) console.log('  （无）');
for (const r of withAudit) console.log(`  ${r.exprId}  source=${r.auditSource}  at=${r.auditAt}  bootId 之后的写入`);

console.log('\n=== ② 仍「可能合法产生唤醒」的 expr：未归档 + status=open + 非 isTest ===');
const live = rows.filter((r) => !r.archived && r.status === 'open' && !r.isTest);
if (!live.length) console.log('  （无）→ 不存在仍处活跃态、可合法产生 Step 唤醒的 expr');
else for (const r of live) console.log(`  ${r.exprId}  step=${r.step}  finalized=${r.finalized}  mtime=${r.mtime}`);

console.log('\n=== ③ 主 expr（陈旧唤醒所指对象）现况 ===');
const main = rows.find((r) => r.exprId === 'expr-2026-09-13_17-36-07');
console.log('  ' + JSON.stringify(main));

console.log('\n=== ④ 归档态统计 ===');
console.log(`  已归档(archivedAt) ${rows.filter((r) => r.archived).length} | isTest ${rows.filter((r) => r.isTest).length} | status=done ${rows.filter((r) => r.status === 'done').length} | status=open ${rows.filter((r) => r.status === 'open').length}`);