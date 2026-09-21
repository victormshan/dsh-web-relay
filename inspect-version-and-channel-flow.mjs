// 取证：① 插件版本是否有变化 ② cc 编码通道在协议/混合架构中的流程与实现文件
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO = 'D:\\dsh-web-relay';
const git = (args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

console.log('=== ① 版本 ===');
const pkg = JSON.parse(fs.readFileSync(REPO + '\\package.json', 'utf8'));
console.log(`  仓库 package.json version = ${pkg.version}`);
console.log(`  仓库 HEAD = ${git(['rev-parse', '--short', 'HEAD'])}`);
console.log('  package.json 的提交历史（最近 8 次）：');
console.log('    ' + git(['log', '-8', '--format=%h %ad %s', '--date=short', '--', 'package.json']).split('\n').join('\n    '));

console.log('\n  本会话窗口内的提交（看有没有 version 变更）：');
const log = git(['log', '--format=%h|%ad|%s', '--date=format:%m-%d %H:%M', '-20']);
for (const l of log.split('\n')) {
  const [sha, date, ...rest] = l.split('|');
  const subj = rest.join('|');
  const touched = (() => { try { return git(['show', '--name-only', '--format=', sha]).split('\n').filter(Boolean); } catch { return []; } })();
  const vBump = touched.includes('package.json') ? '  ← 含 package.json' : '';
  console.log(`    ${sha} ${date} ${subj.slice(0, 62)}${vBump}`);
}

console.log('\n  运行时副本 version（宿主实际加载）：');
try {
  const rp = 'C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-web-relay\\package.json';
  console.log(`    ${JSON.parse(fs.readFileSync(rp, 'utf8')).version}`);
} catch (e) { console.log('    读不到: ' + e.message); }

console.log('\n  /health-check 自报 version：');
try {
  const h = await (await fetch('http://127.0.0.1:3080/dsh-web-relay/health-check')).json();
  console.log(`    ${h.version}  (bootId=${h.bootId})`);
} catch (e) { console.log('    失败: ' + e.message); }

console.log('\n=== ② 编码通道实现文件清单（D:\\cc-tasks）===');
for (const f of fs.readdirSync('D:\\cc-tasks')) {
  if (/\.(mjs|sh|cmd|json)$/.test(f) && !/^chain-state\.|^cc-quota-state|^_/.test(f)) {
    const st = fs.statSync('D:\\cc-tasks\\' + f);
    console.log(`  ${f.padEnd(28)} ${String(st.size).padStart(7)} B  ${st.mtime.toISOString().slice(5, 16)}`);
  }
}
console.log('  (子目录) ' + fs.readdirSync('D:\\cc-tasks', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).join(', '));

console.log('\n=== ③ 文档中编码通道/协作链的章节 ===');
const doc = fs.readFileSync(REPO + '\\docs\\CC-HYBRID.md', 'utf8').split(/\r?\n/);
doc.forEach((l, i) => { if (/^#{2,3}\s/.test(l)) console.log(`  L${String(i + 1).padStart(4)}  ${l.trim().slice(0, 88)}`); });
