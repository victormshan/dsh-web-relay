// 取证：文档章节全量 + 编码通道路径上的实现文件与其契约
import fs from 'node:fs';

const REPO = 'D:\\dsh-web-relay';
const WORK = 'D:\\dsh relay test';

console.log('=== CC-HYBRID.md 章节 ===');
const doc = fs.readFileSync(REPO + '\\docs\\CC-HYBRID.md', 'utf8').split(/\r?\n/);
for (let i = 0; i < doc.length; i++) {
  if (/^#{2,3}\s/.test(doc[i])) console.log(`  L${String(i + 1).padStart(4)}  ${doc[i].trim().slice(0, 92)}`);
}

console.log('\n=== 编码通道路径上的脚本（D:\\dsh relay test）===');
for (const f of fs.readdirSync(WORK)) {
  if (/^(cc-|verify-cc|protocol-|deliver-)/.test(f) && /\.(mjs|sh|cmd)$/.test(f)) {
    const st = fs.statSync(WORK + '\\' + f);
    console.log(`  ${f.padEnd(30)} ${String(st.size).padStart(7)} B`);
  }
}

console.log('\n=== 各脚本的用途行（文件头第一行注释）===');
for (const f of ['cc-dispatch.mjs', 'verify-cc-task.mjs', 'cc-chain.mjs', 'protocol-close-step.mjs']) {
  const p = WORK + '\\' + f;
  if (!fs.existsSync(p)) { console.log(`  ${f}: (不存在)`); continue; }
  const head = fs.readFileSync(p, 'utf8').split(/\r?\n/).slice(0, 3).map((l) => l.trim()).filter(Boolean);
  console.log(`  ${f}:`);
  head.forEach((l) => console.log(`      ${l.slice(0, 108)}`));
}

console.log('\n=== WSL 侧守护与执行器（D:\\cc-tasks）===');
for (const f of ['cc-watchdog.sh', 'runner.sh']) {
  const head = fs.readFileSync('D:\\cc-tasks\\' + f, 'utf8').split(/\r?\n/).slice(0, 6).map((l) => l.trim()).filter(Boolean);
  console.log(`  ${f}:`);
  head.forEach((l) => console.log(`      ${l.slice(0, 108)}`));
}

console.log('\n=== 三方角色与降级链（lib/index.js 内自述，抽取关键两行）===');
const idx = fs.readFileSync(REPO + '\\lib\\index.js', 'utf8').split(/\r?\n/);
for (const n of [165, 166, 167]) {
  const l = idx[n - 1];
  if (l) console.log(`  L${n}: ${l.trim().slice(0, 240)}`);
}
