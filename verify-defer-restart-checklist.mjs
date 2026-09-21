// 两侧活体验证：v20.2「重启清单延后到 boot」是否真的生效（不重启即可验证）。
//   [POS] 中性 chainId 的夹具 → 心跳期应判 would-wake（证明通用唤醒路径未被延后逻辑误伤）
//   [NEG] 重启清单类夹具（chainId=post-restart-verify，本进程启动后登记）→ 心跳期应判 deferred-to-boot（不唤醒）
// 手法：主槽腾空后写入 dryRun 夹具 → POST /admin/heartbeat-check → 读 /health-check 的 pendingHuman → 销账清掉夹具。
import { buildHumanSignal, writeHumanSignalIfNew, acknowledgeHumanSignal, SIGNAL_PATH, readHumanSignal } from './chain-human-signal.mjs';

const BEAT = 'http://127.0.0.1:3080/dsh-web-relay/admin/heartbeat-check';
const HEALTH = 'http://127.0.0.1:3080/dsh-web-relay/health-check';
const cases = [];
const ck = (label, cond, detail = '') => { cases.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };
const beat = async () => { const r = await fetch(BEAT, { method: 'POST', signal: AbortSignal.timeout(20000) }); return r.status; };
const health = async () => { const r = await fetch(HEALTH, { signal: AbortSignal.timeout(15000) }); return r.json(); };

const cur = readHumanSignal(SIGNAL_PATH);
if (cur.ok && cur.entry && !cur.entry.acknowledgedAt) {
  console.log(`  ⚠ 主槽仍有未销账条目 ${cur.entry.id} → 先销账（本验证需要空主槽）`);
  acknowledgeHumanSignal('腾空主槽以供延后逻辑两侧验证');
}

async function probe(label, chainId, expect) {
  const key = `${chainId}-probe-${Date.now()}`;
  const sig = buildHumanSignal({ chainId, reason: 'review-needed', stableKey: key, detail: `${label}（dryRun 夹具）` });
  sig.dryRun = true;
  const w = writeHumanSignalIfNew(sig, SIGNAL_PATH);
  const st = await beat();
  const h = await health();
  const p = (h && h.pendingHuman) || {};
  const got = p.id === sig.id ? (p.error && /deferred-to-boot/.test(String(p.error)) ? 'deferred-to-boot' : p.decision) : `(未读到该夹具：${p.id || 'none'})`;
  ck(label, got === expect, `HTTP=${st} id=${String(p.id).slice(0, 46)} decision=${p.decision} woken=${p.actuallyWoken} err=${String(p.error || '').slice(0, 40)} ｜ 期望 ${expect}，实得 ${got}`);
  acknowledgeHumanSignal(`清理 ${label} 夹具`);
  return got;
}

console.log('=== v20.2 延后逻辑：两侧活体验证 ===');
await probe('[POS] 中性 chainId 的唤醒夹具 → 心跳期仍判 would-wake（通用路径未被误伤）', 'wake-path-probe', 'would-wake');
await probe('[NEG] 重启清单类夹具（本进程启动后登记）→ 心跳期判 deferred-to-boot（不唤醒）', 'post-restart-verify', 'deferred-to-boot');

const bad = cases.filter((c) => !c.cond).length;
console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
process.exit(bad ? 1 : 0);
