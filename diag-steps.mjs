// 诊断：expr steps.json 的字段与编码真相 + 记录文件对照
import fs from 'node:fs';

const stepsPath = String.raw`D:\dsh relay test\web-relay\experiments\expr-2026-09-13_17-36-07.steps.json`;
const recPath = String.raw`D:\dsh relay test\web-relay\experiments\dsh-web-relay-2026-09-13_17-36-07.md`;

const buf = fs.readFileSync(stepsPath);
const j = JSON.parse(buf.toString('utf8'));

console.log('顶层键 =', Object.keys(j).join(', '));
console.log('iterations =', j.iterations, '| autoDecision =', j.autoDecision, '| finalAcceptance =', j.finalAcceptance);
console.log('protocolVersion =', j.protocolVersion, '| rejectStreak =', j.rejectStreak, '| updatedAt =', j.updatedAt);
console.log('steps 数 =', (j.steps || []).length);
console.log('mtime =', fs.statSync(stepsPath).mtime.toISOString());

const title = j.steps?.[0]?.title ?? '';
console.log('title =', JSON.stringify(title));
// 双重编码检测：把 title 按 latin1 还原为字节再按 utf8 解码，若得到 CJK 则原文件是双重编码
const roundTrip = Buffer.from(title, 'latin1').toString('utf8');
const hasCjk = /[\u4e00-\u9fff]/.test(roundTrip);
console.log('latin1→utf8 还原 =', JSON.stringify(roundTrip.slice(0, 20)));
console.log('双重编码判定 =', hasCjk ? '是（文件内是 UTF-8 被当 latin1 再编码的产物）' : '否');

const i = buf.indexOf(Buffer.from('"title"'));
console.log('文件内 title 行原始字节 =', buf.subarray(i, i + 60).toString('hex'));

const rb = fs.readFileSync(recPath);
for (const probe of ['强化', '突破度']) {
  const k = rb.indexOf(Buffer.from(probe, 'utf8'));
  console.log(`记录 md 中 ${probe} 字节 =`, k >= 0 ? rb.subarray(k, k + probe.length * 3).toString('hex') : '(不存在)');
}
console.log('记录 md mtime =', fs.statSync(recPath).mtime.toISOString());
