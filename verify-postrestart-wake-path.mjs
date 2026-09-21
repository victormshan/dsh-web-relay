// 验证「重启后自动续跑」这条通路真的通 —— 并**顺手把本次重启的核对清单登记进去**。
//
// ⚠️ **运行本工具会真的请求一次宿主重启**（步骤②，默认 120s 后执行）。只想修补/自检它的步骤①时，
//    不要直接跑整个文件 —— 2026-09-20 我就这么踩了一次，凭空造出一次计划外重启。
//
// 两步（避免用 dryRun 夹具污染真实条目的 id，那样 boot 扫描会因去重而静默）：
//   ① 写一个 dryRun 夹具（独立 stableKey）→ POST /admin/heartbeat-check → 断言插件判定 would-wake（不真唤醒）→ 立即销账清掉；
//   ② 调 restart-with-checklist.mjs：登记真清单（非 dryRun）→ 发重启请求。
// 之后 boot 扫描应读到真清单并唤醒主 agent —— 那就是"自动续跑"的证据（下一次会话开头会带这份清单）。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildHumanSignal, writeHumanSignalIfNew, acknowledgeHumanSignal, readHumanSignal, SIGNAL_PATH } from './chain-human-signal.mjs';

const WORK = 'D:\\dsh relay test';
const HEARTBEAT = 'http://127.0.0.1:3080/dsh-web-relay/admin/heartbeat-check';
const HEALTH = 'http://127.0.0.1:3080/dsh-web-relay/health-check';
const results = [];
const check = (label, cond, detail = '') => { results.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };
const beat = async () => { const r = await fetch(HEARTBEAT, { method: 'POST', signal: AbortSignal.timeout(15000) }); try { return await r.json(); } catch { return null; } };
const health = async () => { const r = await fetch(HEALTH, { signal: AbortSignal.timeout(15000) }); try { return await r.json(); } catch { return null; } };

const delay = Number(process.argv[process.argv.indexOf('--delay') + 1]) || 120;

// ---- ① dryRun 夹具：验证插件会判 would-wake，且不真唤醒 ----
// ⚠ 2026-09-20 修正：夹具原用 chainId/stableKey 前缀 `post-restart-verify` —— v20.2 引入"重启清单在心跳期
//   延后到 boot（deferred-to-boot）"后，该形态会被**有意**判成不唤醒，本工具的 would-wake 期望随之过时
//   （改动语义时必须扫同伴工具的期望：L-087 同型）。改用中性 chainId，让它继续测**通用唤醒路径**。
const probeKey = `wake-path-probe-${Date.now()}`;
const probe = buildHumanSignal({ chainId: 'wake-path-probe', reason: 'review-needed', stableKey: probeKey, detail: '通路验证夹具（dryRun，不真唤醒）' });
probe.dryRun = true;
writeHumanSignalIfNew(probe, SIGNAL_PATH);
await beat();
const h1 = await health();
const p1 = h1 && h1.pendingHuman;
check('[POS] 插件读到夹具并判定 would-wake（通路有效、不真唤醒）',
  !!p1 && p1.id === probe.id && p1.decision === 'would-wake' && p1.actuallyWoken !== true,
  p1 ? `id=${String(p1.id).slice(0, 40)} decision=${p1.decision} woken=${p1.actuallyWoken}` : '(无 pendingHuman)');
// 清掉夹具（销账），避免它占据主槽
acknowledgeHumanSignal('通路验证夹具，已清', SIGNAL_PATH);
const after = readHumanSignal(SIGNAL_PATH);
check('[POS] 夹具已销账（不占用主槽）', !!after.entry && !!after.entry.acknowledgedAt, after.entry ? `id=${after.entry.id}` : '(无)');

// ---- ② 登记真清单 + 重启 ----
// ⚠ 2026-09-20 修正：原因文案原为硬编码 'activate v18 + …'（写于 v18 时代）—— 之后每次用它触发重启，
//   durable 记录里的重启原因都写着"activate v18"，与真实事件不符（结算时看到的是一份假描述）。
//   现改为**如实描述本次动作**，并支持 --reason 覆盖。
const reasonIdx = process.argv.indexOf('--reason');
const reason = reasonIdx >= 0 && process.argv[reasonIdx + 1]
  ? process.argv[reasonIdx + 1]
  : 'wake-path verification: checklist registered before restart (by verify-postrestart-wake-path.mjs)';
if (results.every((r) => r.cond)) {
  const r = spawnSync(process.execPath, [WORK + '\\restart-with-checklist.mjs', '--delay', String(delay), '--reason', reason], { cwd: WORK, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  console.log(out.trim().split('\n').map((l) => '  ' + l).join('\n'));
  const real = readHumanSignal(SIGNAL_PATH);
  check('[POS] 真清单已登记且未销账（boot 扫描会读到它）',
    !!real.entry && real.entry.stableKey === 'post-restart-verify' && !real.entry.acknowledgedAt,
    real.entry ? `id=${real.entry.id}` : '(无)');
  check('[POS] 重启请求已发出', /RESTART_REQUESTED|已写重启信号/.test(out));
} else {
  console.log('  [SKIP] 通路验证未通过 → 不发重启请求（避免"重启后无人被叫"再次发生）');
}

const pass = results.filter((r) => r.cond).length;
console.log(`\nRESULT: ${pass}/${results.length} ${pass === results.length ? 'PASS' : 'FAIL'}`);
process.exit(pass === results.length ? 0 : 1);
