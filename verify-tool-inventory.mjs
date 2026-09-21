// 活工具清单（Tier A）的**生成 + 校验**门禁：把"哪些工作区工具是活的"从一次性清点变成可持续的盘上对象。
//
// 为什么需要（2026-09-21 实测教训）：工作区有 254 个 .mjs，此前**没人知道哪些是活的** ——
// 我为 `verify-postrestart-wake-path.mjs` 的过时期望踩过、也为自己探针的残留踩过；
// 而 runbook/门禁实际只调用其中 40 余个。清单若只存在于某次清点脚本里，等于不存在。
//
// 判据（穷举而非枚举）：从**权威引用点**抽取被调用的 .mjs/.sh，与清单逐条比对——
//   · 被引用但**不在清单**里 → **1 失败**（新工具加了但没登记：清单开始漂移）
//   · 在清单里但**文件不存在** → **1 失败**（清单指向幻影）
//   · 在清单里但**当前没有被引用** → 信息项（可能是 runbook-only 或刻意保留；不判失败）
//   引用点（权威）：verify-gates 的 GATES 清单 / regression-post-restart 回归项 / audit-all 的 REQUIRED_LAYERS /
//   claims.json 的 cmd 型事实 / runbook §8 的工具名。
//
// 用法: node verify-tool-inventory.mjs            # 校验（门禁用）
//       node verify-tool-inventory.mjs --selftest # 两侧自检
//       node verify-tool-inventory.mjs --update   # 重新生成清单（=登记新工具；随后应提交并推送本仓库）
import fs from 'node:fs';
import path from 'node:path';

export const W = 'D:\\dsh relay test';
export const R = 'D:\\dsh-web-relay';
export const MANIFEST = path.join(W, 'tool-inventory.json');

