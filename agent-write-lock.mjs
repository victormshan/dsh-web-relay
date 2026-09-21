// 工作区**单写者锁** —— 防止两个 agent 会话并发写同一批文件（2026-09-20 实测事故的机制性修复）。
//
// 事故回顾：用户在手机上**刷新**后 GUI 换到新会话，而 expr 仍绑着刷新前那个 → 插件把唤醒投给旧会话
// → **两个"我"同时活着**并写同一个工作区。后果实测：旧会话用内联 PowerShell 正则计算"规范队列路径"时
// `$` 被吃掉，落回主槽路径，把 `D:\cc-tasks\chain-needs-human.json` 写成了 `[]`，**销毁了一条未销账
// 信号的 durable 记录**。这正说明：整个验证体系依赖的"唯一权威工作树"前提，**没有机制保障**。
//
// 语义（刻意简单，宁可少保护也不要误锁）：
//   · 锁文件 = 工作区内的 `.agent-write-lock.json`，内容 { owner, at, pid, note }。
//   · **无锁 / 锁已过期 / owner 就是我** → 允许写（单会话场景完全透明，不引入摩擦）。
//   · **他人持有且未过期** → 拒绝写（调用方应报工具错误退出，而不是"悄悄照写"）。
//   · TTL（默认 30 分钟）：防止某个会话崩溃后把工作区永久锁死。
//   · 释放只允许 owner 自己释放（防"把别人的锁删了"这种二次伤害）。
//
// 只保护**互相覆盖会丢数据**的写入：信号文件、重启请求、三副本交付。只读操作一律不锁。
import fs from 'node:fs';
import path from 'node:path';

export const WORK = 'D:\\dsh relay test';
export const LOCK_PATH = path.join(WORK, '.agent-write-lock.json');
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** 读锁（不抛）。 */
export function readLock(file = LOCK_PATH) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j.owner === 'string' && j.owner) return { ok: true, lock: { owner: j.owner, at: j.at || null, pid: j.pid || null, note: j.note || '' } };
    return { ok: false, lock: null, error: '锁文件形态非法' };
  } catch (err) {
    return { ok: false, lock: null, error: String((err && err.message) || err) };
  }
}

/** 判定某会话当前是否有写权。返回 { allowed, reason, owner, ageMs }。 */
export function checkWriteRight({ sessionId = process.env.DSH_SESSION_ID || null, file = LOCK_PATH, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const r = readLock(file);
  if (!r.ok) return { allowed: true, reason: '无锁（或锁不可读）→ 放行', owner: null, ageMs: null };
  const ageMs = r.lock.at ? now - Date.parse(r.lock.at) : Infinity;
  if (r.lock.owner === sessionId) return { allowed: true, reason: '锁属于本会话', owner: r.lock.owner, ageMs };
  if (!Number.isFinite(ageMs) || ageMs > ttlMs) {
    return { allowed: true, reason: `他人锁已过期（age=${Number.isFinite(ageMs) ? Math.round(ageMs / 60000) + 'min' : 'unknown'} > ttl）→ 允许接管`, owner: r.lock.owner, ageMs };
  }
  return { allowed: false, reason: `另一个会话持有写锁（owner=${r.lock.owner}，${Math.round(ageMs / 60000)} 分钟前取得）——并发写会互相覆盖`, owner: r.lock.owner, ageMs };
}

/** 取写权：允许则写锁并返回 ok；被他人持有则返回 ok:false（**不**覆盖别人的锁）。 */
export function acquireWriteLock({ sessionId = process.env.DSH_SESSION_ID || null, note = '', file = LOCK_PATH, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  // ⚠ 2026-09-20 回归修复：**无身份者一律放行且不写锁**。
  //   起因：计划任务用 wscript.exe 跑周期审计 → 环境无 DSH_SESSION_ID → 初版在这里**抛错**，
  //   导致所有会写信号的闸门在审计里崩溃 → ③ 门禁自审每 30 分钟必 FAIL（实测被审计当场抓到）。
  //   这是 L-086 同型错误：把能力/可用性建立在不存在的 env 上。锁的用途是区分**两个 agent 会话**
  //   （那才需要身份）；无人值守路径不是"第二个会话"，挡死它只会制造永久假失败。故：放行、不取锁。
  if (!sessionId) {
    return { ok: true, anonymous: true, reason: '无 DSH_SESSION_ID（计划任务/非交互路径）→ 放行且不取锁' };
  }
  const c = checkWriteRight({ sessionId, file, ttlMs, now });
  if (!c.allowed) return { ok: false, reason: c.reason, owner: c.owner };
  try {
    fs.writeFileSync(file, JSON.stringify({ owner: sessionId, at: new Date(now).toISOString(), pid: process.pid, note: String(note).slice(0, 120) }, null, 2), 'utf8');
    const back = readLock(file);
    if (!back.ok || back.lock.owner !== sessionId) return { ok: false, reason: '取锁后回读不一致（工具错误）' };
    return { ok: true, owner: sessionId, tookOver: c.owner && c.owner !== sessionId ? c.owner : null };
  } catch (err) {
    return { ok: false, reason: `写锁失败：${String((err && err.message) || err)}` };
  }
}

/** 释放（仅 owner 自己）。 */
export function releaseWriteLock({ sessionId = process.env.DSH_SESSION_ID || null, file = LOCK_PATH } = {}) {
  const r = readLock(file);
  if (!r.ok) return { ok: true, reason: '无锁' };
  if (r.lock.owner !== sessionId) return { ok: false, reason: `锁属于 ${r.lock.owner}，本会话无权释放（不做二次伤害）` };
  try { fs.unlinkSync(file); return { ok: true, reason: '已释放' }; } catch (err) { return { ok: false, reason: String((err && err.message) || err) }; }
}

/**
 * 写前守卫：被他人持锁则**抛错**（调用方应据此报工具错误退出，而不是照写）。
 * 单会话场景（无锁/自己持锁）自动取得写权，零摩擦。
 */
export function assertWriteRight({ sessionId = process.env.DSH_SESSION_ID || null, what = '写操作', file = LOCK_PATH, ttlMs = DEFAULT_TTL_MS } = {}) {
  const a = acquireWriteLock({ sessionId, note: what, file, ttlMs });
  if (!a.ok) {
    const err = new Error(`[单写者锁] 拒绝${what}：${a.reason}`);
    err.code = 'EWRITELOCK';
    throw err;
  }
  return a;
}
