// 把 V1 验收证据包正文 + 包装器修复记录追加进权威轨迹
import fs from 'node:fs';

const WORK = String.raw`D:\dsh relay test`;
const trace = `${WORK}\\web-relay\\traces\\expr-2026-09-13_17-36-07.md`;
const bundle = fs.readFileSync(`${WORK}\\_v1-acceptance-bundle.txt`, 'utf8');
const now = new Date().toISOString();

const body = [
  '',
  `## [主 agent] ${now}`,
  '',
  '【V1 验收证据包（可复跑：node verify-v1-acceptance.mjs）】',
  '说明：本包对 V1-1 的落地做**真实计划级**验证（直接 import lib/breakthrough-gate.js，不依赖宿主是否已重启加载新代码），',
  '并静态取证接线与测试基线。V1-2 一旦落地，包内 C 段会自动由「未落地」变为「已落地」。',
  '',
  '```',
  bundle.trim(),
  '```',
  '',
  '【本轮附带修复：计划任务包装器退出码被 endlocal 清零】',
  '现象：run-chain.cmd 末行 endlocal 会把 ERRORLEVEL 复位为 0，导致计划任务 Last Result 恒为 0，',
  '掩盖链条真实退出码（3=额度暂停 / 1=验收打回 / 0=完成或跳过）——审计信号失效。',
  '修复：改为 `set RC=%ERRORLEVEL%` → 记日志 → `endlocal & exit /b %RC%`（纯 ASCII + CRLF，CR=8/LF=8/非 ASCII=0）。',
  '验证（走调度器真实路径 schtasks /Run）：Last Run 00:29:18、**Last Result=3**（与链条「额度不可用暂停」一致）。',
  '',
].join('\n');

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
