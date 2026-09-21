// 校验调度器命令文件：run-chain.cmd 必须能被 cmd.exe 正确解析。
// 事故来源（2026-09-16）：用 UTF-8 写入含中文 rem 注释的 run-chain.cmd → cmd.exe 按系统 ANSI 代码页
// 解析 .cmd，非 ASCII 字节被错解并破坏行结构 → exit=255、报出 '.log' is not recognized 等伪命令。
// 该文件是自动化入口，一旦解析失败整套无人值守会静默失效，故设为回归用例。
import fs from 'node:fs';

const P = (() => { const i = process.argv.indexOf('--path'); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'D:\\cc-tasks\\run-chain.cmd'; })();
const POINTER = 'D:\\cc-tasks\\current-chain.txt';
let bad = 0;
const chk = (name, ok, detail = '') => { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !detail ? '' : ' — ' + detail}`); if (!ok) bad++; };

if (!fs.existsSync(P)) { console.log(`  [FAIL] run-chain.cmd 不存在（${P}）`); process.exit(1); }
const buf = fs.readFileSync(P);
const txt = buf.toString('utf8');

const nonAscii = [...buf].filter((b) => b > 127).length;
chk('纯 ASCII（cmd.exe 按 ANSI 解析，非 ASCII 会破坏行结构）', nonAscii === 0, `非 ASCII 字节 = ${nonAscii}`);
chk('无 UTF-8 BOM', !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf));
chk('使用指针文件 current-chain.txt', /current-chain\.txt/.test(txt));
chk('延迟展开已开启（读取指针需要）', /setlocal enabledelayedexpansion/i.test(txt));
chk('未把链条名写死（指针化的意义所在）', !/cc-chains[\\/][A-Za-z0-9._-]+\.mjs[^\r\n]*"/.test(txt.split('\n').filter((l) => !l.trim().startsWith('rem')).join('\n')));
chk('缺指针时走 noop 分支（不得崩溃）', /:nochain/.test(txt) && /exit \/b 0/.test(txt));
chk('调用 cc-chain.mjs', /cc-chain\.mjs/.test(txt));

console.log(`  指针文件存在 = ${fs.existsSync(POINTER)}${fs.existsSync(POINTER) ? `（内容: ${fs.readFileSync(POINTER, 'utf8').trim() || '(空)'}）` : ''}`);
console.log(`\n  RESULT: ${bad ? 'FAIL' : 'PASS'}（${bad} 项失败）`);
process.exit(bad ? 1 : 0);
