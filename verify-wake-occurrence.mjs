// ⑨ 唤醒通路「实际发生」审计 —— 覆盖唯一一条"坏了就没人被叫醒"的能力。
//
// 为什么需要（2026-09-20 实测发现）：
//   分层审计的 ⑫/⑬ 门禁只用**夹具**验唤醒通路的**机制正确性**（合成信号 + dryRun + would-wake），
//   每 30 分钟跑一次；但**没有任何东西在验"上一次真实重启，boot 扫描到底有没有真的唤醒"**。
//   而这条能力的失败模式全系统独一份：**它坏了，后果就是"没人被叫醒"** —— 与一次安静的
//   无人值守空转在现象上完全一样（2026-09-19 已实测代价 4 小时）。
//   更糟的是勘查发现：信号唤醒路径**零 durable 痕迹** —— post-restart-verify#g1 那次真的叫醒了
//   主 agent，而宿主日志里一个字都没有（expr 续跑与 selfCheck 漂移都有留痕，唯独这条没有）。
//   进程内 wakeLedger 也不能替代：它是内存态、每次重启清零，正好缺"跨重启"这一维。
//   → 故本轮先在插件侧补 durable 痕迹（boot 必留一行 + 每个真实信号必留一行），本探针读它做断言。
//
// ── 判据（先定，后写实现；不得事后调整）────────────────────────────────────────
//   A 存在性：/health-check 的**活** bootId 必须出现在启动痕迹里，且痕迹最后一条 bootId 与它一致。
//       · 读不到活 bootId（HTTP 失败）      → 3 工具错误（不得假装通过）
//       · 痕迹里找不到该 bootId             → 4 未验证（证据缺失：日志轮转/痕迹未部署）
//       · 痕迹最后一条 ≠ 活 bootId          → 3 工具错误（"同源"假设被破坏，结论不可信）
//   B 因果性：若存在"当前 boot 之前登记、且跨过该 boot 仍未销账"的信号，
//       则该 boot 之后必须有 pendingHuman 痕迹且 decision ∈ {wake, would-wake}。
//       · 零痕迹                                     → 1 判定失败（有待办 + 重启 + 零唤醒 = 通路失灵）
//       · decision=wake 但 woken=false 且有 err      → 1 判定失败（判定要唤醒却没唤醒）
//   B2 历史成功证据：全日志必须至少有一条 decision=wake 且 woken=true。
//       · 一条都没有 → 4 未验证（"通路从未被观察到真的工作过" —— 不是失败，但**绝不是通过**）
//   C 欠条纪律（机械化 lesson L-088）：最近一次"主 agent 主动重启请求"，其 requestedAt 之前
//       必须已存在"跨过该请求仍待办或在其之后才销账"的对象。
//       · 违反 → 1 判定失败（重启后必然无人续跑 —— 2026-09-19 四小时空转的机器可检签名）
//
//   退出码语义（与分层审计一致）：0 通过 / 1 判定失败 / 3 工具错误 / 4 未验证(NOT-APPLICABLE)
//   **铁律：「未验证」不得读成「通过」**——这正是 ④ 层曾经把"对象不存在"判成违约(假告警)、
//   把"对象陈旧"判成通过(空转)的那类缺陷，本探针必须两面都不犯。
//
// 用法: node verify-wake-occurrence.mjs [--json]
//       node verify-wake-occurrence.mjs --selftest     # 两侧自检（含每种违约的负控）
import fs from 'node:fs';
import path from 'node:path';

export const LOG_PATH = 'C:/Users/Administrator/.dsh/logs/dsh-web-watchdog.log';
export const SIGNAL_PATH = 'D:\\cc-tasks\\chain-needs-human.json';
export const DEBT_LEDGER_PATH = 'D:\\cc-tasks\\restart-debts.ndjson';
const HEALTH_URL = 'http://127.0.0.1:3080/dsh-web-relay/health-check';

