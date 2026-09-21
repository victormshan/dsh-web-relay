// 设计2 spec 不变量校验（脚本文件形式，避免 shell 吃掉中文引号/反引号）
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const WORK = 'D:\\dsh relay test';
const N = 8;
const fails = [];
const ok = (name, cond, detail = '') => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ' — ' + detail}`); if (!cond) fails.push(name); };

const files = [];
for (let r = 1; r <= N; r++) {
  const t = String(r).padStart(2, '0');
  files.push({ arm: 'P', file: `cc-specs/exec-p${t}.mjs` });
  files.push({ arm: 'E', file: `cc-specs/exec-e${t}.mjs` });
}

let badSyntax = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f.file], { cwd: WORK, encoding: 'utf8' });
  if (r.status !== 0) { badSyntax++; console.log('      ✗ ' + f.file); }
}
ok('16 份 spec 语法全部通过', badSyntax === 0, `失败 ${badSyntax}`);

const loaded = [];
for (const f of files) {
  const m = await import(`file:///${(WORK + '\\' + f.file).replace(/\\/g, '/')}`);
  loaded.push({ ...f, prompt: m.task.prompt, taskId: m.task.taskId });
}
const pP = loaded.filter((x) => x.arm === 'P').map((x) => x.prompt);
const pE = loaded.filter((x) => x.arm === 'E').map((x) => x.prompt);
ok('P 各轮 prompt 逐字节相同', new Set(pP).size === 1, `去重后 ${new Set(pP).size}`);
ok('E 各轮 prompt 逐字节相同', new Set(pE).size === 1, `去重后 ${new Set(pE).size}`);

const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return a.slice(0, i); };
const pref = commonPrefix(pP[0], pE[0]);
ok('两臂共通前缀够长（差异只在协议段）', pref.length > 2000, `共通前缀 ${pref.length}；P=${pP[0].length} E=${pE[0].length}`);
ok('共通前缀含三案例源码', /collectChanged/.test(pref) && /loadChainState/.test(pref) && /decideRedispatch/.test(pref));

ok('E 协议要求可执行复现脚本', /可执行的 Node\.js 复现脚本/.test(pE[0]));
ok('P 协议不含该要求（散文）', /散文/.test(pP[0]) && !/可执行的 Node\.js 复现脚本/.test(pP[0]));
ok('两臂都要求保持导出名', /保持原有导出名/.test(pP[0]) && /保持原有导出名/.test(pE[0]));
ok('两臂都要求写 done.flag', /done\.flag/.test(pP[0]) && /done\.flag/.test(pE[0]));

// ground truth 不得泄漏：这些词只应存在于我的探针/参考修复里。
// 注意：`readFileSync` 是**案例1 bug 源码本身**的一部分（bug 必须给 cc 看），不属泄漏——上一版把它当泄漏是检查词选错。
const LEAK = ['uall', 'EISDIR', 'untracked-files', 'statSync', 'isFile', 'failCount'];
const leaked = LEAK.filter((k) => pP[0].includes(k) || pE[0].includes(k));
ok('ground truth/修复手法未泄漏进 prompt', leaked.length === 0, `泄漏: ${leaked.join(', ')}`);

const chainSrc = fs.readFileSync(WORK + '\\cc-chains\\v8-exec.mjs', 'utf8');
const specs = [...chainSrc.matchAll(/spec: '([^']+)'/g)].map((m) => m[1]);
const ids = [...chainSrc.matchAll(/taskId: '([^']+)'/g)].map((m) => m[1]);
ok('链条条目数 = 16', specs.length === 16, `实际 ${specs.length}`);
ok('链条引用的 spec 全部存在', specs.every((s) => fs.existsSync(WORK + '\\' + s.replace(/\//g, '\\'))));
ok('链条 taskId 唯一', new Set(ids).size === ids.length, `${ids.length} 个`);
ok('链条交错排列（P,E,P,E…）', /P 第 1 轮[\s\S]*E 第 1 轮[\s\S]*P 第 2 轮/.test(chainSrc));

console.log(`\n  RESULT: ${fails.length ? 'FAIL（' + fails.length + ' 项）' : 'PASS'}`);
process.exit(fails.length ? 1 : 0);
