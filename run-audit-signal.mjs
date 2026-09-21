// 周期审计的"信号化"包装器：让**审计失败也能叫醒主 agent**（此前它只写 audit.log，没人会被叫）。
//
// 背景（2026-09-18 实测，4 小时无人值守的数据）：分层审计每 30 分钟照跑，从 13:26Z 起**连续 9 次**
// `ACTION-NEEDED：⑤ 交付接地`（≡"宿主没加载仓库代码，需交付+重启"），但只写进了 audit.log 与计划任务 Last Result —
// **没有任何升级路径**。而同一时期链条侧的 pending-human 通道已经能把主 agent 叫醒（当日已实证）。
// 于是把审计也接到同一个消费端：写 chain-needs-human.json → 插件 boot/心跳读到 → 唤醒主 agent。
//
// 告警频率语义（用户 2026-09-18 选定方案 A）：**同源失败只叫一次**。
//   · 用**稳定键**（stableKey = 'four-layer-audit'）→ 同源重复失败复用同一 id → 插件按 id 去重 → 不重复打断；
//   · 人销账后若**复发** → 代数 +1 → 新 id → 会再次叫醒（复发必须能叫）；
//   · 审计**自愈**（重新通过）→ 自动销账同源信号（附说明），避免一条早已恢复的告警一直挂着。
//
// 退出码必须**原样透传**（0 通过 / 1 ACTION-NEEDED / 3 工具错误）：计划任务 Last Result 的可观测性靠它，
// 且 verify-run-audit-cmd.mjs 对这条有硬门禁。写信号失败**不得**影响退出码。
//
// 用法: node run-audit-signal.mjs [--quiet]     （计划任务经 run-audit.cmd 调用）
//       DSH_AUDIT_SIGNAL_PATH=<tmp> 可改信号文件路径（供自检/负控，不去动真实告警文件）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildHumanSignal, writeHumanSignalIfNew, resolveHumanSignal, SIGNAL_PATH } from './chain-human-signal.mjs';

const WORK = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '));
const SIGNAL_FILE = process.env.DSH_AUDIT_SIGNAL_PATH || SIGNAL_PATH;
const STABLE_KEY = 'four-layer-audit';

const quiet = process.argv.includes('--quiet');
// 审计命令可注入（默认就是真正的分层审计）：
//  · 生产：不设该变量 → 跑 audit-all.mjs；
//  · 自检/负控：指向一个假审计脚本 → 快速验证"判定非 0 → 写信号 / 判定 0 → 自动销账"的接线，
//    同时**避免递归**（若这条检查被放进 audit-all 的第 ⑥ 层，它绝不能再启动一次完整审计）。
const AUDIT_CMD = process.env.DSH_AUDIT_CMD || 'audit-all.mjs';
// 支持绝对路径（自检注入用）与相对工作区的文件名（默认）
const AUDIT_PATH = path.isAbsolute(AUDIT_CMD) ? AUDIT_CMD : path.join(WORK, AUDIT_CMD);
// 透传额外参数给审计（例如 --negctl-fail，用于功能性负控）；--quiet 只影响本包装器。
const passthrough = process.argv.slice(2).filter((a) => a !== '--quiet');
const r = spawnSync(process.execPath, [AUDIT_PATH, ...passthrough, ...(quiet ? ['--quiet'] : [])], { cwd: WORK, encoding: 'utf8', timeout: 600000 });
const out = `${r.stdout || ''}${r.stderr || ''}`;
const code = r.status === null ? 3 : r.status;
const tail = out.trim().split('\n').filter(Boolean).slice(-3).join(' ｜ ');

let signalNote = '无需人介入（审计通过）';
try {
  if (code === 0) {
    const res = resolveHumanSignal(STABLE_KEY, `auto-resolved: 分层审计已恢复通过（${new Date().toISOString()}）`, SIGNAL_FILE);
    signalNote = res.resolved ? '审计通过 → 已自动销账此前的同源告警' : '审计通过（无同源告警需处理）';
  } else {
    const reason = code === 1 ? 'audit-action-needed' : 'instrument-error';
    const sig = buildHumanSignal({
      chainId: STABLE_KEY, reason, stableKey: STABLE_KEY,
      detail: `分层审计判定 exit=${code}：${tail.slice(0, 400)}`,
      lastVerdict: code === 1 ? 'ACTION-NEEDED' : 'INSTRUMENT-ERROR',
    });
    const w = writeHumanSignalIfNew(sig, SIGNAL_FILE);
    signalNote = `${w.written ? '已登记/重登记' : '已存在同源未销账信号'}：${w.reason}（id=${w.signal.id}）`;
  }
} catch (e) {
  signalNote = `写信号失败（不影响退出码）：${e.message}`;
}

if (!quiet) console.log(`[audit-signal] exit=${code} ｜ ${signalNote}\n${tail}`);
process.exit(code);
