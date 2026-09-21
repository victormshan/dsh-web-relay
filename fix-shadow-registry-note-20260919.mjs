// 更正 registry 里影子沙盒的状态注记：先前写的"已修：启动器补 DSH_RELAY_REPO_PATH"**不成立**（实测无效），
// 必须改成事实（env 只在 watchdog 重启时生效 → 真修法是代码回退，v14 落实中）。带后置断言。
import fs from 'node:fs';

const P = 'D:\\dsh-web-relay\\docs\\capabilities\\registry.yaml';
const before = fs.readFileSync(P, 'utf8');
const beforeIds = (before.match(/^- id: /gm) || []).length;

const FROM = '#   已修：启动器补 DSH_RELAY_REPO_PATH（2026-09-19）；可用性由 D:\\dsh relay test\\verify-shadow-availability.mjs';
const TO = [
  '#   修复进展：① 启动器已补 DSH_RELAY_REPO_PATH，但**实测重启宿主后仍不生效** —— request-restart 重启的是宿主，',
  '#   而宿主由常驻 watchdog 拉起，watchdog 继承的是它自己启动时的环境（实测 watchdog 起于 9/15，早于改动）；',
  '#   ② 因此真修法是让插件用 lib/ 上溯自行解析仓库根（v14：ccfix-20260919-shadowrepo），env 降级为可选加速项。',
  '#   可用性由 D:\\dsh relay test\\verify-shadow-availability.mjs',
].join('\n');

if (!before.includes(FROM)) { console.log('待更正的旧句未找到（可能已更正）'); }
else {
  const after = before.replace(FROM, TO);
  fs.writeFileSync(P, after, 'utf8');
  console.log('已更正状态注记');
}

const s = fs.readFileSync(P, 'utf8');
const problems = [];
const afterIds = (s.match(/^- id: /gm) || []).length;
if (afterIds !== beforeIds) problems.push(`条目数变化：${beforeIds} → ${afterIds}`);
if (s.length < before.length) problems.push(`体量塌缩：${before.length} → ${s.length}`);
if (!s.includes('- id: v3-shadow-sandbox')) problems.push('丢了 v3-shadow-sandbox 条目');
if (problems.length) { console.error('✗ 后置断言失败：\n- ' + problems.join('\n- ')); process.exit(1); }
console.log(`✓ 后置断言通过（条目数 ${afterIds} 不变、体量 ${before.length} → ${s.length}）`);
