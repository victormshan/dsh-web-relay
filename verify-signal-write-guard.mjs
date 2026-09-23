// 信号通道**写入守卫**的两侧自检 —— 补 2026-09-20 事故类缺陷的机制性防线。
//
// 事故回顾（我造成的）：在**内联 PowerShell** 里用 `p.replace(/\.json$/i,'.queue.json')` 计算"规范队列路径"，
// PowerShell 吃掉正则里的 `$` → 变量落回**主槽**路径 → 清理脚本把 `[]` 写进主槽，**销毁一条未销账信号**。
// 单写者锁（agent-write-lock.mjs，另一实例已做）解决"两个会话并发写"；本文件解决另一半：
//   G1 路径断言：写目标只能是 {主槽, 规范队列, 历史队列} 三者之一，否则抛错（防"算错路径落回主槽"）。
//   G2 主槽形状校验：主槽只接受**合法信号对象**（缺 id/chainId/reason、数组、空对象一律拒绝）。
//   G3 静态接线：活工具（非 `_` 前缀的一次性脚本）**不得绕过格式权威直写信号文件**（调用点穷举）。带
//      **合成违例负控**，证明这条扫描不是永真。
//   G4 交付/重启已纳入写锁（静态接线断言）——它们与信号同属"互相覆盖会丢数据"的写入。
//   G5 重启清单登记：主槽被占时必须拒绝（接线断言）。
//   G6 合成夹具腾位：只清 synthetic===true，**真实告警必须被拒且原样保留**（2026-09-23 加）。
//
// 用法: node verify-signal-write-guard.mjs --selftest   # 两侧自检（全部纯函数/临时文件，绝不碰真实信号）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSignalPath, signalFiles, queuePathOf, clearSyntheticSignal, SIGNAL_PATH } from './chain-human-signal.mjs';
import { assertSignalShape } from './chain-human-signal.mjs';

const WORK = 'D:\\dsh relay test';
const results = [];
const ck = (label, cond, detail = '') => { results.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return String((e && e.message) || e); } };

console.log('=== G1 路径断言：只允许三个合法目标 ===');
const known = signalFiles(SIGNAL_PATH);
for (const [name, p] of [['主槽', known.main], ['规范队列', known.queue], ['历史队列', known.legacyQueue]]) {
  const err = throws(() => assertSignalPath(p));
  ck(`[POS] 接受${name}路径`, err === null, err || p);
}
const badErr = throws(() => assertSignalPath('D:\\cc-tasks\\chain-needs-human.json.evil.json'));
ck('[NEG] 拒绝未知路径（防"算错路径落回主槽"这类事故）', !!badErr && /拒绝写入未知路径/.test(badErr), String(badErr).slice(0, 90));
const badErr2 = throws(() => assertSignalPath(path.join(WORK, '.agent-write-lock.json')));
ck('[NEG] 拒绝把锁文件当信号通道写', !!badErr2, String(badErr2).slice(0, 80));

console.log('\n=== G2 主槽形状校验：`[]`/空对象/缺字段一律拒绝 ===');
const okSig = { id: 'x#g1', chainId: 'x', reason: 'review-needed' };
ck('[POS] 合法信号对象通过', throws(() => assertSignalShape(okSig)) === null);
for (const [label, bad] of [
  ['数组 `[]`（**正是事故里写进去的东西**）', []],
  ['空对象 `{}`', {}],
  ['缺 chainId', { id: 'a', reason: 'review-needed' }],
  ['缺 reason', { id: 'a', chainId: 'b' }],
  ['字符串', 'oops'],
  ['null', null],
]) {
  const e = throws(() => assertSignalShape(bad));
  ck(`[NEG] 拒绝${label}`, !!e, String(e).slice(0, 70));
}

console.log('\n=== G3 静态接线：活工具不得绕过格式权威直写信号文件 ===');
const AUTHORS = new Set(['chain-human-signal.mjs', 'verify-signal-write-guard.mjs']);   // 格式权威自身 + 本扫描器
// （排除本扫描器的理由：它的**负控夹具**里必须包含违例文本，否则无法证明扫描非永真 → 扫自己必然自引用假阳性。）
const scanDir = (dir) => {
  const hits = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.mjs')) continue;
    if (f.startsWith('_') || f.includes('.bak')) continue;   // 一次性脚本/备份不纳入
    if (AUTHORS.has(f)) continue;
    let txt = '';
    try { txt = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    // 违规形态：同一文件里既有信号路径字面量/常量，又有对它的 fs 直写
    const hasPathRef = /chain-needs-human/.test(txt);
    const directWrite = /writeFileSync\s*\([^)]*chain-needs-human/.test(txt)
      || (/chain-needs-human/.test(txt) && /writeFileSync\s*\(\s*(canon|queueFile|queuePath|SIGNAL_PATH|p)\b/.test(txt));
    if (hasPathRef && directWrite) hits.push(f);
  }
  return hits;
};
const liveHits = scanDir(WORK);
ck('[POS] 活工具中绕过权威直写信号文件的 = 0（调用点已穷举）', liveHits.length === 0, liveHits.length ? `违规：${liveHits.join(', ')}` : '无');
// 负控：合成一个违例文件，扫描必须抓到它（证明这条扫描不是永真）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-scan-'));
fs.writeFileSync(path.join(tmp, 'fake-writer.mjs'), "import fs from 'node:fs';\nconst canon = 'D:/cc-tasks/chain-needs-human.queue.json';\nfs.writeFileSync(canon, JSON.stringify([], null, 2));\n", 'utf8');
const tmpHits = scanDir(tmp);
ck('[NEG] 合成违例必须被抓到（证明扫描非永真）', tmpHits.length === 1 && tmpHits[0] === 'fake-writer.mjs', JSON.stringify(tmpHits));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log('\n=== G4 交付/重启已纳入写锁（接线断言）===');
for (const f of ['deliver-three-copies.mjs', 'restart-with-checklist.mjs']) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(WORK, f), 'utf8'); } catch { /* 缺文件 */ }
  const guarded = /agent-write-lock/.test(txt) && /assertWriteRight|acquireWriteLock/.test(txt);
  ck(`[POS] ${f} 已纳入单写者锁`, guarded, guarded ? 'ok' : '未接线（并发交付/重启会互相覆盖）');
}

