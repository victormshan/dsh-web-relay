// 「链条停下等人」的信号：把"需要主 agent 介入"从**只写给人看的 md** 升级为**机器可读的信号文件**，
// 供插件在 boot / 周期心跳时读取并唤醒主 agent（否则链条停在后只能静静等人来看）。
//
// 背景（2026-09-18 实测）：v11 因旧验收规则被判 REJECT → 护栏 `已连续失败 3 次（上限 3）→ 停止链条并等人处理`，
// 之后**没有任何机制**去叫醒主 agent；主 agent 之所以回来复核，是因为人问了一句。
// 现有两条续跑机制（boot 事件 + 15 分钟心跳）只续 `web-relay/experiments/*.steps.json` 里"忙"的计划步，
// 表达不了"链条停下等人"这件事（它不是计划步）。
//
// 什么算"需要人"（只登记真正需要人判断的，否则会变成告警疲劳）：
//   · too-many-attempts   —— 单项连续失败达上限，护栏停止链条
//   · instrument-error    —— 验收器自己坏了（exit 3 / probe-broken），必须人修工具
//   · review-needed       —— 链条跑完但有项待协议复核/收口（原本只产出 chain-review-needed.md）
// 什么**不**算：额度耗尽（会自动等配额重置，是设计内行为）、正常跳过（已完成/无指针）。
import fs from 'node:fs';

import { assertWriteRight } from './agent-write-lock.mjs'

export const SIGNAL_PATH = 'D:\\cc-tasks\\chain-needs-human.json';

/** 允许的"需要人"理由。**白名单**：不在其中的一律拒绝 —— 否则每次额度暂停都唤醒主 agent = 告警疲劳。 */
export const ALLOWED_REASONS = ['too-many-attempts', 'instrument-error', 'review-needed', 'audit-action-needed'];

/** 纯函数：构造一条信号（不碰磁盘，便于两侧自检）。
 *
 * 两种 id 形态（2026-09-18 新增 stableKey，用于"同源失败只叫一次"）：
 *   · 默认：`chainId|reason|taskId|时间` —— 每次都是新 id → 每次都唤醒（适合"每次都值得人看"的事件，如链条护栏触发）；
 *   · stableKey：`<stableKey>#g<代数>` —— **同源重复失败复用同一代数**（插件按 id 去重 → 只叫一次）；
 *     销账后若复发，writeHumanSignalIfNew 会把代数 +1 → 新 id → **重新叫醒**。
 * 这条设计是为了让"每 30 分钟失败一次的审计"不 30 分钟吵一次人，也不会在人销账后永远沉默。
 */
export function buildHumanSignal({ chainId, reason, taskId = null, detail = '', lastVerdict = null, attempts = null, stableKey = null, generation = 1, now = new Date().toISOString() }) {
  if (!chainId) throw new Error('buildHumanSignal: chainId 必填');
  if (!ALLOWED_REASONS.includes(reason)) throw new Error(`buildHumanSignal: 未知 reason ${reason}（只允许 ${ALLOWED_REASONS.join('/')}）`);
  const id = stableKey ? `${stableKey}#g${generation}` : `${chainId}|${reason}|${taskId || '-'}|${now}`;
  return {
    id,
    chainId,
    reason,
    taskId,
    detail: String(detail || '').slice(0, 2000),
    lastVerdict,
    attempts,
    at: now,
    acknowledgedAt: null,
    ackNote: null,
    ...(stableKey ? { stableKey, generation } : {}),
  };
}

/**
 * 幂等写入（stableKey 语义 + **主槽/队列**）：
 *   · 同一 stableKey 且**未销账** → 不重复写 → 插件按 id 去重，不会重复唤醒；
 *   · 同一 stableKey 但**已销账**（人处理过）→ 代数 +1 重写 → 新 id → **会再次唤醒**（复发要能叫）；
 *   · **主槽被别的来源的未销账信号占着** → 入队（`<file>.queue.json`），**绝不顶掉** ——
 *     单槽文件直接覆盖会让一条尚未处理的告警**静默消失**（本文件初版就是这个缺陷，被自检用例抓到）；
 *   · 其它（无文件 / 主槽已销账）→ 写主槽。
 */
export function writeHumanSignalIfNew(signal, file = SIGNAL_PATH) {
  assertWriteRight({ what: '写信号通道（writeHumanSignalIfNew）' })
  const cur = readHumanSignal(file);
  if (signal.stableKey && cur.ok && cur.entry && cur.entry.stableKey === signal.stableKey) {
    if (!cur.entry.acknowledgedAt) {
      return { written: false, reason: '同一来源的未销账信号已存在 → 不重复写（避免周期性告警疲劳）', signal: cur.entry };
    }
    const g = Number(cur.entry.generation || 1) + 1;
    const next = { ...signal, generation: g, id: `${signal.stableKey}#g${g}` };
    writeHumanSignal(next, file);
    return { written: true, reason: `上一代已销账 → 代数 +1（g${g}）重新登记（复发要能再次唤醒）`, signal: next };
  }
  if (cur.ok && cur.entry && !cur.entry.acknowledgedAt) {
    // 主槽被别的来源占着且未销账 → 入队，等它被销账后自动提升（不丢告警）
    const q = readQueue(file).filter((e) => e.stableKey !== signal.stableKey);
    q.push(signal);
    writeQueue(file, q);
    return { written: true, queued: true, reason: `主槽被「${cur.entry.stableKey || cur.entry.chainId}」占用且未销账 → 入队（队列 ${q.length} 条），销账后自动提升`, signal };
  }
  writeHumanSignal(signal, file);
  return { written: true, reason: '写入主槽', signal };
}

