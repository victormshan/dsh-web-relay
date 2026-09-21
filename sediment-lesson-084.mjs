// 沉淀本次事故 lesson：批量文本手术必须带后置断言（split(sep, limit) 误用 → 静默清空文件）。
import fs from 'node:fs';

const FILE = 'D:\\dsh-web-relay\\docs\\main-agent-lessons.json';
const now = new Date().toISOString();
const id = 'L-2026-0919-084';

const entry = {
  id,
  title: '批量文本手术必须带后置断言——`split(sep, limit)` 误用会静默清空整个文件（实测 registry.yaml 495 行→0 行）',
  category: 'tooling-trap',
  layer: 'L1',
  trigger: '写脚本对权威文件（registry/lessons/runbook/配置）做批量替换、重命名或迁移时',
  decision: '① 替换脚本必须在**同一个脚本里**做前后置断言：条目数/关键计数不得减少、文件体积不得异常塌缩，不满足即 exit 1；② 写替换时确认调用的是 `split(a).join(b)` 而不是 `split(a, b)`（第二个参数是 limit，传字符串会被强制成 NaN → 返回空数组 → join 后文件只剩替换串）；③ 权威文件改动前先确认在 git 里且工作树干净，事故后可 `git checkout -- <file>` 原样还原；④ 沉淀库本身要有「条目数不收缩」的自维持不变量（已落进 verify-sediment.mjs）。',
  rationale: '这类错误的特点是**成功退出**：脚本没有抛错、没有报错行，文件却被清空——只有后置断言能把「改坏了」变成「失败退出」。而沉淀库/注册表这类文件的价值全在内容体量上，一次静默截断等于把历史积累清掉且无人察觉。',
  evidence: '2026-09-19 实测：把审计层数文案从「四层」改「分层」时，脚本里误写 `r.split(A, B).join(C)`（B 当作 limit）→ registry.yaml 被清空（464 行 → 0 行、22 条目 → 0），脚本正常退出；靠 `git diff --stat`（495 deletions）发现，`git checkout --` 还原；随后把替换脚本重写为带后置断言版本（条目数不变 + 体积下限），并给 verify-sediment.mjs 增加「条目数相对 HEAD 不得收缩」的自维持不变量（12/12 自检通过）。',
  confidence: 'high',
  status: 'proposed',
  suggested: 'proposed',
  confirmedBy: null,
  recordedAt: now,
  crossRef: ['L-2026-0914-061'],
};

const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
if ((j.lessons || []).some((x) => x.id === id)) { console.log('已存在，跳过'); process.exit(0); }
j.lessons = [...(j.lessons || []), entry];
fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n', 'utf8');
console.log(`已新增 ${id} → 共 ${j.lessons.length} 条`);
