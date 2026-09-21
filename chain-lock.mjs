// 共享的「链条是否在飞」感知：让工具能区分三种完全不同的结局——
//   判定失败(exit 1) ≠ 工具坏了(exit 3) ≠ **此刻根本不适用**(exit 4)。
//
// 为什么需要（2026-09-18 实测事故）：cc 正在写仓库时跑回归套件，一次踩了三处：
//   ① 链条自测见锁即"本次跳过" → 关键字缺失被读成失败（假失败）；
//   ② verify-cc-task 见工作区脏（正是 cc 在改的文件）→ 把**正在执行**的任务判成 REJECT；
//   ③ 验收接线契约会改写 current-chain.txt / chain-state.json → 直接干扰在飞的链条，
//      而且它中途被杀就会留下**指向已删链条文件**的指针 → 自动化静默停摆。
// 所以：需要独占状态或需要稳定仓库快照的工具，在链锁持有时一律 exit 4，而不是给出一个看似有效的判定。
// "诊断说谎比不诊断更糟" —— 此刻的真实结论是"结论无意义"。
import fs from 'node:fs';

export const CHAIN_LOCK = 'D:\\cc-tasks\\chain.lock';

export function chainLive() {
  try {
    const st = fs.statSync(CHAIN_LOCK);
    return { live: true, ageMin: Number(((Date.now() - st.mtimeMs) / 60000).toFixed(1)) };
  } catch {
    return { live: false, ageMin: null };
  }
}

/**
 * 若链条在飞则打印 SKIP 并返回 true（调用方应 process.exit(4)）。
 * @param {string} what 这个工具此刻为什么会被污染
 */
export function skipIfChainLive(what) {
  const s = chainLive();
  if (!s.live) return false;
  console.log(`  [SKIP] 链条运行中（锁 ${s.ageMin} 分钟前创建，${CHAIN_LOCK}）：${what}`);
  console.log('  NOT-APPLICABLE（exit 4）——此刻的结论会被在飞的 cc 改写污染，这不是判定失败，也不是工具损坏。');
  return true;
}

/**
 * 等链条空闲（区分"瞬时取锁"与"真在干活"）。
 *
 * 为什么需要（2026-09-18 实测）：计划任务每 20 分钟触发一次；即使链条无事可做（已完成/无指针），
 * 它也会**短暂取锁**再释放。只判"此刻有没有锁"的守卫于是频繁被这种 <1s 的瞬时锁作废整轮（连续两次 exit 3）。
 * 但盲目忽略锁又会漏掉真的在跑的链条，故按**持续性**判别：
 *   · 锁已存在 ≥ staleMin 分钟 → 直接认定链条在干活，不再等；
 *   · 锁存在但很年轻 → 等一小会儿再看：自己消失=瞬时锁（继续），一直在=真在干活（idle:false）。
 */
export function waitForChainIdle({ maxWaitMs = 120000, settleMs = 1500, staleMin = 1 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    const s = chainLive();
    if (!s.live) return { idle: true, waitedMs: Date.now() - t0 };
    if (s.ageMin >= staleMin) return { idle: false, ageMin: s.ageMin, waitedMs: Date.now() - t0, reason: '锁已存在较久 → 链条确实在干活' };
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settleMs);
  }
  const s = chainLive();
  return { idle: !s.live, ageMin: s.ageMin, waitedMs: Date.now() - t0, timedOut: true, reason: '等待超时，锁始终未释放' };
}
