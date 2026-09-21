// ⑦ 沉淀校验层：把「语境能力有没有漂移」变成**每周期自动检查**，而不是靠自觉。
//
// 为什么需要（本轮实测）：lessons 末条停在 L-2026-0915-072（09-15），而 09-16~09-19 四天的机制建设
// （执行接地门禁、验收语义、无人值守升级通路…）**一条都没沉淀** —— 没有任何检查会发现这件事。
// 沉淀库的价值全在"下次被唤醒时能拿到"，所以它必须和代码一样有回归门。
//
// 检查两个仓库自带校验器（它们各自有严格规范）：
//   · scripts/verify-capabilities.mjs —— registry 条目的 file-exists / content-contains 断言（机验 + 交叉引用）
//   · scripts/verify-lessons.mjs      —— lessons JSON 的 schema 与取值合法性
// 退出码语义与四层审计一致：0 通过 / 1 判定不通过 / 3 工具错误（不得把"校验器崩了"当成"沉淀漂移"）。
//
// 用法: node verify-sediment.mjs [--selftest]
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const REPO = 'D:\\dsh-web-relay';
const CHECKS = [
  { name: '能力登记 registry', file: 'scripts/verify-capabilities.mjs', okMarker: '能力验证完成' },
  { name: '语境能力 lessons', file: 'scripts/verify-lessons.mjs', okMarker: 'error 数：0' },
];

/**
 * 纯函数：沉淀条目数**不得收缩**（相对 HEAD）。返回 null=无法判定（无 git），否则 true/false。
 * 为什么需要：2026-09-19 实测事故——我写批量替换脚本时误用 `s.split(a, b)`（把替换串当成 limit）→
 * split 返回空数组 → join 后把 registry.yaml **整体清空（495 行 → 0）**，而脚本「成功退出」、没有任何告警。
 * 条目数下降是"沉淀被删除/被截断"最直接的可观测签名，且它是自维持的（不需要维护魔数基线）。
 */
export function judgeNoShrink({ cur, head }) {
  if (head === null || head === undefined || Number.isNaN(head)) return null;
  return !(cur < head);
}

/** 纯函数：把各校验器的结果判成 0/1/3（便于两侧自检，不经子进程） */
export function judgeSediment(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return { exit: 3, reason: '没有任何校验结果（空输入）' };
  const crashed = runs.filter((r) => r.code === null || r.code === undefined || (r.code !== 0 && r.code !== 1));
  if (crashed.length) return { exit: 3, reason: `校验器异常退出：${crashed.map((r) => `${r.name}=${r.code}`).join(', ')}（工具错误，不是沉淀漂移）` };
  const failed = runs.filter((r) => r.code === 1);
  if (failed.length) return { exit: 1, reason: `沉淀校验不通过：${failed.map((r) => r.name).join('、')}` };
  return { exit: 0, reason: '沉淀校验全部通过（registry 断言 + lessons schema）' };
}

/**
 * 纯函数：从校验器的输出 + 退出码判定 0/1/null(工具错误)。
 * 为什么不能只看退出码：校验器可能"有错却退出 0"，也可能"没跑成但退出 0"。
 *   · 退出码非 0/1 → 工具错误；退出 1 → 沉淀漂移；
 *   · 退出 0 且输出含 `error 数：N`（N>0）→ **漂移**（不能读成通过，也不能读成工具错误）；
 *   · 退出 0 却没有通过标记 → 工具错误（没跑成 ≠ 通过）。
 */
export function classifyVerifierOutput({ status, out, okMarker }) {
  const text = String(out || '');
  if (status !== 0 && status !== 1) return { code: status === null || status === undefined ? null : status, why: '异常退出码' };
  if (status === 1) return { code: 1, why: '校验器报不通过' };
  const m = text.match(/error 数：(\d+)/);
  if (m && Number(m[1]) > 0) return { code: 1, why: `校验器输出 error 数=${m[1]}（有错却退出 0）` };
  if (!text.includes(okMarker)) return { code: null, why: `退出 0 但未出现通过标记「${okMarker}」→ 视为没跑成` };
  return { code: 0, why: '通过' };
}

