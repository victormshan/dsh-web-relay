// 沉淀 L-087：门禁断言不得编码"世界的瞬时状态"（今晚连撞三次同类假失败）。
import fs from 'node:fs';

const FILE = 'D:\\dsh-web-relay\\docs\\main-agent-lessons.json';
const now = new Date().toISOString();
const id = 'L-2026-0919-087';

const entry = {
  id,
  title: '门禁断言不得编码「世界的瞬时状态」——否则正确行为/正确重构会触发假失败（一晚连撞三次）',
  category: 'tooling-trap',
  layer: 'L1',
  trigger: '写或修改门禁的静态期望时；尤其是①被检代码刚被重构 ②外部世界状态刚变化（真实告警出现、服务重启、另一个程序改了文件）之后',
  decision:
    '① 断言要落在**结构性/相对性**事实上：文件里"依赖了谁"（import/桥接）、"改前改后是否相同"（内容/哈希比对）、"行为是否符合契约"（跑一次真调用），'
    + '而不是"文件里是否含某个字面量"或"外部世界里是否恰好没有某条记录"；'
    + '② 涉及外部世界的检查一律**先快照、后比对**（内容/字节），不要写"它不该存在"这类全称断言；'
    + '③ 重构完成后必须**回看门禁**：期望会随架构收敛而过时（收敛完成反而报假失败）；'
    + '④ 出现假失败时先问"是我的期望过时，还是代码真的错了"，两者都要用证据分辨，不要靠印象改断言。',
  rationale:
    '门禁的价值在于"通过的必真、失败的必假"。把瞬时状态编码进断言，会让门禁在正确的世界变化下报错——'
    + '此时人只有两个选择：改断言（可能掩盖真问题）或忽视它（门禁失效）。二者都在削弱门禁可信度，'
    + '而正确做法是让断言只依赖**不随无关变化而变的性质**。',
  evidence:
    '2026-09-19 一晚三次：①`verify-quota-patterns.mjs` 的插件断言写"本文件含 weekly 字样"→ 收敛到唯一模块后措辞搬走，'
    + '正确的重构被判失败；②同一门禁对 runner 断言写"抽取它的 grep 模式"→ runner 改为桥接后同样假失败；'
    + '③`precheck-audit-signal.mjs` 断言"真实告警文件里不该有未销账的 four-layer-audit 条目"→ 审计真的发出告警后，'
    + '这条**正确行为**反而让门禁挂掉（并被分层审计 ③ 层放大成 ACTION-NEEDED → 触发一次多余的唤醒信号）。'
    + '三处均改为结构/相对判据（依赖唯一模块、桥接+行为、内容快照比对）后全绿（③ 18 项、跨实现 11/11、审计 OK）。',
  confidence: 'high',
  status: 'proposed',
  suggested: 'proposed',
  confirmedBy: null,
  recordedAt: now,
  crossRef: ['L-2026-0919-075', 'L-2026-0919-086'],
};

const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
if ((j.lessons || []).some((x) => x.id === id)) { console.log('已存在，跳过'); process.exit(0); }
j.lessons = [...(j.lessons || []), entry];
fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n', 'utf8');
console.log(`已新增 ${id} → 共 ${j.lessons.length} 条`);