/** 队列文件路径：与主槽同目录，`xxx.json` → `xxx.queue.json` */
export const queuePathOf = (file = SIGNAL_PATH) => file.replace(/\.json$/i, '.queue.json');

/**
 * 信号通道的**三个合法写入目标** + 写前路径断言。
 *
 * 为什么必须有（2026-09-20 实测事故）：我在**内联 PowerShell** 里用 `p.replace(/\.json$/i,'.queue.json')`
 * 计算"规范队列路径"，PowerShell 吃掉了正则里的 `$` → 变量落回**主槽**路径 → 清理脚本把 `[]` 写进了主槽，
 * **销毁了一条未销账信号**（durable 留痕丢失）。一个能把主槽清成 `[]` 的清理脚本，比它要清理的残留危险得多。
 * 故：凡写信号通道，路径**只能来自本模块**，且写前必须过 assertSignalPath（未列入的目标直接抛错）。
 */
export function signalFiles(file = SIGNAL_PATH) {
  return { main: file, queue: queuePathOf(file), legacyQueue: `${file}.queue.json` };
}
export function assertSignalPath(target, file = SIGNAL_PATH) {
  const known = signalFiles(file);
  const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
  const t = norm(target);
  if (t === norm(known.main)) return { ok: true, kind: 'main' };
  if (t === norm(known.queue)) return { ok: true, kind: 'queue' };
  if (t === norm(known.legacyQueue)) return { ok: true, kind: 'legacy-queue' };
  throw new Error(`assertSignalPath: 拒绝写入未知路径 ${target}（只允许主槽/规范队列/历史队列三个目标）`);
}
/** 主槽只接受**合法信号形状**；数组/空对象/缺字段一律拒绝（这条本可阻止 2026-09-20 那次 `[]` 覆盖）。
 *  导出以便门禁**纯函数式**验证它（不必真去写主槽）。 */
export function assertSignalShape(signal) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) throw new Error('writeHumanSignal: 主槽只接受信号对象（非数组/非空）');
  for (const k of ['id', 'chainId', 'reason']) if (!signal[k]) throw new Error(`writeHumanSignal: 信号缺必填字段 ${k}（拒绝写入，避免毁掉主槽）`);
  return signal;
}

export function readQueue(file = SIGNAL_PATH) {
  // ⚠ 2026-09-20 实测缺陷：队列曾有**两种路径**（<基础名>.queue.json 与 <全名>.queue.json）与**两种格式**
  //   （裸数组 与 {queue:[…]}）。只认一种会让另一方的条目**永久不可见**——插件入队的告警提升不到 =
  //   静默失败（正是本机制要防的），且两个写方会互相覆盖丢条目。
  //   规范＝`<基础名>.queue.json` + **裸数组**（插件侧已同步改为该约定）；读取**两者都认**，避免存量搁浅丢失。
  const paths = [queuePathOf(file), `${file}.queue.json`];
  const out = [];
  const seen = new Set();
  for (const p of paths) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      const arr = Array.isArray(j) ? j : Array.isArray(j && j.queue) ? j.queue : [];
      for (const e of arr) { if (e && e.id && !seen.has(e.id)) { seen.add(e.id); out.push(e); } }
    } catch { /* 该路径不存在 */ }
  }
  return out;
}

const isRealQueue = (p) => String(p).replace(/\\/g, '/').toLowerCase() === String(queuePathOf(SIGNAL_PATH)).replace(/\\/g, '/').toLowerCase();

function writeQueue(file, arr) {
  if (!Array.isArray(arr)) throw new Error('writeQueue: 队列内容必须是数组')
  fs.writeFileSync(queuePathOf(file), JSON.stringify(arr, null, 2), 'utf8');
}

/** 从队列移除指定 id 的条目（**两种路径都清**：规范 `<基础名>.queue.json` + 历史 `<全名>.queue.json`），
 *  否则 readQueue 的合并读取会让"已清掉"的条目从另一条路径又冒出来。
 *  这是队列**格式权威**该提供的操作——此前两处探针各自实现了一遍，正是 L-092 说的"同一格式多个实现"。
 *  ⚠ 只动队列，**绝不动主槽**（主槽可能躺着真实告警，误清比漏清严重得多）。 */
