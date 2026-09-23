// 重启前**注册"重启后核对清单"**，让 boot 扫描把主 agent 叫醒 —— 不再依赖"我下次记得回来核对"。
//
// 背景（2026-09-20 用户提问"重启后没有续跑？"后查明）：
//   我为激活 v18 重启宿主，重启前把待办信号**销账**了（那是对的：复核已完成），但**没有登记新的待办**，
//   于是 boot 扫描看不到任何未处理信号 → 正确地什么都没做 → 会话停在那里，直到用户发消息。
//   根因：**"重启后要核对 X"只是对话里的意图，盘上没有对象**——现有两条续跑机制（expr 步 / needs-human 信号）
//   都只认**盘上的对象**。故把它固化成工具：重启一律经本脚本，先登记清单，再发重启请求。
//
// 用法: node restart-with-checklist.mjs [--delay 120] [--reason "…"] [--items "a;b;c"]
//   默认清单 = 通用重启后核对项（⑤ 精确 / 影子可用 / ⑧ 穷尽层 / 审计总判定 / 待交付清 0）。
import fs from 'node:fs';
import { assertWriteRight } from './agent-write-lock.mjs'

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildHumanSignal, writeHumanSignalIfNew, readHumanSignal, SIGNAL_PATH } from './chain-human-signal.mjs';
import { guardGate } from './optimistic-guard.mjs';

const WORK = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '));
assertWriteRight({ what: '登记重启清单并请求重启' })
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const delay = Number(argOf('--delay', '120'));
// ccfeat-20260920-guardgate: `--guard <name>` → 登记清单/请求重启**之前**做乐观检测（工作树是否已变动）。
// 为什么在重启前尤其重要：重启会批量化此前的交付，若期间别人改了仓库/工作区，等于把未知状态一起激活。
{ const guardName = argOf('--guard', null); if (guardName) { const g = guardGate(guardName); console.log(g.message); if (!g.ok) process.exit(g.exit); } }
const reason = argOf('--reason', 'restart via restart-with-checklist.mjs');
const customItems = argOf('--items', '⑤ 交付接地应为「精确（三方指纹一致）」;verify-shadow-availability 应 PASS（定时 Shadow GC 已启用）;分层审计 ⑧ 层（配额判据/策略穷举）应 PASS;分层审计总判定应为 OK;副本不一致/缺失应为 0').split(';').map((s) => s.trim()).filter(Boolean);
// v4.12.2（2026-09-23 用户提问"不是已经有一项重启后自动报出手机连接的功能了吗"）：
// 此前 --items 是**整体覆盖**，于是最近每次重启的自定义清单都把手机链接那项挤掉了 —— 能力在、载体没挂上。
// token 随每次重启轮换，所以清单里**只能写"现读并报告"**，不能写死链接值（写死=把失效凭证给人，§8.8/§8.2）。
// 故把手机链接设为**强制项**：无论是否传 --items，都追加在末尾，不可被覆盖。
const MANDATORY_ITEMS = [
  '手机链接：现读并报告当前有效链接（node current-link.mjs，须自报"有效"）——token 随重启轮换，禁止贴旧值',
  '手机链路端到端实测：node verify-mobile-link.mjs（无 token 401 / 正确 token 303+cookie / 静态资源字节一致，应 8/8 PASS）',
];
const items = [...customItems, ...MANDATORY_ITEMS];

const detail = [
  '【重启后核对清单】（由 restart-with-checklist.mjs 在重启前登记）',
  ...items.map((s, i) => `${i + 1}. ${s}`),
  '',
  `重启原因：${reason}`,
  '核对完成后请销账（acknowledgeHumanSignal）；若某项不通过，先定位再销账。',
].join('\n');

// ⚠ 前置检查（2026-09-21 事故的机制性修复）：主槽若被**别的来源的未销账**信号占着，本清单只会**入队**，
//   而 boot 扫描与心跳**都只读主槽** → 没人消费它 → **重启后不会有任何唤醒**（静默死锁）。
//   这不是理论：本轮实测就是这样 —— 主槽被探针的 dryRun 夹具占住，重启成功执行、唤醒却从未发生。
//   故：拒绝登记并报错（exit 1），让人先处理占位者；确需入队须显式 --queue-ok。
{
  const cur = readHumanSignal(SIGNAL_PATH);
  const occupied = cur.ok && cur.entry && !cur.entry.acknowledgedAt;
  const sameSource = occupied && String(cur.entry.stableKey || '') === 'post-restart-verify';
  if (occupied && !sameSource && !argv.includes('--queue-ok')) {
    const isDry = cur.entry.dryRun === true;
    console.error(`[checklist] **拒绝登记**：主槽被 ${cur.entry.id}（未销账${isDry ? '，且是 dryRun 夹具——按设计永不唤醒、会永久堵死通道' : ''}）占用。`);
    console.error('  后果：清单只会入队，而 boot/心跳都只读主槽 → 重启后不会有任何唤醒（静默死锁）。');
    console.error('  处置：先销账占位者（node chain-human-signal 的 acknowledgeHumanSignal，或清掉探针夹具），再重跑本命令；');
    console.error('        若明确接受"入队等待"，加 --queue-ok。');
    process.exit(1);
  }
}

const sig = buildHumanSignal({
  chainId: 'post-restart-verify',
  reason: 'review-needed',
  stableKey: 'post-restart-verify',
  detail,
});
const w = writeHumanSignalIfNew(sig, SIGNAL_PATH);
console.log(`[checklist] ${w.written ? '已登记' : '已存在未销账同源信号（不重复写）'}：id=${w.signal.id}`);
console.log(`[checklist] 清单 ${items.length} 项：`);
for (const s of items) console.log(`  - ${s}`);

// 欠条台账（追问取证用）：判断"重启那一刻有没有待办对象"必须用**当时留下的**证据。
// 信号主槽是单槽文件、会被后来源覆盖，事后无法反推——那正是 ④ 层"对象不存在≠违约"的同型缺陷。
// 格式：一行一条 JSON {at, debt, reason}；debt = 本次登记的待办对象 id（无则 null）。
// 消费方：verify-wake-occurrence.mjs 的 C-欠条纪律（按 15 分钟邻近窗口匹配重启请求）。
const DEBT_LEDGER = path.join('D:\\cc-tasks', 'restart-debts.ndjson');
try {
  fs.appendFileSync(DEBT_LEDGER, JSON.stringify({ at: new Date().toISOString(), debt: w.signal && w.signal.id ? w.signal.id : null, reason }) + '\n', 'utf8');
  console.log(`[checklist] 欠条台账已记录：debt=${(w.signal && w.signal.id) || 'none'}`);
} catch (err) {
  console.log(`[checklist] ⚠ 欠条台账写入失败（不阻断重启）：${String((err && err.message) || err)}`);
}

// 发重启请求（沿用既定纪律：只写信号文件后立即返回，由常驻 watchdog 执行）
const r = spawnSync(process.execPath, [path.join('D:\\dsh-web-relay', 'bin', 'watchdog.mjs'), 'request-restart', String(delay), reason], { cwd: WORK, encoding: 'utf8' });
const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
console.log('[checklist] 重启请求：' + (out.split('\n').filter((l) => /REQUESTED|已写重启信号/.test(l))[0] || out.slice(0, 200)));
