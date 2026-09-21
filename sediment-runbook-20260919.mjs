// 手册增补：新增「无人值守与执行接地」一节 + §6 陷阱表两行 + §7 配套指针（幂等）。
import fs from 'node:fs';

const P = 'D:\\dsh-web-relay\\docs\\main-agent-runbook-v0.1.md';
let s = fs.readFileSync(P, 'utf8');
const MARK = '## 8. 无人值守与执行接地（2026-09-19 增补）';

const section = `${MARK}

判定与升级是两个独立问题：**「这份产物算不算通过」**（执行接地）与**「没人在看时出问题谁来处理」**（升级通路）。
本节的机制全部接地到可复跑产物，细则与可复跑入口见 \`docs/execution-grounded-gates.md\`。

### 8.1 收到「链条停下等人」信号时必须销账
唤醒消息里的信号来自 \`D:\\cc-tasks\\chain-needs-human.json\`（链条在护栏触发 / 验收器自身出错 / 跑完待收口时写下）。
- 处理顺序：**先复核产物**（仓库侧探针 → 独立验收 → 必要时跨平台对照）→ **再销账**；
- 销账用 \`acknowledgeHumanSignal(note)\`（\`D:\\dsh relay test\\chain-human-signal.mjs\`），note 写清复核结论；
- **不销账 = 链条/通道一直停在那里**；销账后若同源复发，会以新代数（新 id）**再次唤醒**。

### 8.2 判定纪律（本仓库实测过代价）
- **按产物判定，不按执行体自述**：cc 的 \`result.json\` 已多次自报 failed 而产物完整正确（v9/v10/v11/v12/v13 均有实例）；
  反之也成立——自报 done 不等于通过。
- **权威环境 = 交集**：同一用例**两个平台都失败**才算真回归；单平台失败标注为平台差异、不阻断。
- **工具错误必须与判定失败可区分**（exit 3 vs exit 1）；**负控空转要判工具错误**。
- **跨进程只传 JSON**（位置化文本拼接会因空字段错位制造假结论）。

### 8.3 交付接地的判据
\`/health-check\` 的 \`loadedLibHash\` 必须与**运行时副本**的 lib 指纹逐字一致（\`verify-delivery-live.mjs\` 独立重算）。
「仓库领先于交付」只算待交付提示；「宿主加载的 ≠ 已交付的」才是需要重启的真问题。

### 8.4 计划任务入口纪律
定时入口一律经隐藏启动器（\`D:\\cc-tasks\\_hidden-run-*.vbs\`）：窗口样式 0（隐藏）+ 等待完成 + **WScript.Quit 透传退出码**。
不得为了「不弹窗」而丢掉退出码——Last Result 是无人值守下唯一的失败可见性出口（门禁 \`verify-run-audit-cmd.mjs\` 会拦）。

`;

if (!s.includes(MARK)) {
  s = s.trimEnd() + '\n\n' + section + '\n';
  console.log('已追加 §8');
} else {
  console.log('§8 已存在（幂等跳过）');
}

// §6 陷阱表两行（插在表末，即 "## 7. 配套" 之前）
const rows = [
  '| 验收字段「从未被真实使用者触碰」 | `acceptanceScript` 在 schema/CLI/单测里齐全，但真实任务 0 使用者 → 首次真用即把值当 shell 命令执行（`/bin/sh: x.mjs: not found`），合格产物被判 failed | 新字段上线前必须有**至少一次真实使用者**跑通；探针必须落在双方共享命名空间 `<仓库>/probes/`，且**禁止硬编码单平台路径**（lesson 074/083） |',
  '| 定时任务弹 cmd 窗口 | 计划任务直接跑 `.cmd` → 每次触发弹一个空窗口（输出已重定向，故窗口是空的） | 经 `_hidden-run-*.vbs` 启动（样式 0 + 等待 + **退出码透传**）；为「不弹窗」丢掉退出码 = 隐藏失败（lesson 081） |',
  '| 无人值守下告警无人被叫 | 四层审计连续 9 次 ACTION-NEEDED 只写日志与 Last Result（4 小时无人处理） | 告警必须接到唤醒通路（信号文件 → 插件 boot/心跳 → 唤醒主 agent），同源用稳定键**只叫一次**，销账后复发再叫（lesson 078） |',
];
let missed = 0;
for (const r of rows) {
  const key = r.split('|')[1].trim();
  if (s.includes(key)) continue;
  const at = s.indexOf('\n## 7. 配套');
  if (at < 0) { missed++; continue; }
  s = s.slice(0, at) + '\n' + r + s.slice(at);
}
console.log(missed ? `有 ${missed} 行未插入（找不到 §7 锚点）` : '§6 陷阱表已补行（或已存在）');

// §7 配套指针
if (!s.includes('execution-grounded-gates.md')) {
  s = s.replace('- 能力沉淀：`docs/main-agent-lesson-schema-v0.1.md`。',
    '- 执行接地门禁与无人值守升级通路：`docs/execution-grounded-gates.md`（registry 条目 `execution-grounded-gates` / `pending-human-escalation`）。\n- 能力沉淀：`docs/main-agent-lesson-schema-v0.1.md`。');
  console.log('§7 已加指针');
}
fs.writeFileSync(P, s.trimEnd() + '\n', 'utf8');
console.log('行数：' + s.split('\n').length);
