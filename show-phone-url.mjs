// 取出当前宿主的 process-token，拼出手机可用 URL，并**实测该 token 真的通过信任栅栏**。
import fs from 'node:fs';

const LOG = 'C:\\Users\\Administrator\\.dsh\\logs\\dsh-web-watchdog.log';
const txt = fs.readFileSync(LOG, 'utf8');
const lines = txt.split(/\r?\n/).filter((l) => /dsh web:\s*http/.test(l));
if (!lines.length) { console.log('  未在日志中找到 "dsh web: http://..." 行'); process.exit(2); }
const last = lines[lines.length - 1];
const m = last.match(/(https?:\/\/[^\s?]+)\/\?token=([A-Za-z0-9._-]+)/);
if (!m) { console.log('  行格式未识别: ' + last.slice(0, 160)); process.exit(2); }
const [, base, token] = m;
console.log(`  日志中最近一条（${lines.length} 条中）:`);
console.log(`    本地地址 = ${base}/?token=<${token.length} 字符>`);
console.log(`    token 指纹 = ${token.slice(0, 4)}…${token.slice(-4)}`);

// 实测 1：loopback 带 token → 应 200
const r1 = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const setCookie = r1.headers.get('set-cookie');
console.log(`\n  [实测] loopback 带 token → HTTP ${r1.status}${setCookie ? '，并下发了 cookie' : ''}`);

// 实测 2：不带 token → 应 401（对照组，证明差异来自 token 而非路径）
const r2 = await fetch(`${base}/`, { redirect: 'manual' });
console.log(`  [对照] loopback 不带 token → HTTP ${r2.status}  （${(await r2.text()).trim().slice(0, 60)}）`);

// 实测 3：模拟手机经 tailscale 的 Host 头（验证 --trusted-host 是否接受该 authority）
let r3status = 'n/a';
try {
  const r3 = await fetch(`${base}/?token=${token}`, { redirect: 'manual', headers: { host: 'win10-dt.taile618c2.ts.net' } });
  r3status = r3.status;
} catch (e) { r3status = '异常 ' + e.message; }
console.log(`  [实测] 带 tailscale Host 头 → HTTP ${r3status}`);

console.log('\n  === 手机应打开的 URL ===');
console.log(`  https://win10-dt.taile618c2.ts.net/?token=${token}`);
console.log('\n  说明：token 每次宿主重启都会变；打开一次即换取 cookie，之后同一浏览器无需再带 token。');