/** 从权威引用点穷举被调用的工具（纯读，零副作用）。返回 Map<relpath, Set<source>>。 */
export function extractLiveTools({ work = W, repo = R } = {}) {
  const live = new Map();
  const add = (f, src) => { const k = String(f).trim(); if (!k) return; if (!live.has(k)) live.set(k, new Set()); live.get(k).add(src); };
  const scan = (file, src, re = /['"`]([A-Za-z0-9_\-./]+\.(?:mjs|sh))['"`]/g) => {
    let txt = '';
    try { txt = fs.readFileSync(file, 'utf8'); } catch { return; }
    for (const m of txt.matchAll(re)) add(m[1], src);
  };
  scan(path.join(work, 'verify-gates.mjs'), 'verify-gates:GATES');
  scan(path.join(work, 'regression-post-restart.mjs'), 'regression');
  scan(path.join(work, 'audit-all.mjs'), 'audit-all:REQUIRED_LAYERS');
  try {
    const c = JSON.parse(fs.readFileSync(path.join(work, 'claims.json'), 'utf8'));
    for (const cl of c.claims || []) {
      if (cl.type === 'cmd' && cl.cmd) for (const m of String(cl.cmd).matchAll(/([A-Za-z0-9_\-./]+\.(?:mjs|sh))/g)) add(m[1], 'claims.json');
    }
  } catch { /* 无 claims.json */ }
  scan(path.join(repo, 'docs', 'main-agent-runbook-v0.1.md'), 'runbook', /([A-Za-z0-9_\-]+\.(?:mjs|sh))/g);
  // 归一化规则：去掉 ./ 前缀；**只在工作区里存在的**才算工作区工具（仓库侧路径如 scripts/verify-capabilities.mjs 自然落空）
  const out = new Map();
  for (const [f, srcs] of live) {
    const rel = f.replace(/^\.\//, '');
    const abs = path.join(work, rel.split('/').join(path.sep));
    if (fs.existsSync(abs)) out.set(rel, srcs);
  }
  return out;
}

/** 纯函数：清单与穷举结果比对。 */
export function judgeInventory(manifest, extracted, existsFn) {
  const failures = [];
  const infos = [];
  const listed = Array.isArray(manifest && manifest.tools) ? manifest.tools : [];
  const listedNames = new Set(listed.map((t) => t.file));
  for (const [file, srcs] of extracted) {
    if (!listedNames.has(file)) failures.push(`被 ${[...srcs].join(',')} 引用但**未登记**：${file}（跑 --update 登记后提交）`);
  }
  for (const t of listed) {
    if (!existsFn(t.file)) failures.push(`清单登记了但**文件不存在**：${t.file}`);
    else if (!extracted.has(t.file)) infos.push(`${t.file}：当前未被权威引用点调用（可能是 runbook-only 或刻意保留）`);
  }
  return { ok: failures.length === 0, failures, infos, listedCount: listed.length, extractedCount: extracted.size };
}

if (process.argv.includes('--selftest')) {
  const cases = [];
  const ck = (label, cond, detail = '') => { cases.push({ label, cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); };
  const ex = new Map([['a.mjs', new Set(['regression'])], ['probes/p.mjs', new Set(['verify-gates:GATES'])]]);
  const exists = () => true;
  // [POS] 清单与穷举一致 → 放行
  const okMan = { tools: [{ file: 'a.mjs', why: 'x' }, { file: 'probes/p.mjs', why: 'y' }] };
  ck('[POS] 清单与穷举一致 → 放行', judgeInventory(okMan, ex, exists).ok === true);
  // [NEG] 新工具被引用但未登记 → 抓
  const missMan = { tools: [{ file: 'a.mjs' }] };
  const r1 = judgeInventory(missMan, ex, exists);
  ck('[NEG] 被引用但未登记 → 抓（清单漂移）', r1.ok === false && r1.failures.some((f) => /未登记/.test(f)), r1.failures[0] || '');
  // [NEG] 清单指向不存在的文件 → 抓（注意：此处的 existsFn 必须**真的**对幻影返回 false，
  //      否则该条会落进"不再被引用"的信息项而假通过 —— 初版夹具用了恒真 exists，正是这么挂的。）
  const ghostMan = { tools: [{ file: 'a.mjs' }, { file: 'probes/p.mjs' }, { file: 'ghost.mjs' }] };
  const existsNoGhost = (f) => f !== 'ghost.mjs';
  const r2 = judgeInventory(ghostMan, ex, existsNoGhost);
  ck('[NEG] 清单指向幻影文件 → 抓', r2.ok === false && r2.failures.some((f) => /文件不存在/.test(f)), r2.failures[0] || '');
  // [POS] 清单多出一条"不再被引用"的 → 只报信息，不判失败
  const staleMan = { tools: [{ file: 'a.mjs' }, { file: 'probes/p.mjs' }, { file: 'old.mjs' }] };
  const r3 = judgeInventory(staleMan, ex, exists);
  ck('[POS] 清单多出"不再被引用"的 → 仅信息项，不判失败（避免误杀刻意保留）', r3.ok === true && r3.infos.length === 1, r3.infos[0] || '');
  // [NEG] 空清单 + 有穷举结果 → 抓（防"清单被清空也算通过"）
  ck('[NEG] 空清单 → 抓（防清空即通过）', judgeInventory({ tools: [] }, ex, exists).ok === false);
  const bad = cases.filter((c) => !c.cond).length;
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

const extracted = extractLiveTools();
if (process.argv.includes('--update')) {
  const tools = [...extracted.entries()].map(([file, srcs]) => ({
    file,
    refs: [...srcs].sort(),
    bytes: (() => { try { return fs.statSync(path.join(W, file.split('/').join(path.sep))).size; } catch { return null; } })(),
  })).sort((a, b) => a.file.localeCompare(b.file));
  const out = { generatedAt: new Date().toISOString(), how: '由 verify-tool-inventory.mjs --update 从权威引用点穷举生成；勿手改（改引用点后重跑）', count: tools.length, tools };
  fs.writeFileSync(MANIFEST, JSON.stringify(out, null, 2) + '\n', 'utf8');
  const back = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (back.count !== tools.length) { console.error('ABORT: 回读不一致'); process.exit(3); }
  console.log(`[inventory] 已生成清单：${MANIFEST}（${back.count} 个工具）`);
  process.exit(0);
}

let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { /* 缺清单 */ }
if (!manifest) { console.log(`[inventory] 无清单（${MANIFEST}）→ 未验证（不得当成通过）。先跑 --update。`); process.exit(4); }
const r = judgeInventory(manifest, extracted, (f) => fs.existsSync(path.join(W, f.split('/').join(path.sep))));
console.log(`=== 活工具清单校验（清单 ${r.listedCount} ｜ 穷举 ${r.extractedCount}）===`);
for (const f of r.failures) console.log(`  ✗ ${f}`);
if (r.infos.length) console.log(`  ℹ 信息项 ${r.infos.length} 条：${r.infos.slice(0, 3).join('；')}${r.infos.length > 3 ? ' …' : ''}`);
console.log(`\n  RESULT: ${r.ok ? 'PASS（清单与权威引用点一致）' : `FAIL（${r.failures.length} 项）`}`);
process.exit(r.ok ? 0 : 1);
