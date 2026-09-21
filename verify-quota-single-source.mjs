// 门禁：配额判定的**调用点穷举**（原则 1 的机器化形式）。
//
// 起因（2026-09-19）：cc 文案从 "session limit" 变成 "weekly limit" 时，同一判断在本系统里有**五处**实现，
// 五处都只认旧词 → 链条每 20 分钟白跑 90s 探针（57 次）、runner 归因错、插件把配额记成 unknown。
// 我按"组件"枚举（链条/runner/插件）时只找到三处，第四处（cc-stats 统计归因）与第五处
// （deferred-dispatch.ps1）都是**按调用点 grep** 才浮现的 —— 而且我第一次 grep 还因为只筛 *.js 漏掉了 .mjs。
// ⇒ 结论：这类"全局判据"不能靠记忆里的组件清单，必须**机器穷举 + 白名单**。
//
// 本门禁做什么：扫描仓库与工具链里的**代码**文件（全部扩展名），找出所有"限额判定"文本，
//   · 允许：唯一收敛模块自身、以及任何**引用了收敛模块**的文件（说明它已桥接，不再自带判据）；
//   · 其余命中一律列出并判 FAIL —— 由人或主 agent 决定"收敛过去"还是"显式允许（附理由）"。
//
// 用法: node verify-quota-single-source.mjs [--selftest] [--list]
import fs from 'node:fs';
import path from 'node:path';

/** 判定模式：覆盖源码里的转义写法（session\s*limit）与 shell/PS 的字面写法（session limit）。
 *  刻意不含单独的 `quota` —— 变量名（quotaState/quotaResetsAt）会淹没结果，而"判定"总是 limit 类措辞。 */
export const DECISION_RE = /(session|rate|weekly|usage)[^\n]{0,12}limit|hit your[^\n]{0,12}limit/i;
/** "这是一次匹配动作"的特征：只有**同时**命中 DECISION_RE 与 MATCH_OP_RE 才算判定点。
 *  为什么必须加这一层：初版只按 DECISION_RE 扫，结果 23 处命中里大多数是
 *  **把文案当数据/散文**的地方（协议字符串、自检夹具、迁移脚本里被迁移的旧模式）——
 *  穷举机械化若不区分"判定"与"数据"，就会立刻退化成噪声，反而没人看。 */
