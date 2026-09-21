// 单写者锁门禁：① 锁语义两侧自检（临时文件，不碰真锁）；② 三个破坏性写入者的接线断言（含变异自证）。
//
// 起因（2026-09-20 实测事故）：用户刷新后 GUI 换到新会话，而 expr 仍绑旧会话 → 插件把唤醒投给旧会话 →
// **两个"我"并发写同一工作区**；旧会话用内联 PowerShell 正则算队列路径时 `$` 被吃掉，把主槽信号文件
// 写成 `[]`，销毁了一条未销账信号的 durable 记录。整套验证体系依赖的"唯一权威工作树"前提没有机制保障。
//
// 用法: node verify-single-writer.mjs [--json]
//       node verify-single-writer.mjs --selftest   # 两侧（[POS] 放行/接管 + [NEG] 拒绝/越权释放）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkWriteRight, acquireWriteLock, releaseWriteLock, readLock, DEFAULT_TTL_MS } from './agent-write-lock.mjs';

export const WORK = 'D:\\dsh relay test';
const WRITERS = [
  // ⚠ 断言必须落在**调用形态** `assertWriteRight({` 上，不能只断言词出现——import 行里也有这个词，
  //   于是"摘掉调用、留下 import"会照样通过（本文件初版正是如此，被自己的变异负控抓到）。
  { file: 'chain-human-signal.mjs', why: '信号主槽/队列写入', must: /assertWriteRight\(\{/ },
  { file: 'restart-with-checklist.mjs', why: '登记清单 + 请求重启', must: /assertWriteRight\(\{/ },
  { file: 'deliver-three-copies.mjs', why: '覆盖运行副本', must: /if \(apply\) assertWriteRight\(\{/ },
];

/** 纯函数：对给定文件文本断言"写者接了锁"。 */
export function checkWiring(files) {
  const violations = [];
  for (const w of WRITERS) {
    const t = files[w.file];
    if (typeof t !== 'string') { violations.push(`W 读不到 ${w.file}`); continue; }
    if (!/agent-write-lock\.mjs/.test(t)) violations.push(`W ${w.file} 未引入 agent-write-lock（${w.why} 不受保护）`);
    if (!w.must.test(t)) violations.push(`W ${w.file} 未在写路径调用 assertWriteRight（${w.why} 不受保护）`);
  }
  return { ok: violations.length === 0, violations };
}

if (process.argv.includes('--selftest')) {
  const cases = [];
  const t = (label, cond, detail = '') => { cases.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writelock-'));
  const lf = path.join(dir, 'lock.json');
  const ME = 'session-me', OTHER = 'session-other';
  const now = Date.parse('2026-09-20T19:00:00.000Z');

  // ---- 锁语义两侧 ----
  t('[POS] 无锁 → 允许写', checkWriteRight({ sessionId: ME, file: lf, now }).allowed === true);
  const a1 = acquireWriteLock({ sessionId: ME, file: lf, now, note: '自检' });
  t('[POS] 取锁成功且回读一致', a1.ok === true && readLock(lf).lock.owner === ME, `owner=${readLock(lf).lock && readLock(lf).lock.owner}`);
  t('[POS] 自己已持锁 → 再取仍允许（幂等，不引入摩擦）', checkWriteRight({ sessionId: ME, file: lf, now }).allowed === true);
  t('[NEG] **他人**持锁且未过期 → 拒绝写，且不覆盖他人锁', (() => {
    const c = checkWriteRight({ sessionId: OTHER, file: lf, now });
    const a = acquireWriteLock({ sessionId: OTHER, file: lf, now });
    return c.allowed === false && a.ok === false && readLock(lf).lock.owner === ME;
  })(), checkWriteRight({ sessionId: OTHER, file: lf, now }).reason);
  t('[NEG] 非 owner 尝试释放 → 拒绝（不做二次伤害）', releaseWriteLock({ sessionId: OTHER, file: lf }).ok === false && readLock(lf).lock.owner === ME);
  t('[POS] 他人锁**过期**（> TTL）→ 允许接管，并在回执里标明接管了谁', (() => {
    const later = now + DEFAULT_TTL_MS + 60_000;
    const a = acquireWriteLock({ sessionId: OTHER, file: lf, now: later });
    return a.ok === true && a.tookOver === ME && readLock(lf).lock.owner === OTHER;
  })());
  t('[POS] owner 自己释放 → 成功且锁文件消失', releaseWriteLock({ sessionId: OTHER, file: lf }).ok === true && readLock(lf).ok === false);
  // 2026-09-20 回归修复：无身份者（计划任务审计）必须放行，否则无人值守路径每 30 分钟假失败一次。
  t('[POS] 无 sessionId 标识（计划任务/非交互）→ 放行且**不取锁**',
    (() => { const a = acquireWriteLock({ sessionId: null, file: lf, now }); return a.ok === true && a.anonymous === true; })());
  t('[NEG] 无身份者**不得覆盖**他人已持有的锁（放行 ≠ 夺锁）',
    (() => {
      const f2 = path.join(dir, 'lock2.json');
      acquireWriteLock({ sessionId: ME, file: f2, now });
      const a = acquireWriteLock({ sessionId: null, file: f2, now });
      return a.ok === true && readLock(f2).lock.owner === ME;
    })());

  // ---- 接线断言（静态）+ 变异自证 ----
  const files = {};
  for (const w of WRITERS) files[w.file] = fs.readFileSync(path.join(WORK, w.file), 'utf8');
  const r = checkWiring(files);
  t('[POS] 三个破坏性写入者都接了锁', r.ok === true, r.violations.join('；'));
  const mut = (label, file, fn) => {
    const m = fn(files[file]);
    if (m === files[file]) { t(`${label} — ⚠ 负控空转：变异未改文本`, false); return; }
    const f2 = { ...files, [file]: m };
    t(label, checkWiring(f2).ok === false);
  };
  mut('[NEG] 摘掉信号通道的锁（保留 import）→ 抓', 'chain-human-signal.mjs', (s) => s.replace(/assertWriteRight\(\{/g, 'noopWriteRight({'));
  mut('[NEG] 摘掉重启登记的锁（保留 import）→ 抓', 'restart-with-checklist.mjs', (s) => s.replace(/assertWriteRight\(\{/g, 'noopWriteRight({'));
  mut('[NEG] 摘掉交付的锁（保留 import）→ 抓', 'deliver-three-copies.mjs', (s) => s.replace(/if \(apply\) assertWriteRight\(\{/, 'if (false) assertWriteRight({'));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  const bad = cases.filter((c) => !c.cond).length;
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

// ---- 实跑：报锁现状 + 接线断言 ----
const lk = readLock();
console.log('=== 单写者锁 ===');
console.log(`  本会话 = ${process.env.DSH_SESSION_ID || '(无 DSH_SESSION_ID)'}`);
console.log(`  锁 = ${lk.ok ? `${lk.lock.owner}（${lk.lock.at}，note=${lk.lock.note}）` : '(无锁)'}`);
const files = {};
for (const w of WRITERS) { try { files[w.file] = fs.readFileSync(path.join(WORK, w.file), 'utf8'); } catch { /* 缺文件由 checkWiring 报 */ } }
const r = checkWiring(files);
for (const v of r.violations) console.log(`  ✗ ${v}`);
console.log(`\n  RESULT: ${r.ok ? 'PASS（三个破坏性写入者都受单写者锁保护）' : `FAIL（${r.violations.length} 项未保护）`}`);
process.exit(r.ok ? 0 : 1);
