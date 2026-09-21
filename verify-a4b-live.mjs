// 重启后核对：A4b 的 ccChainStats 是否真的在**运行时**生效（不只仓库里有）
// 用法: node verify-a4b-live.mjs --prev-boot mu32to7l-5aeb301f
//
// 这是「交付 → 重启 → 生效」闭环的最后一环。判据：
//   ① bootId 必须变化（证明重启真的发生，而非读到旧进程的缓存）
//   ② /health-check 必须出现 ccChainStats 且是带数字的对象（证明新代码已加载并跑通聚合）
//   ③ 既有 ccStats 必须仍在且形状未变（证明没有回归）
//   ④ selfCheck 契约必须 ok 且 differing 为空——本轮把 ccChainStats 写进了自检契约清单，
//      所以「装了一半」（改了 selfcheck.mjs 却没改 index.js）会在这里被抓出来。
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PREV_BOOT = argOf('--prev-boot', '');
const BASE = 'http://127.0.0.1:3080/dsh-web-relay/health-check';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHealth() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return await r.json();
    } catch { /* 宿主可能仍在重启，重试 */ }
    await sleep(3000);
  }
  return null;
}

const h = await fetchHealth();
if (!h) {
  console.log('  FAIL  无法连上 /health-check（90 秒内重试 30 次仍失败）');
  process.exit(1);
}

console.log('=== ① 重启确实发生 ===');
check('bootId 已变化（新宿主加载了新代码）', !!PREV_BOOT && h.bootId !== PREV_BOOT, `prev=${PREV_BOOT} now=${h.bootId}`);
console.log(`       bootId: ${PREV_BOOT} → ${h.bootId}`);

console.log('=== ② ccChainStats 已在运行时暴露且带真实数字 ===');
const s = h.ccChainStats;
check('字段存在', s !== undefined && s !== null, `实际=${JSON.stringify(s)}`);
if (s) {
  for (const k of ['total', 'ok', 'failed', 'markerMissing', 'byFailure', 'byStatus', 'successRate', 'recent']) {
    check(`含子字段 ${k}`, Object.prototype.hasOwnProperty.call(s, k), `实际键=${Object.keys(s).join(',')}`);
  }
  check('recent 是数组且 ≤10', Array.isArray(s.recent) && s.recent.length <= 10, `recent=${Array.isArray(s.recent) ? s.recent.length : typeof s.recent}`);
  check('total > 0（确实聚合到了链条任务）', typeof s.total === 'number' && s.total > 0, `total=${s.total}`);
  console.log(`       实测：total=${s.total} ok=${s.ok} failed=${s.failed} markerMissing=${s.markerMissing} successRate=${s.successRate}`);
  console.log(`       byFailure=${JSON.stringify(s.byFailure)}`);
}

console.log('=== ③ 既有 ccStats（审核通道）未回归 ===');
check('ccStats 仍存在', h.ccStats !== undefined, `实际=${typeof h.ccStats}`);
check('ccStats 与 ccChainStats 是两个独立字段', h.ccStats !== h.ccChainStats, '两者相同 → 疑似接线错误');

console.log('=== ④ 自检契约（本轮把 ccChainStats 写进了必须字段清单）===');
let sc = h.selfCheck;
for (let i = 0; i < 20 && !sc; i++) { await sleep(3000); sc = (await fetchHealth() || {}).selfCheck; }
check('selfCheck 已跑完（非 null）', !!sc, '60 秒内仍为 null');
if (sc) {
  const contract = sc.contract || (sc.differing !== undefined ? sc : null);
  check('契约检查 ok', contract ? contract.ok !== false : false, JSON.stringify(sc).slice(0, 240));
  const diffs = sc.differing || (sc.contract && sc.contract.differing) || [];
  check('无交付漂移（differing 为空）', Array.isArray(diffs) && diffs.length === 0, `differing=${JSON.stringify(diffs).slice(0, 200)}`);
  check('bootId 一致（自检属于本次 boot）', !sc.bootId || sc.bootId === h.bootId, `selfCheck.bootId=${sc.bootId} vs ${h.bootId}`);
}

console.log(`\nRESULT: ${pass}/${pass + fail} 通过${fail ? `（${fail} 失败）` : ''}`);
process.exit(fail ? 1 : 0);