console.log('\n=== G5 重启清单登记：主槽被占时**必须拒绝**（接线断言）===');
// 2026-09-21 事故：主槽被探针的 dryRun 夹具占住时，重启清单只能**入队**，而 boot/心跳都只读主槽
// → 没人消费 → **重启后零唤醒**（静默死锁）。故 restart-with-checklist.mjs 必须在登记前检查并拒绝。
{
  let txt = '';
  try { txt = fs.readFileSync(path.join(WORK, 'restart-with-checklist.mjs'), 'utf8'); } catch { /* 缺文件 */ }
  const hasCheck = /拒绝登记/.test(txt) && /未销账/.test(txt) && /readHumanSignal/.test(txt);
  ck('[POS] restart-with-checklist.mjs 有"主槽被占 → 拒绝登记"的前置检查', hasCheck, hasCheck ? 'ok' : '缺前置检查：清单会静默入队 → 重启后零唤醒');
  const hasEscape = /--queue-ok/.test(txt);
  ck('[POS] 提供显式逃生口 --queue-ok（不把合法入队场景堵死）', hasEscape, hasEscape ? 'ok' : '缺逃生口');
  const beforeWrite = txt.indexOf('拒绝登记') < txt.indexOf('writeHumanSignalIfNew(');
  ck('[POS] 检查位于**写入之前**（顺序断言）', beforeWrite, beforeWrite ? 'ok' : '顺序不对：检查跑到写入之后了');
}

// ═══════════════════════════════════════════════════════════════════════════
// G5（v4.12.3，2026-09-23 实测）：合成夹具的**腾位**入口必须带硬守卫
// 背景：verify-autoir-events 走生产路径登记的合成熔断信号被销账后仍留在主槽
// （acknowledge 只打时间戳不移除），每次宿主重启去重集重置 → 主 agent 又为一条**不存在的 expr**被唤醒。
// 修法是加 clearSyntheticSignal（只清 synthetic===true）。此处把它锁进守卫测试：
//   正控 —— synthetic 夹具必须能被清；
//   负控 —— **真实告警（无标记）必须被拒绝且文件原样保留**（这条比正控更重要）。
console.log('\n=== G6 合成夹具腾位入口：只清 synthetic，真实告警必须被拒 ===');
{
  const tmp = path.join(os.tmpdir(), `sig-guard-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ id: 'synth#g1', chainId: 'x', reason: 'review-needed', stableKey: 'synth', generation: 1, at: new Date().toISOString(), synthetic: true }), 'utf8');
    const r1 = clearSyntheticSignal(tmp);
    ck('[POS] synthetic 夹具 → 允许清除且文件被删', r1.ok === true && !fs.existsSync(tmp), JSON.stringify(r1).slice(0, 80));

    const real = { id: 'real-alert#g1', chainId: 'real', reason: 'review-needed', stableKey: 'real-alert', generation: 1, at: new Date().toISOString(), acknowledgedAt: new Date().toISOString() };
    fs.writeFileSync(tmp, JSON.stringify(real), 'utf8');
    const r2 = clearSyntheticSignal(tmp);
    const kept = fs.existsSync(tmp) && JSON.parse(fs.readFileSync(tmp, 'utf8')).id === 'real-alert#g1';
    ck('[NEG] 真实告警（无标记）→ 必须拒绝且原样保留', r2.ok === false && kept, `ok=${r2.ok} 保留=${kept}`);

    fs.rmSync(tmp, { force: true });
    const r3 = clearSyntheticSignal(tmp);
    ck('[NEG] 主槽为空 → 返回 ok:false 且不抛错', r3.ok === false, String(r3.reason).slice(0, 36));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const bad = results.filter((r) => !r.cond).length;
console.log(`\nRESULT: ${results.length - bad}/${results.length} ${bad ? 'FAIL' : 'PASS'}`);
process.exit(bad ? 1 : 0);
