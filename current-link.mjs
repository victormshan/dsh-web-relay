// 当前手机访问链接 —— 从权威来源现读 + **实测有效**（绝不打印未经验证的值：token 每次宿主重启都会换）。
//
// 为什么要"实测"而不是"打印日志里的值"：日志里那行是 boot 时写下的，token 会随每次重启轮换
// （2026-09-20 实测连看三条启动行 = 三个不同 token）。只贴日志值等于把"可能已失效的凭证"给人 ——
// 正是本会话反复踩的"写死旧值"陷阱。故默认做**两侧探针**：正确 token 应被接受（303/200），
// 错误 token 应被拒（401）；只有两侧都符合才报"当前有效"。
//
// 用法: node current-link.mjs [--json] [--no-verify]
//       node current-link.mjs --selftest    # 纯函数两侧自检（解析 + 判定）
import fs from 'node:fs';

export const LOG_PATH = 'C:/Users/Administrator/.dsh/logs/dsh-web-watchdog.log';
const DEFAULT_HOST = '127.0.0.1';

/** 纯函数：从日志行里取**最后一条**启动行里的 token。找不到返回 null。 */
export function parseLastToken(lines) {
  const re = /dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_\-]+)/;
  let hit = null;
  for (const l of lines) { const m = l.match(re); if (m) hit = { port: Number(m[1]), token: m[2], line: l.trim() }; }
  return hit;
}
/** 纯函数：从日志行里取**最后一条**「拉起宿主」的 --trusted-host（没有则 null）。 */
export function parseTrustedHost(lines) {
  const re = /--trusted-host\s+(\S+)/;
  let hit = null;
  for (const l of lines) { if (!/拉起宿主/.test(l)) continue; const m = l.match(re); if (m) hit = m[1]; }
  return hit;
}
/** 纯函数：两侧探针的判定。正确 token 被接受（2xx/303）且错误 token 被拒（401/403）才算"当前有效"。 */
export function judgeTokenProbe({ okStatus, badStatus }) {
  const accepted = okStatus === 303 || (typeof okStatus === 'number' && okStatus >= 200 && okStatus < 400);
  const rejected = badStatus === 401 || badStatus === 403;
  if (accepted && rejected) return { verdict: '有效', why: `正确 token → ${okStatus}（接受），错误 token → ${badStatus}（拒绝）` };
  if (!accepted && rejected) return { verdict: '已失效', why: `正确 token → ${okStatus}（未被接受），错误 token → ${badStatus} —— token 很可能已随重启轮换，请从最新启动行取新值` };
  if (accepted && !rejected) return { verdict: '存疑', why: `正确 token → ${okStatus}，但错误 token 也未被拒（${badStatus}）—— 鉴权行为异常，需排查` };
  return { verdict: '不可达', why: `正确 token → ${okStatus}，错误 token → ${badStatus}` };
}

if (process.argv.includes('--selftest')) {
  const cases = [];
  const ck = (label, cond, detail = '') => { cases.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };
  const lines = [
    'dsh web: http://127.0.0.1:3080/?token=OLD_TOKEN_aaaaaaaa',
    '[watchdog 2026-09-20T19:54:24.706Z] 拉起宿主：node bin.js web --trusted-host win10-dt.taile618c2.ts.net --no-open',
    'dsh web: http://127.0.0.1:3080/?token=NEW_TOKEN_bbbbbbbb',
  ];
  ck('[POS] 取到**最后一条**启动行的 token（不是旧的）', parseLastToken(lines)?.token === 'NEW_TOKEN_bbbbbbbb', JSON.stringify(parseLastToken(lines)));
  ck('[POS] 取到 --trusted-host', parseTrustedHost(lines) === 'win10-dt.taile618c2.ts.net', String(parseTrustedHost(lines)));
  ck('[NEG] 日志里没有启动行 → 返回 null（**不得**编一个链接出来）', parseLastToken(['nothing here']) === null);
  ck('[NEG] 没有拉起宿主行 → host 为 null（调用方应回退 127.0.0.1）', parseTrustedHost(['dsh web: x']) === null);
  ck('[POS] 303 + 401 → 有效', judgeTokenProbe({ okStatus: 303, badStatus: 401 }).verdict === '有效');
  ck('[POS] 200 + 403 → 有效', judgeTokenProbe({ okStatus: 200, badStatus: 403 }).verdict === '有效');
  ck('[NEG] 401 + 401 → **已失效**（token 轮换掉了，必须说出来而不是照贴）', judgeTokenProbe({ okStatus: 401, badStatus: 401 }).verdict === '已失效');
  ck('[NEG] 200 + 200 → 存疑（错误 token 也没被拒 = 鉴权异常）', judgeTokenProbe({ okStatus: 200, badStatus: 200 }).verdict === '存疑');
  const bad = cases.filter((c) => !c.cond).length;
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

// ---------------- CLI ----------------
const argv = process.argv.slice(2);
let lines = [];
try { lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n'); } catch (err) {
  console.log(JSON.stringify({ ok: false, error: `日志不可读：${String(err.message)}` }, null, 2));
  process.exit(3);
}
const hit = parseLastToken(lines);
if (!hit) {
  console.log(JSON.stringify({ ok: false, error: '日志里找不到 dsh web 启动行（无法给出链接，也不猜）' }, null, 2));
  process.exit(4);
}
const host = parseTrustedHost(lines) || DEFAULT_HOST;
const useHttps = host !== DEFAULT_HOST;   // tailnet serve 走 443 https；本机回退用 http:port
const url = useHttps ? `https://${host}/?token=${hit.token}` : `http://${DEFAULT_HOST}:${hit.port}/?token=${hit.token}`;

let probe = null;
if (!argv.includes('--no-verify')) {
  const get = async (u) => { try { const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); return r.status; } catch { return 'ERR'; } };
  probe = judgeTokenProbe({ okStatus: await get(url), badStatus: await get(url.replace(hit.token, 'WRONG_TOKEN_PROBE')) });
}

const out = {
  ok: true,
  url,
  host,
  port: hit.port,
  tokenSource: hit.line.slice(0, 70),
  tokenVerdict: probe ? probe.verdict : '(未验证 --no-verify)',
  tokenWhy: probe ? probe.why : '',
  note: 'token 每次宿主重启都会轮换；303 之后浏览器靠 dsh-auth cookie 维持会话，之后可只开 https://' + host + '/',
};
console.log(argv.includes('--json') ? JSON.stringify(out, null, 2) : [
  `手机链接：${out.url}`,
  `token 状态：${out.tokenVerdict}${out.tokenWhy ? ' —— ' + out.tokenWhy : ''}`,
  `来源：${out.tokenSource}`,
  `提示：${out.note}`,
].join('\n'));
process.exit(probe && probe.verdict === '已失效' ? 1 : 0);
