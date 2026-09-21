// 门禁：「链条停下等人」信号模块的两侧自检 + 调用点静态校验。
//
// 为什么需要：这条信号会导致**唤醒主 agent**（有真实副作用，会打断/注入消息）。所以它必须满足两条相反的性质：
//   [POS] 真需要人时必须能登记（护栏触发 / 工具坏了 / 跑完待收口）；
//   [NEG] **不该登记的绝不能登记**——尤其是"额度耗尽"（会自动等配额重置，是设计内行为）与正常跳过。
// 否则每次额度暂停都唤醒主 agent = 告警疲劳，这条通路很快就没人看了。
//
// 用法: node verify-human-signal.mjs [--selftest]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildHumanSignal, readHumanSignal, writeHumanSignal, acknowledgeHumanSignal, writeHumanSignalIfNew, resolveHumanSignal, ALLOWED_REASONS } from './chain-human-signal.mjs';

const WORK = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '));
// 允许的理由取自模块单一事实源（避免"门禁里的清单"和"实现里的清单"各写一份、悄悄漂移）
const ALLOWED = ALLOWED_REASONS;

function selftest() {
  const tmp = path.join(os.tmpdir(), `humansig-${Date.now()}.json`);
  const cases = [];
  const t = (label, cond, detail = '') => { cases.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond || !detail ? '' : ' — ' + detail}`); };

  // [POS] 三种"需要人"的理由都能登记，且 id/形状完整
  for (const r of ALLOWED) {
    const s = buildHumanSignal({ chainId: 'c1', reason: r, taskId: 't1' });
    t(`[POS] 允许的理由可登记：${r}`, !!s.id && s.chainId === 'c1' && s.reason === r && s.acknowledgedAt === null);
  }
  // [NEG] 不该唤醒的理由必须被拒（额度耗尽会自动恢复；正常跳过根本不是事件）
  for (const r of ['quota-exhausted', 'noop', 'completed-ok', '']) {
    let threw = false;
    try { buildHumanSignal({ chainId: 'c1', reason: r }); } catch { threw = true; }
    t(`[NEG] 不该唤醒的理由被拒：${r || '(空)'}`, threw);
  }
  let threw2 = false;
  try { buildHumanSignal({ reason: 'review-needed' }); } catch { threw2 = true; }
  t('[NEG] 缺 chainId → 拒绝（避免写出无法归属的信号）', threw2);

  // [POS] 写/读/销账往返
  writeHumanSignal(buildHumanSignal({ chainId: 'cRT', reason: 'review-needed', detail: '待收口' }), tmp);
  const r1 = readHumanSignal(tmp);
  t('[POS] 写后可读，形状完整', r1.ok && r1.entry.chainId === 'cRT' && r1.entry.detail === '待收口');
  const ack = acknowledgeHumanSignal('已收口', tmp);
  const r2 = readHumanSignal(tmp);
  t('[POS] 销账后带 acknowledgedAt（插件据此不再重复唤醒）', ack.ok && !!r2.entry.acknowledgedAt && r2.entry.ackNote === '已收口');

  // [NEG] 容错：缺失/坏 JSON/形状不对 → 一律 ok:false，不得抛（插件 boot 路径必须 fail-open）
  const rMissing = readHumanSignal(path.join(os.tmpdir(), '__no_such_signal__.json'));
  t('[NEG] 文件缺失 → ok:false 且 exists:false（= 不需要人）', rMissing.ok === false && rMissing.exists === false);
  const bad = path.join(os.tmpdir(), `humansig-bad-${Date.now()}.json`);
  fs.writeFileSync(bad, '{ not json', 'utf8');
  t('[NEG] 坏 JSON → ok:false（不抛）= 插件 fail-open', readHumanSignal(bad).ok === false);
  fs.writeFileSync(bad, JSON.stringify({ reason: 'review-needed' }), 'utf8');
  t('[NEG] 缺 id/chainId → ok:false（不能拿半个信号去唤醒）', readHumanSignal(bad).ok === false);
  for (const f of [tmp, bad]) { try { fs.unlinkSync(f); } catch { /* 已删 */ } }

  // ---- 方案 A 语义：稳定键去重 + 销账后复发能再次叫醒 + 自愈自动销账 ----
  const st = path.join(os.tmpdir(), `humansig-stable-${Date.now()}.json`);
  const mk = (gen = 1) => buildHumanSignal({ chainId: 'four-layer-audit', reason: 'audit-action-needed', stableKey: 'four-layer-audit', generation: gen, detail: '审计 ACTION-NEEDED' });
  const w1 = writeHumanSignalIfNew(mk(), st);
  t('[POS] 首次登记 → written:true', w1.written === true && w1.signal.id === 'four-layer-audit#g1', `id=${w1.signal.id}`);
  const w2 = writeHumanSignalIfNew(mk(), st);
  t('[NEG] 同源仍**未销账** → 不重复写（否则每 30 分钟吵一次人）', w2.written === false && w2.signal.id === 'four-layer-audit#g1', `written=${w2.written} id=${w2.signal.id}`);
  acknowledgeHumanSignal('人工处理过', st);
  const w3 = writeHumanSignalIfNew(mk(), st);
  t('[POS] 同源**已销账**后复发 → 代数 +1、新 id（复发必须能再次叫醒）', w3.written === true && w3.signal.id === 'four-layer-audit#g2', `written=${w3.written} id=${w3.signal.id}`);
  const other = buildHumanSignal({ chainId: 'cX', reason: 'review-needed', stableKey: 'chain-v9' });
  const w4 = writeHumanSignalIfNew(other, st);
  t('[POS] 主槽未销账时，别的来源**入队**而非顶掉（单槽覆盖会让未处理的告警静默消失）',
    w4.written === true && w4.queued === true && readHumanSignal(st).entry.stableKey === 'four-layer-audit',
    `queued=${w4.queued} 主槽=${readHumanSignal(st).entry.stableKey}`);
  t('[NEG] 入队后主槽仍是原来那条未销账信号（未被覆盖）', readHumanSignal(st).entry.id === 'four-layer-audit#g2' && !readHumanSignal(st).entry.acknowledgedAt);
  const ack2 = acknowledgeHumanSignal('处理完审计告警', st);
  t('[POS] 销账后自动提升队列下一条，且给新代数（新 id → 插件会为它再次唤醒）',
    !!ack2.promoted && ack2.promoted.stableKey === 'chain-v9' && /#g2$/.test(ack2.promoted.id) && readHumanSignal(st).entry.stableKey === 'chain-v9',
    `promoted=${ack2.promoted && ack2.promoted.id}`);
  const own = writeHumanSignalIfNew(buildHumanSignal({ chainId: 'four-layer-audit', reason: 'audit-action-needed', stableKey: 'four-layer-audit' }), st);
  t('[POS] 同源再次出现（主槽已是别的来源）→ 入队，不顶掉', own.queued === true, `queued=${own.queued}`);
  const res = resolveHumanSignal('four-layer-audit', 'auto: 审计已恢复', st);
  t('[POS] 自愈自动销账：队列里的同源条目也被标记', res.resolved === true && res.inQueue === true);
  const res2 = resolveHumanSignal('four-layer-audit', 'again', st);
  t('[NEG] 已销账 → 不重复动它', res2.resolved === false);
  const res3 = resolveHumanSignal('no-such-source', 'x', st);
  t('[NEG] 不同来源 → 绝不动别人的信号', res3.resolved === false);
  for (const f of [st, `${st.replace(/\.json$/, '')}.queue.json`]) { try { fs.unlinkSync(f); } catch { /* 已删 */ } }

  // [POS] 调用点静态校验：cc-chain 里每个 buildHumanSignal 的 reason 都必须是允许集合内的字面量
  const src = fs.readFileSync(path.join(WORK, 'cc-chain.mjs'), 'utf8');
  const reasons = [...src.matchAll(/reason:\s*'([^']+)'/g)].map((m) => m[1]).filter((r) => ALLOWED.includes(r) || true);
  const allAllowed = reasons.every((r) => ALLOWED.includes(r));
  t(`[POS] cc-chain 的登记点只使用允许理由（实测 ${reasons.length} 处：${reasons.join(',') || '无'}）`, reasons.length > 0 && allAllowed);
  const hasQuota = /reason:\s*'quota[^']*'/.test(src);
  t('[NEG] cc-chain 不得把"额度耗尽"登记为需要人（否则每次配额暂停都吵醒主 agent）', !hasQuota);

  const ok = cases.filter((c) => c.cond).length;
  console.log(`\nRESULT: ${ok}/${cases.length} ${ok === cases.length ? 'PASS' : 'FAIL'}`);
  return ok === cases.length;
}

if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
console.log('本门禁只有自检入口；请用 --selftest 运行。');
process.exit(2);
