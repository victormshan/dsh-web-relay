// 核实 parseResetsAt 的时区偏移是否正确（用独立算法算出期望值对照，不依赖被测实现）
import { parseResetsAt } from 'file:///D:/dsh-web-relay/lib/cc-channel.js';

// 独立期望值算法：给定「本地墙上时间 + IANA 时区」→ UTC 毫秒（用 Intl 反解，与被测实现不同路径）
function expectedUtcMs(y, mo, d, hh, mm, tz) {
  // 先用一个猜测（把墙上时间当 UTC），再用 Intl 求该时区下的偏移，迭代收敛
  let guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(guess));
    const g = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(Number(g.year), Number(g.month) - 1, Number(g.day), Number(g.hour) % 24, Number(g.minute), Number(g.second));
    guess += (Date.UTC(y, mo - 1, d, hh, mm, 0) - asUtc);
  }
  return guess;
}

const NOW = Date.parse('2026-09-15T19:02:00Z'); // 本地(Asia/Shanghai) 2026-09-16 03:02
const TZ = 'Asia/Shanghai';

const cases = [
  // [文案, 期望的本地墙上时间 y,mo,d,hh,mm]
  ["You've hit your session limit · resets 7am (Asia/Shanghai)", [2026, 9, 16, 7, 0], '真实文案：本地 09-16 07:00'],
  ['resets 3:20am (Asia/Shanghai)', [2026, 9, 16, 3, 20], 'H:MM：本地 09-16 03:20'],
  ['resets 11:05pm (Asia/Shanghai)', [2026, 9, 16, 23, 5], 'H:MM pm：本地 09-16 23:05'],
];

let bad = 0;
for (const [text, [y, mo, d, hh, mm], label] of cases) {
  const got = parseResetsAt(text, { now: NOW });
  const want = new Date(expectedUtcMs(y, mo, d, hh, mm, TZ)).toISOString();
  const diffH = ((Date.parse(got) - Date.parse(want)) / 3600000).toFixed(1);
  const ok = Date.parse(got) === Date.parse(want);
  if (!ok) bad++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
  console.log(`         实测 = ${got}`);
  console.log(`         期望 = ${want}   偏差 = ${diffH} 小时`);
}

console.log(`\n  RESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL（存在时区偏差）' : 'PASS'}`);
process.exit(bad ? 1 : 0);
