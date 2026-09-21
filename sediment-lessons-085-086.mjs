// 沉淀今天新增的两条教训：L-085（交付须在重启前）/ L-086（启动器 env 只在 watchdog 重启时生效）。
import fs from 'node:fs';

const FILE = 'D:\\dsh-web-relay\\docs\\main-agent-lessons.json';
const now = new Date().toISOString();

const entries = [
  {
    id: 'L-2026-0919-085',
    title: '交付必须在重启**之前**完成——否则重启后自检必报漂移，把真告警淹成噪声',
    category: 'engineering-action',
    layer: 'L1',
    trigger: '准备重启宿主（request-restart）而仓库里有已提交但未交付的改动时（含 docs/registry/lessons 这类"也在包清单里"的文件）',
    decision: '① 重启前固定跑一次 deliver-three-copies.mjs --apply，并确认 verify-delivery-live.mjs 报"副本不一致/缺失 = 0"；② 若确实只想重启不交付，必须预期自检会报漂移并写明理由；③ 把"交付→重启"绑定成一个动作，别拆开做。',
    rationale: '重启后自检的首要职责是发现"运行端与源码不一致"。若这个信号常常是"你自己忘了交付"造成的，它就从告警退化成噪声，真正的漂移也会被当成又一次手误忽略——这正是本会话反复出现的"狼来了"结构。',
    evidence: '2026-09-19：我为激活影子沙盒环境变量而重启宿主，但只重启未交付 → 重启后自检立刻报 3 项交付漂移（registry.yaml / main-agent-lessons.json / main-agent-runbook-v0.1.md，均为当日沉淀提交的文档），notified=true 唤醒主 agent；交付 9 个文件（3×3 副本）后 ⑤ 恢复"精确"，漂移清零。',
    confidence: 'high', status: 'proposed', suggested: 'proposed', confirmedBy: null, recordedAt: now,
    crossRef: ['L-2026-0909-040'],
  },
  {
    id: 'L-2026-0919-086',
    title: '启动器里的环境变量**只在 watchdog 重启时生效**（宿主重启不够）→ 能力可用性别押在 env 上',
    category: 'tooling-trap',
    layer: 'L1',
    trigger: '为了让某机制可用而给宿主启动器（dsh-web-watchdog.cmd）加环境变量并重启宿主后；或某能力"配置改了却仍不生效"时',
    decision: '① 先确认 env 的**继承链**：宿主由常驻 watchdog 拉起、watchdog 由计划任务/启动器拉起，改启动器只影响**下一次 watchdog 启动**；`request-restart` 只重启宿主，不会重新执行启动器。② 因此不要把能力可用性建立在 env 上：应让代码从**自身位置**（import.meta.url 上溯）或既有配置推导默认值，env 只作可选覆盖；③ 验证"配置是否真的生效"要看**当前 boot** 的日志/自报字段，而不是"我改过配置文件了"。',
    rationale: '长驻进程（watchdog）是环境变量的"快照点"：改了它的上游配置却只重启下游，等于没改。这类失败尤其隐蔽——配置看起来正确、重启也做了、日志却仍在说不可用，容易得出"这机制坏了"的错误结论。',
    evidence: '2026-09-19：为影子沙盒加 DSH_RELAY_REPO_PATH 到启动器并 request-restart，重启后日志仍是「定时 Shadow GC 未启用」；核查发现 watchdog（PID 16356）起于 2026-09-15 20:51，父进程是当时的 cmd /c dsh-web-watchdog.cmd —— 它继承的是旧环境，宿主只是它的子进程。改判：正确修法是让插件用 lib/ 上溯得到仓库根（本轮已派发 v14 落实），env 降级为可选加速项；可用性检查也改为"实现无关"判据（不要求启动器设 env）。',
    confidence: 'high', status: 'proposed', suggested: 'proposed', confirmedBy: null, recordedAt: now,
    crossRef: ['L-2026-0910-043', 'L-2026-0909-040'],
  },
];

const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const have = new Set((j.lessons || []).map((x) => x.id));
const added = entries.filter((e) => !have.has(e.id));
j.lessons = [...(j.lessons || []), ...added];
fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n', 'utf8');
console.log(`已新增 ${added.length} 条 → 共 ${j.lessons.length} 条：${added.map((e) => e.id).join(', ')}`);
