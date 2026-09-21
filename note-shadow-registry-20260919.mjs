// 给 registry 的 v3-shadow-sandbox 条目加"当前运行状态"注记（YAML 注释，不改断言字段）。
// 后置断言遵循 L-084：条目数不得变化、体量不得塌缩。
import fs from 'node:fs';

const P = 'D:\\dsh-web-relay\\docs\\capabilities\\registry.yaml';
const before = fs.readFileSync(P, 'utf8');
const beforeIds = (before.match(/^- id: /gm) || []).length;

const NOTE = [
  '# 2026-09-19 运行状态核查（主 agent）：本机制**实现与接线完整**，但在本机长期**未生效**——',
  '#   ① resolveRepoPath(base) 以"工作区"为基准，而工作区（D:\\dsh relay test）不是 git 仓库 → 返回 null；',
  '#   ② 其回退读 DSH_RELAY_REPO_PATH，而宿主启动器设的是 DSH_RELAY_REPO（名字不一致）→ 回退永不生效；',
  '#   ⇒ shouldUseShadow 对每个 high 步骤都返回 degraded（计划里 9 处 "非 git 工作区：L2 降级"），',
  '#     L2 worktree 隔离 / 原子合并 / 定时 GC 均未运行，而该降级只写 step note、无升级路径。',
  '#   已修：启动器补 DSH_RELAY_REPO_PATH（2026-09-19）；可用性由 D:\\dsh relay test\\verify-shadow-availability.mjs',
  '#   机验（静态=启动器配置；运行=当前 boot 日志须出现「定时 Shadow GC 已启用」；并扫描修复点之后的新降级记录）。',
  '#   定位澄清：**串行链条派发与串行无人值守不需要影子沙盒**（cc 直接写真实工作树，且整套验证器以',
  '#   "唯一权威工作树"为前提）；它的价值场景是**多版本/多方案并行试错**（auto-iteration 的 N 版本循环）。',
  '',
].join('\n');

if (before.includes('2026-09-19 运行状态核查')) {
  console.log('注记已存在（幂等跳过）');
} else {
  const anchor = '- id: v3-shadow-sandbox';
  const at = before.indexOf(anchor);
  if (at < 0) { console.error('✗ 找不到 v3-shadow-sandbox 条目，拒绝盲改'); process.exit(1); }
  const after = before.slice(0, at) + NOTE + before.slice(at);
  fs.writeFileSync(P, after, 'utf8');
  console.log('已插入状态注记');
}

const s = fs.readFileSync(P, 'utf8');
const problems = [];
const afterIds = (s.match(/^- id: /gm) || []).length;
if (afterIds !== beforeIds) problems.push(`条目数变化：${beforeIds} → ${afterIds}`);
if (s.length < before.length) problems.push(`体量塌缩：${before.length} → ${s.length}`);
if (!s.includes('- id: v3-shadow-sandbox')) problems.push('丢了 v3-shadow-sandbox 条目');
if (!s.includes('text: "影子试错沙盒（Shadow Trial Sandbox）"')) problems.push('丢了原机验断言行');
if (problems.length) { console.error('✗ 后置断言失败：\n- ' + problems.join('\n- ')); process.exit(1); }
console.log(`✓ 后置断言通过（条目数 ${afterIds} 不变、体量 ${before.length} → ${s.length}）`);