function selftest() {
  const cases = [];
  const t = (label, runs, expect) => {
    const r = judgeSediment(runs);
    cases.push(r.exit === expect);
    console.log(`  [${r.exit === expect ? 'PASS' : 'FAIL'}] ${label} → exit=${r.exit}（期望 ${expect}）`);
  };
  t('[POS] 两个校验器都通过 → 放行', [{ name: 'a', code: 0 }, { name: 'b', code: 0 }], 0);
  t('[NEG] 一个校验器判定不通过 → 抓（exit 1，沉淀漂移）', [{ name: 'a', code: 0 }, { name: 'b', code: 1 }], 1);
  t('[NEG] 校验器崩溃（非 0/1 退出）→ 必须与"沉淀漂移"区分（exit 3）', [{ name: 'a', code: 0 }, { name: 'b', code: 127 }], 3);
  t('[NEG] 空输入 → 工具错误', [], 3);
  // 输出分类（防"有错却退出 0"被读成通过、以及"没跑成"被读成通过）
  const cv = (label, args, expect) => {
    const r = classifyVerifierOutput(args);
    cases.push(r.code === expect);
    console.log(`  [${r.code === expect ? 'PASS' : 'FAIL'}] ${label} → code=${r.code}（期望 ${expect}）`);
  };
  cv('[POS] 退出 0 且出现通过标记 → 通过', { status: 0, out: 'error 数：0\nwarning 数：0\n能力验证完成', okMarker: '能力验证完成' }, 0);
  cv('[NEG] 退出 0 但输出 error 数=2 → 判**漂移**（不能读成通过）', { status: 0, out: 'error 数：2', okMarker: '能力验证完成' }, 1);
  cv('[NEG] 退出 0 但无通过标记 → 判工具错误（没跑成 ≠ 通过）', { status: 0, out: 'something unexpected', okMarker: '能力验证完成' }, null);
  cv('[NEG] 退出 1 → 判漂移', { status: 1, out: 'error 数：1', okMarker: 'x' }, 1);
  cv('[NEG] 退出 127 → 判工具错误', { status: 127, out: '', okMarker: 'x' }, 127);
  // 沉淀不得收缩
  t('[POS] 条目数未减少（cur=head）→ 放行', [{ name: 'noShrink', code: judgeNoShrink({ cur: 22, head: 22 }) ? 0 : 1 }], 0);
  t('[NEG] 条目数减少（22 → 0，即本次事故）→ 必须抓', [{ name: 'noShrink', code: judgeNoShrink({ cur: 0, head: 22 }) ? 0 : 1 }], 1);
  t('[POS] 新增条目（22 → 25）→ 放行', [{ name: 'noShrink', code: judgeNoShrink({ cur: 25, head: 22 }) ? 0 : 1 }], 0);
  const ok = cases.filter(Boolean).length;
  console.log(`\nRESULT: ${ok}/${cases.length} ${ok === cases.length ? 'PASS' : 'FAIL'}`);
  return ok === cases.length;
}

if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

const runs = [];
for (const c of CHECKS) {
  const r = spawnSync(process.execPath, [path.join(REPO, c.file)], { cwd: REPO, encoding: 'utf8', timeout: 300000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const cls = classifyVerifierOutput({ status: r.status, out, okMarker: c.okMarker });
  const tail = out.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  runs.push({ name: c.name, code: cls.code, why: cls.why, tail });
  console.log(`  ${cls.code === 0 ? 'PASS' : cls.code === 1 ? 'FAIL' : 'INSTRUMENT-ERROR'}  ${c.name}  ${tail}（${cls.why}）`);
}
const v = judgeSediment(runs);

// ③ 不收缩检查：条目数相对 HEAD 不得减少（自维持，无需魔数基线）
const counts = (() => {
  try {
    const regNow = fs.readFileSync(path.join(REPO, 'docs', 'capabilities', 'registry.yaml'), 'utf8');
    const lesNow = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'main-agent-lessons.json'), 'utf8'));
    const gitShow = (p) => {
      const r = spawnSync('git', ['-C', REPO, 'show', `HEAD:${p}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      return r.status === 0 ? r.stdout : null;
    };
    const regHead = gitShow('docs/capabilities/registry.yaml');
    const lesHead = gitShow('docs/main-agent-lessons.json');
    return {
      reg: (regNow.match(/^- id: /gm) || []).length,
      regHead: regHead === null ? null : (regHead.match(/^- id: /gm) || []).length,
      les: (lesNow.lessons || []).length,
      lesHead: lesHead === null ? null : (JSON.parse(lesHead).lessons || []).length,
    };
  } catch (e) { return { error: e.message }; }
})();
let shrinkBad = false;
if (counts.error) {
  console.log(`  ℹ 不收缩检查跳过（${counts.error}）`);
} else {
  const regOk = judgeNoShrink({ cur: counts.reg, head: counts.regHead });
  const lesOk = judgeNoShrink({ cur: counts.les, head: counts.lesHead });
  console.log(`  条目数：registry ${counts.reg}（HEAD ${counts.regHead}）｜lessons ${counts.les}（HEAD ${counts.lesHead}）`);
  if (regOk === false) { console.log('  ✗ registry 条目数**减少** → 沉淀被删除或被截断（本次事故形态）'); shrinkBad = true; }
  if (lesOk === false) { console.log('  ✗ lessons 条目数**减少** → 沉淀被删除或被截断'); shrinkBad = true; }
  if (regOk === true && lesOk === true) console.log('  ✓ 沉淀条目数未收缩（自维持不变量）');
}
if (!shrinkBad && v.exit === 0) console.log(`\nRESULT: PASS（${v.reason}；条目数未收缩）`);
else console.log(`\nRESULT: ${shrinkBad ? 'FAIL（沉淀条目数收缩）' : v.exit === 1 ? `FAIL（${v.reason}）` : 'INSTRUMENT-ERROR'}（${v.reason}）`);
process.exit(shrinkBad ? 1 : v.exit);