export function removeQueueEntry(id, file = SIGNAL_PATH) {
  assertWriteRight({ what: '写信号通道（removeQueueEntry）' })
  const kept = readQueue(file).filter((e) => e && e.id !== id);
  writeQueue(file, kept);
  try { fs.writeFileSync(`${file}.queue.json`, JSON.stringify([], null, 2), 'utf8'); } catch { /* 无历史路径 */ }
  return kept.length;
}

/**
 * 条件自愈：来源已恢复正常时，把该来源**未销账**的信号自动销账（附说明）。
 * 主槽与队列都查；只动同一 stableKey 的条目 —— 否则一条早已自愈的告警会一直挂着，还会挡住后续复发的登记。
 */
export function resolveHumanSignal(stableKey, note = '', file = SIGNAL_PATH) {
  const stamp = { at: new Date().toISOString(), note: String(note || 'auto-resolved: source recovered').slice(0, 500) };
  const cur = readHumanSignal(file);
  if (cur.ok && cur.entry && cur.entry.stableKey === stableKey && !cur.entry.acknowledgedAt) {
    cur.entry.acknowledgedAt = stamp.at;
    cur.entry.ackNote = stamp.note;
    writeHumanSignal(cur.entry, file);
    return { resolved: true, entry: cur.entry };
  }
  const q = readQueue(file);
  const hit = q.find((e) => e.stableKey === stableKey && !e.acknowledgedAt);
  if (hit) {
    hit.acknowledgedAt = stamp.at;
    hit.ackNote = stamp.note;
    writeQueue(file, q);
    return { resolved: true, entry: hit, inQueue: true };
  }
  return { resolved: false, reason: '无同源未销账信号' };
}

/** 读信号文件：容错（缺失/坏 JSON/形状不对 → { ok:false }，绝不抛）。 */
export function readHumanSignal(file = SIGNAL_PATH) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, exists: false, entry: null, error: e.code === 'ENOENT' ? '信号文件不存在（= 无需人介入）' : e.message };
  }
  let j;
  try { j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch (e) {
    return { ok: false, exists: true, entry: null, error: `信号文件不是合法 JSON：${e.message}` };
  }
  if (!j || typeof j !== 'object' || !j.id || !j.chainId || !j.reason) {
    return { ok: false, exists: true, entry: null, error: '信号文件形状不对（缺 id/chainId/reason）' };
  }
  return { ok: true, exists: true, entry: j, error: null };
}

/** 目标是否就是**真实通道**的主槽（只有它对形状严格；显式传入的其它路径视为测试覆盖/夹具）。 */
const isRealMain = (p) => String(p).replace(/\\/g, '/').toLowerCase() === String(SIGNAL_PATH).replace(/\\/g, '/').toLowerCase();

/** 写信号（幂等覆盖）。守卫：单写者锁 + **真实主槽的形状校验**。
 *  ⚠ 作用域（2026-09-20 修正）：形状/路径的严格检查**只对真实通道**生效；显式传入其它路径（各门禁的自检用临时文件
 *  隔离真实通道）必须放行 —— 初版对所有路径都做白名单断言，直接把 ⑫/⑬ 的夹具自检判死（被 ③ 当场抓到）。
 *  另注：路径白名单**单独并不足以**防住当天那次事故（我把"规范队列"算成了主槽——两者都是合法路径），
 *  真正拦住它的是**形状校验**（`[]` 不是合法信号）。两者并存，各防一面。 */
export function writeHumanSignal(signal, file = SIGNAL_PATH) {
  assertWriteRight({ what: '写信号通道（writeHumanSignal）' })
  if (isRealMain(file)) assertSignalShape(signal)
  else if (Array.isArray(signal) && isRealQueue(queuePathOf(file))) throw new Error('writeHumanSignal: 队列目标只接受数组（队列 = 裸数组）')
  fs.writeFileSync(file, JSON.stringify(signal, null, 2), 'utf8');
  return file;
}

/** 主 agent 处理后销账，并**自动提升队列里的下一条**（给新代数 → 新 id → 插件会为它再次唤醒）。 */
export function acknowledgeHumanSignal(note = '', file = SIGNAL_PATH) {
  assertWriteRight({ what: '写信号通道（acknowledgeHumanSignal）' })
  const r = readHumanSignal(file);
  if (!r.ok) return { ok: false, error: r.error };
  r.entry.acknowledgedAt = new Date().toISOString();
  r.entry.ackNote = String(note || '').slice(0, 500);
  writeHumanSignal(r.entry, file);
  // 提升：队列非空 → 取下一条进主槽（代数 +1，确保 id 与刚销账的那条不同，插件才会再唤醒）
  let promoted = null;
  const q = readQueue(file);
  if (q.length) {
    const [head, ...rest] = q;
    const g = Number(head.generation || 1) + 1;
    promoted = { ...head, generation: g, id: head.stableKey ? `${head.stableKey}#g${g}` : head.id, acknowledgedAt: null, ackNote: null };
    writeQueue(file, rest);
    writeHumanSignal(promoted, file);
  }
  return { ok: true, entry: promoted || r.entry, acked: r.entry, promoted };
}