const BOOT_RE = /重启续跑扫描完成：.*?bootId=([A-Za-z0-9_-]+)/;
const WAKE_RE = /\[pendingHuman\]\s+phase=(\S+)\s+decision=(\S+)\s+woken=(\S+)\s+id=(\S+)\s+sid=(\S+)\s+reason=(\S+)(?:\s+err=(.*))?$/;
const RR_RE = /\[restart-request\]\s+收到主 agent 重启请求（requestedAt=(\S+?)\s/;
const HOST_UP_RE = /\[watchdog (\S+?)\]\s+拉起宿主/;

/** 解析启动痕迹（无时间戳 → 只取顺序与 bootId）。 */
export function parseBootLines(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const m = l.match(BOOT_RE);
    if (m) out.push({ idx: i, bootId: m[1], line: l.trim() });
  });
  return out;
}

/** 解析 pendingHuman 唤醒痕迹（无时间戳 → 用行序，只对"最后一次 boot 之后"的窗口做断言）。 */
export function parseWakeLines(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const m = l.match(WAKE_RE);
    if (m) out.push({ idx: i, phase: m[1], decision: m[2], woken: m[3] === 'true', id: m[4], sid: m[5], reason: m[6], err: m[7] || null, line: l.trim() });
  });
  return out;
}

/** 解析主 agent 主动重启请求（带 requestedAt）。 */
export function parseRestartRequests(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const m = l.match(RR_RE);
    if (m) out.push({ idx: i, requestedAt: m[1], line: l.trim() });
  });
  return out;
}

/** 解析宿主拉起时刻（带时间戳），用于把"boot 时刻"定位到绝对时间。 */
export function parseHostUp(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const m = l.match(HOST_UP_RE);
    if (m) out.push({ idx: i, at: m[1] });
  });
  return out;
}

/** 读信号（主槽 + 队列），保留 at/acknowledgedAt 供"跨重启待办"判定。
 *  ⚠ 实测踩坑（2026-09-20）：chain-needs-human.json 的主槽是**扁平记录**（顶层就是信号字段），
 *  不是 `{entry:{…}}`；初版按 `parsed.entry` 取 → 永远读到 0 条 → C 判据假告警。
 *  故两种形态都接受，避免对文件形态的隐含假设。
 */
export function readSignals(file = SIGNAL_PATH) {
  const out = [];
  const norm = (o) => {
    if (!o || !o.id) return null;
    return { id: o.id, stableKey: o.stableKey || null, generation: o.generation || null, at: o.at || null, acknowledgedAt: o.acknowledgedAt || null, reason: o.reason || null };
  };
  const push = (o) => { const n = norm(o && o.entry ? o.entry : o); if (n) out.push(n); };
  try { push(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* 无主槽 */ }
  try { const q = JSON.parse(fs.readFileSync(`${file}.queue.json`, 'utf8')); for (const e of (q.entry ? [q.entry] : q.queue) || []) push(e); } catch { /* 无队列 */ }
  return out;
}

/** 读重启欠条台账（restart-with-checklist.mjs 在发重启请求时追加的一行一条）。
 *  为什么需要：判断"重启那一刻有没有待办对象"必须用**当时留下的**证据；信号主槽会被后来源覆盖，
 *  不能事后反推（那正是 ④ 层把"对象不存在"判成违约的同型缺陷）。
 *  ⚠ 写方契约（restart-with-checklist.mjs）：`{at, debt, reason}` —— **没有 requestedAt**。
 *  初版按 `o.requestedAt` 过滤 → 永远 0 条 → C 假"未验证"（2026-09-20 实测；已由 --selftest-parsers 覆盖）。
 */
export function readDebtLedger(file = DEBT_LEDGER_PATH) {
  const out = [];
  try {
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const o = JSON.parse(l); if (o && o.at && o.debt !== undefined) out.push(o); } catch { /* 跳过坏行 */ }
    }
  } catch { /* 无台账 */ }
  return out;
}

const t = (s) => { const v = Date.parse(s); return Number.isFinite(v) ? v : null; };

/**
 * 纯函数：按判据 A/B/B2/C 给出结论。
 * @param {{liveBootId:string|null, bootLines:Array, wakeLines:Array, restartRequests:Array, hostUps:Array, signals:Array}} inp
 * @returns {{exit:number, findings:Array<{id:string,verdict:string,detail:string}>}}
 */
