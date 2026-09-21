// 给宿主启动器补 DSH_RELAY_REPO_PATH（影子沙盒的仓库路径）——只加一行，带后置断言。
//
// 背景：启动器设了 DSH_RELAY_REPO（用于交付/漂移），但影子沙盒的 repoPath 回退与定时 GC 读的是
// DSH_RELAY_REPO_PATH（全仓 5 处，全属影子子系统，无副作用）。名字不一致 → 每个高风险步骤都判
// "非 git 工作区：L2 降级"，L2 隔离/原子合并/定时 GC 长期未生效（插件每次启动都在日志里喊，但没人升级）。
// 注：不设 DSH_RELAY_GC_MS —— 代码默认 600000ms（10min），用设计默认值，减少启动脚本改动面。
import fs from 'node:fs';

const P = 'C:\\Users\\Administrator\\dsh-web-watchdog.cmd';
const LINE = 'set DSH_RELAY_REPO_PATH=D:\\dsh-web-relay';
const ANCHOR = 'set DSH_RELAY_REPO=D:\\dsh-web-relay';

const before = fs.readFileSync(P, 'utf8');
const beforeLines = before.split('\n').length;
const beforeHas = before.includes('DSH_RELAY_REPO_PATH');

if (beforeHas) {
  console.log('已包含该行（幂等跳过）');
} else {
  if (!before.includes(ANCHOR)) { console.error(`✗ 找不到锚点：${ANCHOR}（拒绝盲改启动脚本）`); process.exit(1); }
  // 备份（启动脚本是宿主生命线，改前必须可回滚）
  const bak = `${P}.bak-preshadow-${Date.now()}`;
  fs.writeFileSync(bak, before, 'utf8');
  const after = before.replace(ANCHOR, `${ANCHOR}\r\n${LINE}`.replace(/\r\n/g, before.includes('\r\n') ? '\r\n' : '\n'));
  fs.writeFileSync(P, after, 'utf8');
  console.log(`已插入一行；备份 → ${bak}`);
}

const s = fs.readFileSync(P, 'utf8');
// 后置断言（L-084：批量/文本手术必须自证没有改坏）
const problems = [];
const nonAscii = [...s].filter((c) => c.codePointAt(0) > 127);
if (nonAscii.length) problems.push(`含非 ASCII 字符 ${nonAscii.length} 个（cmd.exe 按 ANSI 解析会破坏行结构）`);
if (s.charCodeAt(0) === 0xfeff) problems.push('含 UTF-8 BOM');
if (s.split('\n').length !== beforeLines + (beforeHas ? 0 : 1)) problems.push(`行数异常：${beforeLines} → ${s.split('\n').length}（期望 +${beforeHas ? 0 : 1}）`);
for (const must of ['DSH_RELAY_REPO_PATH', 'DSH_RELAY_REPO=', 'DSH_RELAY_WORKSPACE=', 'DSH_WEB_ARGS=', 'watchdog.mjs']) {
  if (!s.includes(must)) problems.push(`丢了关键内容：${must}`);
}
if (/^\s*DSH/i.test(s) === false) { /* 无关 */ }
if (problems.length) { console.error('✗ 后置断言失败：\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('✓ 后置断言通过（纯 ASCII、无 BOM、行数正确、关键内容齐全）');
console.log('--- 改动段落 ---');
console.log(s.split('\n').filter((l) => l.startsWith('set DSH_')).join('\n'));