export const MATCH_OP_RE = /(\.test\(|\.match\(|-match\b|=\s*~|grep\b|RegExp|\.exec\(|includes\()/i;
/** **策略点**识别：按 resetsAt 做比较/等待决策的行（如 `nowMs < resetsMs`）。
 *  这类行必须复用唯一模块的 cap（shortcutCapMs），否则就是"策略重复实现"——
 *  2026-09-19 实测：链条有 cap（周 24h/会话 6h）而插件没有 → 同一份数据两个保护级别，
 *  一个错误时间戳能让插件静默停摆一整个窗口。 */
export const POLICY_RE = /resetsAt|resetsMs/i;
export const POLICY_OP_RE = /\w\s*(<=|>=|<|>)\s*\w/;   // 必须像真实比较（a < b）；否则 `<占位符>` 这类文档写法会假阳性
export const POLICY_TARGET = /shortcutCapMs/;
/** 收敛模块的识别名（被引用即视为已桥接） */
export const CANONICAL_REF = /quota-classify|quota-parser/;

/** 显式允许名单（附日期与理由）。新命中不在其中 → FAIL。 */
export const ALLOW = [
  // 2026-09-19 清理：v15 已落地，cc-channel / cc-stats 不再是"待收敛"，条目已删除 ——
  // 于是它们若再出现未复用 cap 的**策略点**会被立刻抓出（这正是本次发现缺口的方式）。
  { file: 'cc-chain.mjs', until: '2099-01-01', why: '已收敛：只读仓库唯一模块 + 复用 shortcutCapMs（薄接线）' },
  { file: 'lib/quota-parser.mjs', until: '2099-01-01', why: '**唯一收敛模块自身**（仓库侧：判据 + cap 策略）' },
  { file: 'verify-quota-single-source.mjs', until: '2099-01-01', why: '本门禁自身含判定/策略模式' },
  { file: 'verify-quota-patterns.mjs', until: '2099-01-01', why: '跨实现一致性门禁（会提到各实现）' },
  // 一次性迁移/桥接/自检脚本：把旧/新模式当**数据**处理，不是长期判定点
  { file: 'fix-runner-quota-pattern.mjs', until: '2099-01-01', why: '一次性迁移脚本（模式作为数据）' },
  { file: 'bridge-deferred-dispatch-quota.mjs', until: '2099-01-01', why: '一次性桥接脚本（模式作为数据）' },
  { file: 'bridge-runner-quota.mjs', until: '2099-01-01', why: '一次性桥接脚本（模式作为数据）' },
  { file: 'converge-quota-module.mjs', until: '2099-01-01', why: '一次性收敛脚本（模式作为数据）' },
  { file: 'converge-phase2.mjs', until: '2099-01-01', why: '一次性收敛脚本（模式作为数据）' },
  { file: 'probe-quota-parse.mjs', until: '2099-01-01', why: '历史自检夹具' },
  { file: 'verify-quota-parse.mjs', until: '2099-01-01', why: '历史自检夹具' },
  { file: 'verify-quota-tz-offset.mjs', until: '2099-01-01', why: '历史自检夹具' },
  { file: 'append-progress-wake-note.mjs', until: '2099-01-01', why: '一次性轨迹写入脚本（文案作为数据）' },
  { file: 'append-trace-final-verdict.mjs', until: '2099-01-01', why: '一次性轨迹写入脚本（文案作为数据）' },
  { file: 'append-trace-unattended-dispatch.mjs', until: '2099-01-01', why: '一次性轨迹写入脚本（文案作为数据）' },
  // 以下是**策略相关但非派发跳过**的两处，显式允许并写明理由（不是"忘了收敛"）：
  { file: 'cc-doctor.mjs', until: '2099-01-01', why: '诊断展示（把已知恢复时刻报成 WARN）——不是派发跳过策略；若日后要按 cap 展示，应改为复用 shortcutCapMs' },
  { file: 'quota-state-write.mjs', until: '2099-01-01', why: 'forward-only 纪律（解析不出新时刻时保留既有未来值）——与"信任多久"的 cap 语义不同' },
  { file: 'quota-classify-cli.mjs', until: '2099-01-01', why: 'CLI 桥：仅映射字段，无策略' },
  { file: 'quota-classify-cli.mjs.bak-phase2', until: '2099-01-01', why: '备份文件' },
];

/** 纯函数：判定一组命中是否合规。hits: [{file, line, text}] */
export function judgeHits(hits, allow = ALLOW) {
  const allowed = new Set(allow.map((a) => a.file));
  const bad = hits.filter((h) => !allowed.has(h.file));
  return { ok: bad.length === 0, bad };
}

/** 扫描一个文件：返回命中行（排除引用收敛模块的文件由调用方按 CANONICAL_REF 处理） */
function scanFile(file, rel) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const bridged = CANONICAL_REF.test(text);
  const capAware = POLICY_TARGET.test(text);
  const hits = [];
  text.split('\n').forEach((line, i) => {
    // 只有"匹配动作 + 限额文案"同时出现才算**判定点**（纯散文/纯数据不算）
    if (DECISION_RE.test(line) && MATCH_OP_RE.test(line)) hits.push({ file: rel, line: i + 1, kind: 'judgement', text: line.trim().slice(0, 110), bridged, capAware });
    // **策略点**：按 resetsAt 做比较（等待/跳过决策）→ 必须复用唯一模块的 cap
    else if (POLICY_RE.test(line) && POLICY_OP_RE.test(line)) hits.push({ file: rel, line: i + 1, kind: 'policy', text: line.trim().slice(0, 110), bridged, capAware });
  });
  return hits;
}

function collect(dir, { exts, rel = '', maxDepth = 2, skip = [] } = {}) {
  const out = [];
  const walk = (d, depth, base) => {
    if (depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      const r = base ? `${base}/${e.name}` : e.name;
      if (skip.some((s) => r.includes(s))) continue;
      if (e.isDirectory()) walk(abs, depth + 1, r);
      else if (exts.some((x) => e.name.endsWith(x))) out.push({ abs, rel: rel ? `${rel}/${r}` : r });
    }
  };
  walk(dir, 0, '');
  return out;
}

const roots = [
  { dir: 'D:\\dsh-web-relay', exts: ['.js', '.mjs', '.cjs', '.ts'], skip: ['node_modules', 'test/', 'docs/', '.gitworktrees', 'probes/'] },
  { dir: 'D:\\cc-tasks', exts: ['.sh', '.ps1', '.cmd', '.mjs'], skip: ['tasks/', '.bak', '.new', '.pre-', 'chain-state', 'deferred/'], maxDepth: 1 },
  { dir: 'D:\\dsh relay test', exts: ['.mjs'], skip: ['cc-specs/', 'cc-chains/', 'probes/', '_analysis/', 'web-relay/', 'node_modules'], maxDepth: 1 },
];

if (process.argv.includes('--selftest')) {
  const cases = [];
  const t = (label, hits, expectOk) => {
    const r = judgeHits(hits);
    cases.push(r.ok === expectOk);
    console.log(`  [${r.ok === expectOk ? 'PASS' : 'FAIL'}] ${label} → ok=${r.ok}（期望 ${expectOk}）${r.ok ? '' : '｜' + r.bad.map((b) => b.file + ':' + b.line).join(',')}`);
  };
  /** 布尔断言的助手：别把 boolean 当 hits 数组传给 t（初版就是这么崩的：hits.filter is not a function） */
  const tp = (label, cond) => {
    cases.push(!!cond);
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label} → ${!!cond}`);
  };
  t('[POS] 白名单内的文件 → 放行', [{ file: 'lib/quota-parser.mjs', line: 36 }], true);
  t('[NEG] 白名单外的新命中 → 必须抓（这正是"第五处"的形态）', [{ file: 'lib/new-thing.mjs', line: 9 }], false);
  t('[POS] 空命中 → 放行', [], true);
  // 模式本身的区分力
  const re = (s) => DECISION_RE.test(s);
  tp('[POS] 命中源码转义写法 session\\s*limit', re("|| /session\\s*limit|rate\\s*limit|\\bquota\\b/i.test(x)") === true);
  tp('[POS] 命中 shell 字面写法 session limit', re("grep -qiE 'session limit|rate limit'") === true);
  tp('[NEG] 不把变量名 quotaState 当判定', re('const quotaState = await readCcQuotaState()') === false);
  tp('[NEG] 只有限额文案、没有匹配动作 → 不算判定点（否则"把文案当数据"的地方会被误报）',
    re('const msg = "You have hit your weekly limit"') === true && MATCH_OP_RE.test('const msg = "You have hit your weekly limit"') === false);
  tp('[POS] 判定点 = 文案 + 匹配动作同时出现', MATCH_OP_RE.test("grep -qiE 'weekly limit'") === true);
  // 策略点：按 resetsAt 比较必须复用唯一模块的 cap
  tp('[POS] 策略点：resetsAt 比较会被识别', POLICY_RE.test('return nowMs < resetsMs;') && POLICY_OP_RE.test('return nowMs < resetsMs;'));
  tp('[NEG] 只读 resetsAt 展示（无比较）→ 不算策略点', POLICY_OP_RE.test('console.log(`预计 ${quotaState.resetsAt} 恢复`)') === false);
  tp('[POS] 复用 shortcutCapMs 的文件视为 cap 合规', POLICY_TARGET.test("import { shortcutCapMs } from './quota-parser.mjs'") === true);
  const ok = cases.filter(Boolean).length;
  console.log(`\nRESULT: ${ok}/${cases.length} ${ok === cases.length ? 'PASS' : 'FAIL'}`);
  process.exit(ok === cases.length ? 0 : 1);
}

const all = [];
for (const r of roots) {
  for (const f of collect(r.dir, r)) {
    for (const h of scanFile(f.abs, f.rel)) all.push(h);
  }
}
const bridgedFiles = [...new Set(all.filter((h) => h.bridged).map((h) => h.file))];
// 判定点：引用了收敛模块即视为已收敛；
// **策略点**：必须**引用了 cap（shortcutCapMs）**才算合规 —— 只引用模块不够
// （实测正是这种情形：cc-channel 引用了 quota-parser，却仍自己写 `now < resetsAt` 而无 cap）。
const candidates = all.filter((h) => !(h.kind === 'policy' ? h.capAware : h.bridged));

if (process.argv.includes('--list')) {
  console.log(`命中 ${all.length} 处（涉及 ${new Set(all.map((h) => h.file)).size} 个文件）：`);
  for (const h of all) console.log(`  ${h.bridged ? '[已桥接]' : '[自带判据]'} ${h.file}:${h.line}  ${h.text}`);
  process.exit(0);
}

console.log('=== 配额判定点 + 策略点穷举 ===');
for (const f of bridgedFiles) console.log(`  [已桥接] ${f}`);
const v = judgeHits(candidates);
for (const b of v.bad) {
  const kind = b.kind === 'policy' ? '策略未复用 cap（shortcutCapMs）' : '自带判据（未收敛）';
  console.log(`  ✗ ${kind}：${b.file}:${b.line}  ${b.text}`);
}
const policyBad = v.bad.filter((b) => b.kind === 'policy').length;
console.log(`\n  命中合计 ${all.length}（判定点 ${all.filter((h) => h.kind === 'judgement').length} / 策略点 ${all.filter((h) => h.kind === 'policy').length}）｜ 已桥接文件 ${bridgedFiles.length} ｜ 未收敛命中 ${v.bad.length}（其中策略类 ${policyBad}）`);
console.log(`\nRESULT: ${v.ok ? 'PASS（所有判定点与策略点都已收敛或显式允许）' : `FAIL（${v.bad.length} 处未收敛：请收敛到唯一模块/复用 shortcutCapMs，或加入 ALLOW 并写明理由）`}`);
process.exit(v.ok ? 0 : 1);