export function judgeWakeOccurrence(inp) {
  const { liveBootId = null, bootLines = [], wakeLines = [], restartRequests = [], hostUps = [], signals = [], debtLedger = [] } = inp || {};
  const findings = [];
  const add = (id, exit, detail) => findings.push({ id, verdict: exit === 0 ? 'PASS' : exit === 1 ? 'FAIL' : exit === 3 ? 'INSTRUMENT-ERROR' : 'UNVERIFIED', exit, detail });

  // ---- A 存在性 ----
  let bootLine = null;
  let bootTime = null;
  if (!liveBootId) {
    add('A-存在性', 3, '读不到活 bootId（/health-check 不可用）→ 无法断言，工具错误');
  } else if (bootLines.length === 0) {
    add('A-存在性', 4, '启动痕迹为空（日志轮转或痕迹机制未部署）→ 未验证，不得读成通过');
  } else {
    // 判据区分两种"对不上"：从未出现过（证据缺失→未验证）vs 出现过但不是最后一条（同源被破坏→工具错误）。
    // 初版把两者并成 3，被本文件自检的 [NEG] 用例抓到（期望 4 实得 3）——判据是对的，代码错了。
    const found = bootLines.find((b) => b.bootId === liveBootId);
    const last = bootLines[bootLines.length - 1];
    if (!found) {
      add('A-存在性', 4, `活 bootId=${liveBootId} 未出现在任何启动痕迹中（证据缺失：日志轮转或痕迹机制未部署）→ 未验证，不得读成通过`);
    } else if (last.bootId !== liveBootId) {
      add('A-存在性', 3, `痕迹最后一条 bootId=${last.bootId} ≠ 活 bootId=${liveBootId}（同源假设被破坏，结论不可信）`);
    } else {
      bootLine = last;
      add('A-存在性', 0, `活 bootId=${liveBootId} 与启动痕迹最后一条一致（启动扫描确实运行过）`);
      // boot 时刻：取该 boot 痕迹之前最近的一次「拉起宿主」时间戳
      const ups = hostUps.filter((u) => u.idx < bootLine.idx);
      if (ups.length) bootTime = t(ups[ups.length - 1].at);
    }
  }

  // ---- B 因果性（只对"当前 boot 之后"的窗口断言，用行序切窗口）----
  if (bootLine) {
    const pendingAtBoot = signals.filter((s) => {
      const at = t(s.at);
      if (at === null) return false;
      if (bootTime !== null && at > bootTime) return false; // 登记者在 boot 之后 → 不属于"跨过该 boot"
      const ack = t(s.acknowledgedAt);
      return s.acknowledgedAt === null || (ack !== null && (bootTime === null || ack > (bootTime ?? 0)));
    });
    const wakesAfterBoot = wakeLines.filter((w) => w.idx > bootLine.idx);
    if (pendingAtBoot.length === 0) {
      add('B-因果性', 0, '该 boot 时刻无跨重启未销账信号 → 无需唤醒（非空转：判据是"有对象才要求唤醒"）');
      add('B2-历史成功证据', wakeLines.some((w) => w.decision === 'wake' && w.woken) ? 0 : 4,
        wakeLines.some((w) => w.decision === 'wake' && w.woken)
          ? '痕迹中存在成功唤醒记录（decision=wake 且 woken=true）'
          : '全日志中没有任何成功的信号唤醒记录 → 未验证（"从未被观察到真的工作过"≠通过）');
    } else {
      const ids = pendingAtBoot.map((s) => s.id).join(', ');
      const attempted = wakesAfterBoot.filter((w) => w.decision === 'wake' || w.decision === 'would-wake');
      if (attempted.length === 0) {
        add('B-因果性', 1, `盘上有跨重启待办信号（${ids}）但该 boot 之后零唤醒痕迹 → 唤醒通路失灵（无人值守会静默停摆）`);
      } else {
        const failed = attempted.filter((w) => w.decision === 'wake' && !w.woken);
        add('B-因果性', failed.length ? 1 : 0,
          failed.length
            ? `有待办信号但唤醒未成功：${failed.map((w) => `${w.id}(${w.err || w.reason})`).join('; ')}`
            : `有待办信号且已尝试唤醒（${attempted.map((w) => w.decision).join(',')}）`);
      }
      add('B2-历史成功证据', wakeLines.some((w) => w.decision === 'wake' && w.woken) ? 0 : 4,
        wakeLines.some((w) => w.decision === 'wake' && w.woken) ? '存在成功唤醒记录' : '无成功唤醒记录 → 未验证');
    }
  }

  // ---- C 欠条纪律（最近一次主 agent 主动重启请求）----
  // 证据门控（2026-09-20 修正）：信号主槽是**单槽文件，会被后来源覆盖**，所以"事后从信号文件反推
  // 重启时刻有没有待办"是不成立的——那会把"证据已被覆盖"误判成"当时没有欠条"（假告警）。
  // 故本判据只在**当时留下的台账**（restart-debts.ndjson，由 restart-with-checklist.mjs 追加）里取证：
  //   · 台账有该请求的记录且 debt 为空        → 1 判定失败（可证明：重启时无待办对象）
  //   · 台账有该请求的记录且 debt=信号 id     → 0 通过（可证明：重启时确有欠条）
  //   · 台账无邻近记录（如工具引入之前的历史重启）→ 4 未验证（证据缺失，绝不读成通过也不判失败）
  const DEBT_WINDOW_MS = 15 * 60 * 1000;
  if (restartRequests.length === 0) {
    // 2026-09-21 语义修正（与 B / J5 的既有模式对齐）：**无对象 → 不适用**，不是"未验证"。
    // 起因：绝大多数周期没有重启，若这里返回 4，⑨ 会**长期**报未验证，使总判定永远停在 OK-WITH-GAPS ——
    // 那会稀释"未验证"这个词的分量（噪声）。真正的牙齿在下面：有请求但台账无记录 → 4（证据缺失）；
    // 台账明确 debt 为空 → 1（重启后必然无人续跑）。
    add('C-欠条纪律', 0, '日志中无主 agent 主动重启请求 → 本周期**无对象可判**（不适用；无对象≠未验证，与 B/J5 同模式）');
  } else {
    const rr = restartRequests[restartRequests.length - 1];
    const reqAt = t(rr.requestedAt);
    if (reqAt === null) {
      add('C-欠条纪律', 3, `重启请求的 requestedAt 不可解析：${rr.requestedAt}`);
    } else {
      // 邻近匹配而非精确等值：requestedAt 由 watchdog 生成，工具侧拿不到同一个时间戳；
      // 取"请求时刻之前 15 分钟内、且最近的一条"欠条记录（窗口写死并注释，不随判定调整）。
      const rec = (inp.debtLedger || [])
        .map((d) => ({ ...d, _at: t(d.at) }))
        .filter((d) => d._at !== null && d._at <= reqAt && reqAt - d._at <= DEBT_WINDOW_MS)
        .sort((a, b) => a._at - b._at)
        .at(-1);
      if (!rec) {
        add('C-欠条纪律', 4, `最近一次重启请求（${rr.requestedAt}）前 15 分钟内无欠条台账记录 → 当时是否有待办对象**无法证明**（证据缺失，未验证）。注：台账由 restart-with-checklist.mjs 追加，早于该工具的历史重启必然缺记录。`);
      } else if (!rec.debt) {
        add('C-欠条纪律', 1, `最近一次重启请求（${rr.requestedAt}）的欠条台账明确记录 debt 为空 → 重启后必然无人续跑（lesson L-088 的机器可检签名）`);
      } else {
        add('C-欠条纪律', 0, `最近一次重启请求（${rr.requestedAt}）携带欠条对象 ${rec.debt}（台账 ${rec.at}，成立）`);
      }
    }
  }

  // ---- D 清单不得在重启**之前**被消费（2026-09-20 现场新增）----
  // 缺口来源（实测）：登记"重启后核对清单"是为让它在**重启之后**被评估；但心跳先看到了它 ——
  // 于是出现过"重启还没执行，心跳先把我叫醒"，我按清单核对时 ⑤ 必然 FAIL（新代码还没加载）。
  // 注意**不要**写成"必须由 boot 消费"：由 boot 还是由 10 分钟后的心跳消费，对"核对发生在重启之后"
  // 这件事无关；过严会产生假失败（初版正是这么写的，被本文件自检抓到）。
  // 判据：取欠条台账最新债务（＝为最近一次重启登记的清单信号）。
  //   · 该重启尚未执行（无晚于请求的启动痕迹）→ N/A（无对象≠未验证）
  //   · 台账无带债务的记录 → 4 未验证
  //   · 该清单的**成功唤醒**全部发生在"重启后那次启动"之前 → **1 失败**（提前消费）
  //   · 存在重启之后的成功唤醒 → PASS
  //   · 尚无任何成功唤醒 → 0 并注明"尚无证据"（可能仍在队列，不得读成通过也不得判失败）
  {
    // ⚠ 2026-09-20 修正：判据对象改为「**当前最新登记**的清单信号」，不再用台账里的 debt id 去按**裸 id** 匹配唤醒。
    //   原因：signal id 的代数在主槽换源时归零 → `post-restart-verify#g1` 这个 id 今天被**多轮复用**，
    //   按 id 匹配会捞到更早几轮的唤醒 → D 假报"全部发生在重启之前"（实测 3 次唤醒全是旧轮次的）。
    //   取"最新登记的那一条"（按 at 最大）即当前这一轮的对象；它若登记于最后一次启动**之后**，说明它等的
    //   那次重启还没发生 → 不适用（无对象≠未验证）。
    const checklists = (signals || []).filter((s) => s && (s.chainId === 'post-restart-verify' || /^post-restart-verify/.test(String(s.stableKey || '')) || /^post-restart-verify/.test(String(s.id || ''))));
    const lastBoot = bootLines.length ? bootLines[bootLines.length - 1] : null;
    const cur = checklists.slice().sort((x, y) => (t(y.at) || 0) - (t(x.at) || 0))[0] || null;
    if (!lastBoot) {
      add('D-清单不得提前消费', 4, '无启动痕迹 → 无法判定"清单是否在重启之后才被消费"（未验证，不等于通过）');
    } else if (!cur) {
      add('D-清单不得提前消费', 0, '无重启核对清单信号（主槽/队列均无）→ 本判据**无对象可判**（不适用；无对象≠未验证，与 B/C/J5 同模式）');
    } else if (cur.acknowledgedAt) {
      // 2026-09-20 修（真实命中后的假失败）：清单**已销账**即生命周期闭环 → 不再判"提前消费"。
      // 不修的后果实测：清单销账后 D 仍按它的历史唤醒判 FAIL，**永久判红**（⑨ 一直红、审计一直 ACTION-NEEDED），
      // 正是我们反复吃过的"永久假失败 / 告警疲劳"类。历史命中仍如实写在 detail 里，只是不再阻断。
      const w0 = wakeLines.filter((w) => w.id === cur.id && w.decision === 'wake' && w.woken);
      add('D-清单不得提前消费', 0, `最新清单 ${cur.id} **已销账**（生命周期闭环）→ 不再判提前消费；其历史成功唤醒 ${w0.length} 次（若曾早于最后一次启动，已由人核对闭环）`)
    } else {
      const ups = hostUps.filter((u) => u.idx < lastBoot.idx);
      const bootAt = ups.length ? t(ups[ups.length - 1].at) : null;
      const regAt = t(cur.at);
      if (bootAt !== null && regAt !== null && regAt > bootAt) {
        add('D-清单不得提前消费', 0, `最新清单 ${cur.id} 登记于最后一次启动之后（${cur.at} > boot ${new Date(bootAt).toISOString()}）→ 它等的那次重启尚未发生，本判据本期不适用`);
      } else {
        const wakes = wakeLines.filter((w) => w.id === cur.id && w.decision === 'wake' && w.woken);
        const after = wakes.filter((w) => w.idx > lastBoot.idx);
        if (after.length) add('D-清单不得提前消费', 0, `最新清单 ${cur.id} 在最后一次启动之后被唤醒（${wakes.length} 次唤醒中 ≥1 次在启动痕迹之后）`);
        else if (wakes.length === 0) add('D-清单不得提前消费', 0, `最新清单 ${cur.id} 尚无成功唤醒痕迹（可能仍在队列/未到评估点）→ 本期无证据，不判失败也不读成通过`);
        else add('D-清单不得提前消费', 1, `最新清单 ${cur.id} 的 ${wakes.length} 次成功唤醒**全部发生在最后一次启动之前** → 核对会在错误时刻进行（重启尚未生效时就被要求核对）`);
      }
    }
  }

  const anyFail = findings.some((f) => f.exit === 1);
  const anyInstr = findings.some((f) => f.exit === 3);
  const anyUnver = findings.some((f) => f.exit === 4);
  return { exit: anyFail ? 1 : anyInstr ? 3 : anyUnver ? 4 : 0, findings };
}

