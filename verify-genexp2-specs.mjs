// 第二轮 spec 的不变量校验（脚本文件形式，避免 shell 转义吃掉反引号）
// ① 16 份 spec 语法可解析且可 import；② 同臂各轮 prompt 逐字节相同；
// ③ 两臂协议前共通段逐字节相同；④ prompt 内的代码片段（反引号内容）**必须完整保留**（转义不能吃掉它）；
// ⑤ 链条引用的 spec 均存在、taskId 唯一、条目数正确。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const WORK = 'D:\\dsh relay test';
const N = 8;
const fails = [];
const ok = (name, cond, detail = '') => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ' — ' + detail}`); if (!cond) fails.push(name); };

const specs = [];
for (let r = 1; r <= N; r++) {
  const t = String(r).padStart(2, '0');
  specs.push({ arm: 'S', round: r, file: `cc-specs/genexp2-s${t}.mjs` });
  specs.push({ arm: 'D', round: r, file: `cc-specs/genexp2-d${t}.mjs` });
}

// ① 语法
let badSyntax = 0;
for (const s of specs) {
  const r = spawnSync(process.execPath, ['--check', s.file], { cwd: WORK, encoding: 'utf8' });
  if (r.status !== 0) { badSyntax++; console.log(`      ✗ ${s.file}: ${(r.stderr || '').split('\n')[1] || ''}`); }
}
ok(`16 份 spec 语法全部通过`, badSyntax === 0, `失败 ${badSyntax}`);

// ②③④ 载入并比较
const loaded = [];
for (const s of specs) {
  const m = await import(`file:///${(WORK + '\\' + s.file).replace(/\\/g, '/')}`);
  loaded.push({ ...s, prompt: m.task.prompt, taskId: m.task.taskId });
}
const sPrompts = loaded.filter((x) => x.arm === 'S').map((x) => x.prompt);
const dPrompts = loaded.filter((x) => x.arm === 'D').map((x) => x.prompt);
ok('S 各轮 prompt 逐字节相同', new Set(sPrompts).size === 1, `去重后 ${new Set(sPrompts).size}`);
ok('D 各轮 prompt 逐字节相同', new Set(dPrompts).size === 1, `去重后 ${new Set(dPrompts).size}`);

const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return a.slice(0, i); };
const pref = commonPrefix(sPrompts[0], dPrompts[0]);
ok('两臂共通前缀够长（差异只在协议段）', pref.length > 500, `共通前缀 ${pref.length} 字符；S=${sPrompts[0].length} D=${dPrompts[0].length}`);
// 注意：'【工作方式' 是两臂**共用**的标题（差异在其后的「（S 组）/（D 组）」），故不能断言前缀不含它。
// 正确断言：前缀应终止在协议标题之后的组别之前，且不含语料正文（语料在协议之后）。
ok('共通前缀不含语料正文（语料在协议之后）', !/情境（共/.test(pref) && !/【情境 1】/.test(pref));

// ④ 转义不能吃掉代码片段：cc 看到的原文必须保留反引号
ok('prompt 保留反引号代码片段（git status --porcelain）', sPrompts[0].includes('`git status --porcelain`'));
ok('prompt 保留 .gitignore 模式描述', sPrompts[0].includes('web-relay/experiments/'));
ok('prompt 未残留转义反斜杠', !sPrompts[0].includes('\\`'));

// ④b **真值不得泄漏进 prompt**（ground truth 只存在 labels 文件里；一旦泄漏整个实验作废）
const LEAK = ['uall', 'untracked-files', '幂等守卫', '**/', 'fail-open', '分布式锁'];
const leaked = LEAK.filter((k) => sPrompts[0].includes(k) || dPrompts[0].includes(k));
ok('ground truth 特征词未泄漏进任何一臂的 prompt', leaked.length === 0, `泄漏: ${leaked.join(', ')}`);

ok('D 协议含"简约审查"（本轮新增的过度设计对照）', /简约审查/.test(dPrompts[0]));
ok('S 协议不含"简约审查"', !/简约审查/.test(sPrompts[0]));

// ⑤ 链条
const chainSrc = fs.readFileSync(WORK + '\\cc-chains\\v7-gen2.mjs', 'utf8');
const chainSpecs = [...chainSrc.matchAll(/spec: '([^']+)'/g)].map((m) => m[1]);
const chainIds = [...chainSrc.matchAll(/taskId: '([^']+)'/g)].map((m) => m[1]);
ok('链条条目数 = 16', chainSpecs.length === 16, `实际 ${chainSpecs.length}`);
ok('链条引用的 spec 全部存在', chainSpecs.every((s) => fs.existsSync(WORK + '\\' + s.replace(/\//g, '\\'))));
ok('链条 taskId 唯一', new Set(chainIds).size === chainIds.length, `${chainIds.length} 个`);
ok('链条为交错排列（S,D,S,D…）', /S 第 1 轮[\s\S]*D 第 1 轮[\s\S]*S 第 2 轮/.test(chainSrc));

console.log(`\n  RESULT: ${fails.length ? 'FAIL（' + fails.length + ' 项）' : 'PASS'}`);
process.exit(fails.length ? 1 : 0);
