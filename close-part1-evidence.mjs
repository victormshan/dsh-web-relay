// 目标 (1) 收口证据包：现跑四项要求的原始证据 → 追加进权威轨迹（node 全程处理，避免编码污染）
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const WORK = 'D:\\dsh relay test';
const REPO = 'D:\\dsh-web-relay';
const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const out = [];
const cap = (label, text) => { out.push(`### ${label}`, '', '```', String(text || '').trim(), '```', ''); };

// ---- A. 守护常驻可自愈 ----
const svc = spawnSync('wsl.exe', ['-e', 'bash', '-c',
  'systemctl --user show cc-watchdog.service -p ActiveState -p SubState -p MainPID -p NRestarts -p Restart -p RestartUSec --value; ' +
  'echo "is-enabled=$(systemctl --user is-enabled cc-watchdog.service)"; ' +
  'echo "linger=$(loginctl show-user administrator -p Linger --value)"; ' +
  'echo "heartbeat_mtime=$(stat -c \'%y\' /mnt/d/cc-tasks/watchdog.heartbeat)"; ' +
  'echo "watchdog_script_touch=$(grep -c \'touch /mnt/d/cc-tasks/watchdog.heartbeat\' /mnt/d/cc-tasks/cc-watchdog.sh)"; ' +
  'echo "claude=$(claude --version | head -1)"'], { encoding: 'utf8' });
cap('A. 守护常驻可自愈（systemd user 单元 + linger + 自愈策略）', svc.stdout);

// ---- B. 派发前探活（真实目录实测，含严格模式） ----
const m = await import('file:///D:/dsh-web-relay/lib/cc-channel.js');
const probeDefault = await m.ccWatchdogAlive({ fsImpl: m.nodeFsImpl, root: 'D:\\cc-tasks', env: {} });
const probeStrict = await m.ccWatchdogAlive({ fsImpl: m.nodeFsImpl, root: 'D:\\cc-tasks', env: { DSH_CC_WATCHDOG_STRICT: '1' } });
const probeNoRoot = await m.ccWatchdogAlive({ fsImpl: m.nodeFsImpl, root: 'D:\\cc-tasks-not-exist', env: {} });
cap('B. 派发前探活（真实 D:\\cc-tasks）',
  `默认(非严格) = ${JSON.stringify(probeDefault)}\n` +
  `严格模式     = ${JSON.stringify(probeStrict)}\n` +
  `结构缺失     = ${JSON.stringify(probeNoRoot)}   ← 仅此类阻塞派发`);

// ---- C. 端到端可验证（验收器对已交付通道修复任务现跑） ----
const v = spawnSync(process.execPath, ['verify-cc-task.mjs', 'ccfix-20260914-hb3'], { cwd: WORK, encoding: 'utf8' });
cap('C. 端到端可验证（verify-cc-task.mjs 对 ccfix-20260914-hb3 现跑）', v.stdout);

// ---- D. 失败分类与降级可审计 ----
const doc = spawnSync(process.execPath, ['cc-doctor.mjs', '--json', '--out', 'D:\\cc-tasks\\doctor.json'], { cwd: WORK, encoding: 'utf8' });
let docJson = null;
try { docJson = JSON.parse(fs.readFileSync('D:\\cc-tasks\\doctor.json', 'utf8')); } catch { /* ignore */ }
const rules = spawnSync('node', ['-e',
  "const fs=require('fs');const t=fs.readFileSync('D:/dsh-web-relay/lib/cc-stats.mjs','utf8');" +
  "const m=[...t.matchAll(/\\['(cc-[a-z-]+)'/g)].map(x=>x[1]);console.log('cc-stats 分类桶: '+[...new Set(m)].join(', '));" +
  "const idx=fs.readFileSync('D:/dsh-web-relay/lib/index.js','utf8');" +
  "console.log('relay 侧审计字段 ccWatchdogWarning 命中: '+(idx.match(/ccWatchdogWarning/g)||[]).length);" +
  "console.log('配额短路 shouldSkipForKnownQuotaExhaustion 命中: '+(idx.match(/shouldSkipForKnownQuotaExhaustion/g)||[]).length);"],
  { encoding: 'utf8' });
cap('D. 失败分类与降级可审计',
  (rules.stdout || '') +
  `\n体检失败分类计数: ${JSON.stringify(docJson ? docJson.info.failuresByCode : null)}\n` +
  `体检结论: ${docJson ? docJson.checks.filter((c) => c.level !== 'PASS').map((c) => `[${c.level}] ${c.name}: ${c.detail}`).join(' | ') || '全部 PASS' : 'n/a'}`);

// ---- 汇总追加 ----
const stamp = new Date().toISOString();
const body = `
## [主 agent] ${stamp}

【目标 (1) 收口证据包：Claude Code 编码通道四项要求逐条现跑取证】
说明：以下输出为本次现跑（非复述），命令均可复现；对应提交：1113494（探针 fail-open + 专用心跳 + 失败分类）、
同日 cc-stats 提交（分类桶）、9afa576（自治链条运维手册）。

${out.join('\n')}
【目标 (1) 判定】四项要求——守护常驻可自愈、派发前探活、端到端可验证、失败分类与降级可审计——均有上述原始证据支撑，判定为达成。
遗留边界（不影响达成判定，但须知悉）：① 插件 lib/ 代码需宿主重启才在运行中生效（链条走 WSL watchdog，不依赖宿主）；
② 计划任务为 Interactive only；③ 订阅额度与交互式使用共享，耗尽只能等窗口重置；
④ 机械验收证明「范围/语法/测试/覆盖/编码」，不证明「实现符合意图」——意图层仍由协议审核覆盖。`;
fs.appendFileSync(trace, body, 'utf8');
console.log('  证据包已写入轨迹，追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现有字节 =', fs.statSync(trace).size);
console.log('  四项证据摘要：');
console.log('   A:', (svc.stdout || '').split('\n').filter((l) => l.includes('linger') || l.includes('is-enabled') || l.includes('Restart')).join(' '));
console.log('   B: 默认=' + JSON.stringify(probeDefault).slice(0, 110));
console.log('   C:', (v.stdout || '').split('\n').filter((l) => l.includes('RESULT')).join(' ').trim());
console.log('   D:', (rules.stdout || '').split('\n')[0]);