// ---------------- 两侧自检 ----------------
// 2026-09-20 补：**解析器自检**。当天同类 bug 犯了两次（readSignals 按 {entry} 取而文件是扁平记录；
// readDebtLedger 按 requestedAt 过滤而写方写的是 at）——两次都骗过了"只测判定函数"的自检。
// 教训：判定纯函数自检 ≠ 输入解析自检；**写方契约必须用真实形态的夹具钉死**。
if (process.argv.includes('--selftest-parsers')) {
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-parsers-'));
  const cases = [];
  const ck = (name, cond, detail = '') => { cases.push({ name, cond }); console.log(`  [${cond ? 'PASS' : 'NEG-PASS'}] ${name}${detail ? ' — ' + detail : ''}`); };

  // 信号主槽：扁平记录（真实形态）
  const flat = path.join(dir, 'flat.json');
  fs.writeFileSync(flat, JSON.stringify({ id: 'x#g1', stableKey: 'x', generation: 1, at: '2026-09-20T12:00:00.000Z', acknowledgedAt: null }), 'utf8');
  ck('[POS] 扁平记录形态（顶层就是信号字段）能读出 1 条', readSignals(flat).length === 1, `读到 ${readSignals(flat).length} 条`);

  // 信号主槽：{entry:{…}} 形态（兼容）
  const wrap = path.join(dir, 'wrap.json');
  fs.writeFileSync(wrap, JSON.stringify({ entry: { id: 'y#g1', at: '2026-09-20T12:00:00.000Z' } }), 'utf8');
  ck('[POS] {entry:{…}} 形态同样能读出（向后兼容）', readSignals(wrap).length === 1, `读到 ${readSignals(wrap).length} 条`);

  // 队列：{queue:[…]}
  const q = path.join(dir, 'flat.json.queue.json');
  fs.writeFileSync(q, JSON.stringify({ queue: [{ id: 'z#g1', at: '2026-09-20T12:00:00.000Z' }] }), 'utf8');
  ck('[POS] 队列文件（.queue.json）能读出', readSignals(flat).length === 2, `读到 ${readSignals(flat).length} 条`);

  // 欠条台账：写方真实契约 {at,debt,reason}（**没有 requestedAt**）——这条正是当天漏掉的
  const ledger = path.join(dir, 'restart-debts.ndjson');
  fs.writeFileSync(ledger, JSON.stringify({ at: '2026-09-20T12:32:27.133Z', debt: 'post-restart-verify#g1', reason: 'x' }) + '\n' + '{坏行\n', 'utf8');
  const recs = readDebtLedger(ledger);
  ck('[POS] 欠条台账按写方真实键（at/debt/reason）能读出，且坏行被跳过', recs.length === 1 && recs[0].debt === 'post-restart-verify#g1', `读到 ${recs.length} 条`);

  // 负控：只改字段名（requestedAt 而非 at）必须读不出来 —— 证明这条自检真的在验契约，而不是永真
  const wrong = path.join(dir, 'wrong.ndjson');
  fs.writeFileSync(wrong, JSON.stringify({ requestedAt: '2026-09-20T12:32:27.133Z', debt: 'x#g1' }) + '\n', 'utf8');
  ck('[NEG] 字段名不符（requestedAt 而非 at）读不出 → 自检确实在验契约', readDebtLedger(wrong).length === 0, `读到 ${readDebtLedger(wrong).length} 条`);

  const bad = cases.filter((c) => !c.cond).length;
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--selftest')) {
  const BL = (id) => ({ idx: 10, bootId: id, line: `boot ${id}` });
  const WL = (o) => ({ idx: 20, phase: 'boot', decision: 'wake', woken: true, id: 'sig#g1', sid: 'recent-expr', reason: 'ok', err: null, line: 'wake', ...o });
  const base = {
    liveBootId: 'b1', bootLines: [BL('b1')], wakeLines: [WL({ id: 'post-restart-verify#g1' })],
    restartRequests: [{ idx: 5, requestedAt: '2026-09-19T22:40:10.159Z', line: 'rr' }],
    hostUps: [{ idx: 9, at: '2026-09-19T22:41:53.311Z' }],
    signals: [{ id: 'post-restart-verify#g1', chainId: 'post-restart-verify', stableKey: 'post-restart-verify', reason: 'review-needed', at: '2026-09-19T22:40:05.000Z', acknowledgedAt: '2026-09-19T22:49:28.000Z' }],
    debtLedger: [{ at: '2026-09-19T22:40:05.000Z', debt: 'post-restart-verify#g1' }],
  };
  const cases = [
    ['[POS] 活 bootId 一致 + 跨重启待办 + 有成功唤醒 + 欠条成立 → 通过', base, 0],
    ['[NEG] 有待办信号但该 boot 后零唤醒痕迹 → 判失败（通路失灵）',
      { ...base, wakeLines: [] }, 1],
    ['[NEG] 有待办信号但 decision=wake 却 woken=false 且带 err → 判失败',
      { ...base, wakeLines: [WL({ woken: false, err: 'session-not-found' })] }, 1],
    ['[POS] would-wake(dryRun) 也算"已尝试"（B 通过）；但历史无成功记录 → 整体仍未验证(4)',
      { ...base, wakeLines: [WL({ decision: 'would-wake', woken: false })] }, 4],
    ['[NEG] 台账记录明确 debt 为空 → 判失败（可证明：重启时无欠条 = L-088 签名）',
      { ...base, debtLedger: [{ at: '2026-09-19T22:40:05.000Z', debt: null }] }, 1],
    ['[NEG] 台账无邻近记录 → 未验证(4)（证据缺失，既不判失败也不判通过）',
      { ...base, debtLedger: [] }, 4],
    ['[NEG] 台账记录太旧（超出 15 分钟窗口）→ 未验证(4)，不得当成欠条成立',
      { ...base, debtLedger: [{ at: '2026-09-19T22:00:00.000Z', debt: 'post-restart-verify#g1' }] }, 4],
    ['[NEG] 活 bootId 不在痕迹里 → 未验证(4)，**不得**判失败也不得判通过',
      { ...base, liveBootId: 'b9' }, 4],
    ['[NEG] 痕迹最后一条 ≠ 活 bootId（同源被破坏）→ 工具错误(3)',
      { ...base, bootLines: [BL('b1'), BL('b2')] }, 3],
    ['[NEG] 读不到活 bootId → 工具错误(3)', { ...base, liveBootId: null }, 3],
    ['[NEG] 无成功唤醒记录且该 boot 无待办 → 未验证(4)（不是失败，但绝不是通过）',
      { ...base, wakeLines: [WL({ id: 'post-restart-verify#g1', decision: 'would-wake', woken: false })], signals: [{ id: 'y', at: '2026-09-19T22:39:00.000Z', acknowledgedAt: '2026-09-19T22:40:30.000Z' }] }, 4],
    // ---- D 清单不得在重启**之前**被消费（2026-09-20 现场缺口：心跳提前消费了"重启后核对"清单）----
    // 注：D 的判据对象＝**最新登记的清单信号**（按 at 最大），不再按台账里的裸 id 匹配（id 代数会被复用）。
    ['[NEG] 未销账清单的成功唤醒全部发生在重启之前（提前消费）→ D 判失败',
      { ...base, signals: [{ id: 'post-restart-verify#g1', at: '2026-09-19T22:40:05.000Z', acknowledgedAt: null }], wakeLines: [WL({ idx: 5, id: 'post-restart-verify#g1' }), WL({ idx: 20, id: 'other-signal#g1' })] }, 1],
    ['[POS] 清单**已销账** → 生命周期闭环，即使历史唤醒全在重启之前也不判失败（防永久判红）',
      { ...base, wakeLines: [WL({ idx: 5, id: 'post-restart-verify#g1' }), WL({ idx: 20, id: 'other-signal#g1' })] }, 0],
    ['[POS] 清单在重启之后被消费（由 boot 或心跳皆可）→ D 放行', base, 0],
    ['[POS] 清单登记于最后一次启动**之后**（它等的那次重启尚未发生）→ D 本期不适用，不得判失败',
      { ...base, signals: [{ id: 'post-restart-verify#g9', chainId: 'post-restart-verify', stableKey: 'post-restart-verify', at: '2026-09-19T23:00:00.000Z', acknowledgedAt: null }] }, 0],
    ['[POS] 清单尚无成功唤醒（仍在队列）→ 不判失败也不读成通过',
      { ...base, wakeLines: [WL({ id: 'other-signal#g1' })] }, 0],
    ['[NEG] 台账为空 + 清单已跨 boot 消费 → 仅 C 未验证(4)（D 不因此假失败）',
      { ...base, debtLedger: [] }, 4],
    ['[POS] 无重启待办信号（signals 里没有清单）→ B 不要求唤醒；C/D **无对象 → 不适用（PASS 并注明）**',
      { ...base, signals: [{ id: 'y', chainId: 'other', at: '2026-09-19T22:39:00.000Z', acknowledgedAt: '2026-09-19T22:40:30.000Z' }] }, 0],
    ['[POS] 无重启请求 → C **无对象 → 不适用（PASS 并注明）**（牙齿仍在：有请求但台账无记录→4、debt 为空→1）',
      { ...base, restartRequests: [] }, 0],
  ];
  let bad = 0;
  for (const [name, inp, expect] of cases) {
    const r = judgeWakeOccurrence(inp);
    const ok = r.exit === expect;
    if (!ok) bad++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : `（期望 exit=${expect}，实际 ${r.exit}：${r.findings.map((f) => f.detail).join('；')}）`}`);
  }
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

// ---------------- CLI ----------------
const logText = (() => { try { return fs.readFileSync(LOG_PATH, 'utf8'); } catch { return null; } })();
if (logText === null) { console.log('=== ⑨ 唤醒通路实际发生审计 ==='); console.log('\n  RESULT: INSTRUMENT-ERROR（宿主日志不可读）'); process.exit(3); }
const lines = logText.split('\n');

const live = await (async () => {
  try { const r = await fetch(HEALTH_URL); const j = await r.json(); return j && j.bootId ? String(j.bootId) : null; } catch { return null; }
})();

const r = judgeWakeOccurrence({
  liveBootId: live,
  bootLines: parseBootLines(lines),
  wakeLines: parseWakeLines(lines),
  restartRequests: parseRestartRequests(lines),
  hostUps: parseHostUp(lines),
  signals: readSignals(),
  debtLedger: readDebtLedger(),
});

console.log('=== ⑨ 唤醒通路「实际发生」审计 ===');
console.log(`  活 bootId = ${live || '(读不到)'} ｜ 启动痕迹 ${parseBootLines(lines).length} 条 ｜ 唤醒痕迹 ${parseWakeLines(lines).length} 条 ｜ 重启请求 ${parseRestartRequests(lines).length} 条 ｜ 欠条台账 ${readDebtLedger().length} 条`);
for (const f of r.findings) console.log(`  [${f.verdict}] ${f.id} — ${f.detail}`);
const label = r.exit === 0 ? 'PASS（通路有效且有痕迹）' : r.exit === 1 ? 'FAIL（唤醒通路存在问题）' : r.exit === 3 ? 'INSTRUMENT-ERROR（工具错误，不是判定失败）' : 'UNVERIFIED（证据不足，不得读成通过）';
console.log(`\n  RESULT: ${label}`);
if (process.argv.includes('--json')) fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' ')), 'wake-occurrence.json'), JSON.stringify({ at: new Date().toISOString(), exit: r.exit, liveBootId: live, findings: r.findings }, null, 2), 'utf8');
process.exit(r.exit);
