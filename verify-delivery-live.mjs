// ⑤ 交付接地门禁：断言"运行中的宿主**确实**加载了新代码"，而不是只看"文件复制过去了"。
//
// 背景（本会话两次实测 + 一次歧义）：
//   · sync-install-carrier 只补缺失文件、永不覆盖 → "看起来同步了其实没生效"；
//   · 只交付不重启 → 运行时字段纹丝不动（两次实测：A4b 与分类器修复都需重启才生效）；
//   · 版本号无法标识代码状态（4.9.7 在整个会话里没变过，我两次只能靠 bootId 对比间接推断修复是否上线）。
//
// 三级证据（越靠前越强，逐级降级并**明确标注证据强度**）：
//   ① 精确：/health-check 暴露 loadedSha 时，直接比对仓库 HEAD（需插件新增字段，属 cc 任务）。
//   ② 强：三份副本逐字节一致（文件层面已送达）。
//   ③ 中：宿主进程启动时刻 **晚于**最近一次交付（deliver-three-copies 会留下 .dsh-relay-backup-<ISO> 目录，
//      其名称即交付时刻）→ 说明重启发生在交付之后，故加载的是新代码。
// 用法: node verify-delivery-live.mjs [--json]
//       node verify-delivery-live.mjs --selftest    # 两侧自检
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { skipIfChainLive } from './chain-lock.mjs';

const REPO = 'D:\\dsh-web-relay';
const TARGETS = [
  { label: '运行时副本（宿主实际加载）', root: 'C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-web-relay' },
  { label: 'DSH 侧副本', root: 'D:\\DSH\\dsh-web-relay' },
  { label: 'standalone 副本', root: 'D:\\dsh-web-relay-standalone' },
];

/** 纯函数：判定交付接地结论。输入均为已采集的原始事实，便于两侧自检。
 *
 * 2026-09-18 语义修正（本轮实测暴露）：初版把"仓库有未交付改动"和"交付没接地"混成一个 FAIL。
 * 但 ⑤ 要回答的问题是**"宿主加载的是不是已交付的那份代码"**，而不是"仓库是否干净"——
 * 开发期仓库天天领先于交付（cc 每次改完都要等交付+重启），把前者算成 FAIL 会让这个审计长期误报，
 * 直接导致告警疲劳（狼来了）。故拆开：
 *   接地的判据 = loadedLibHash 与**运行时副本**（宿主实际加载的那份）一致；
 *   仓库 vs 副本的差异单列为 info（"有 N 个文件待交付"），不影响接地结论。
 */
export function judgeDelivery({ repoHead, loadedSha, repoLibHash, loadedLibHash, runtimeLibHash, filesDiffer, newestBackupMs, hostStartMs }) {
  const reasons = [];
  const pending = filesDiffer > 0 ? `（另有 ${filesDiffer} 个文件尚未交付到副本——属"待交付"，不改变接地结论）` : '';
  // ① 精确（首选）：宿主已暴露"已加载 lib 代码指纹"，与**运行时副本**比对——直接回答"加载的是不是已交付的那份"。
  if (loadedLibHash && runtimeLibHash) {
    const ok = String(loadedLibHash) === String(runtimeLibHash);
    return {
      ok, strength: '精确（loadedLibHash 对运行时副本）',
      reasons: ok
        ? [`宿主已加载代码指纹 ${loadedLibHash} 与运行时副本一致${pending}`]
        : [`宿主已加载代码指纹 ${loadedLibHash} ≠ 运行时副本 ${runtimeLibHash} → 宿主仍在跑旧代码，需重启`],
    };
  }
  // ② 精确（次选）：没有副本指纹时退化到与仓库指纹比对（此时"未交付改动"会表现为不一致，故提示待交付）。
  if (loadedLibHash && repoLibHash) {
    const ok = String(loadedLibHash) === String(repoLibHash);
    return { ok, strength: '精确（loadedLibHash 对仓库）', reasons: ok ? [] : [`运行时已加载代码指纹 ${loadedLibHash} ≠ 仓库当前指纹 ${repoLibHash} → 宿主加载的是旧代码（需交付并重启）`] };
  }
  if (loadedSha) {
    const ok = String(loadedSha).startsWith(String(repoHead));
    return { ok, strength: '精确（loadedSha）', reasons: ok ? [] : [`/health-check 的 loadedSha=${loadedSha} 与仓库 HEAD=${repoHead} 不一致`] };
  }
  if (filesDiffer > 0) {
    return { ok: false, strength: '强（文件比对）', reasons: [`三份副本中仍有 ${filesDiffer} 个文件与仓库不一致 → 交付未完成或未重新交付`] };
  }
  if (!Number.isFinite(newestBackupMs)) {
    return { ok: false, strength: '中（启动时刻）', reasons: ['找不到任何 .dsh-relay-backup-<ts> 目录 → 无法确定交付时刻，也就无法证明宿主加载了新代码（请先跑 deliver-three-copies --apply）'] };
  }
  if (!Number.isFinite(hostStartMs)) {
    return { ok: false, strength: '中（启动时刻）', reasons: ['无法取得宿主进程启动时刻 → 无法证明重启发生在交付之后'] };
  }
  if (hostStartMs < newestBackupMs) {
    return { ok: false, strength: '中（启动时刻）', reasons: [`宿主启动于交付**之前**（交付 ${new Date(newestBackupMs).toISOString()} > 启动 ${new Date(hostStartMs).toISOString()}）→ 运行时仍是旧代码，需重启`] };
  }
  reasons.push('证据强度为"中"：文件已一致且宿主在交付后启动，但未暴露 loadedLibHash（建议插件新增该字段以升级为精确证据）');
  return { ok: true, strength: '中（启动时刻）', reasons };
}

// 实跑（非自检）需要**稳定的仓库快照**：cc 正在改仓库时，仓库与包内副本必然瞬时不一致，
// 此刻判"交付是否接地"只会产出假 ACTION-NEEDED（狼来了会让人不再看告警）。故链锁持有时 exit 4。
if (!process.argv.includes('--selftest') && skipIfChainLive('交付接地要比较仓库/包/已加载三份快照，仓库正在被 cc 改写')) process.exit(4);

if (process.argv.includes('--selftest')) {
  const now = Date.now();
  const cases = [
    ['[POS] loadedLibHash 与仓库指纹一致 → 放行（精确证据，首选）', { repoHead: 'abc', repoLibHash: 'h1', loadedLibHash: 'h1', filesDiffer: 0, newestBackupMs: now, hostStartMs: now - 60000 }, true],
    ['[NEG] loadedLibHash 与仓库指纹不一致 → 抓（即使文件已交付、宿主也已重启）', { repoHead: 'abc', repoLibHash: 'h2', loadedLibHash: 'h1', filesDiffer: 0, newestBackupMs: now, hostStartMs: now + 1000 }, false],
    ['[POS] loadedSha 与 HEAD 一致 → 放行（精确证据）', { repoHead: 'abc123', loadedSha: 'abc1234567', filesDiffer: 0, newestBackupMs: now, hostStartMs: now + 1000 }, true],
    ['[NEG] loadedSha 与 HEAD 不一致 → 抓', { repoHead: 'abc123', loadedSha: 'def999', filesDiffer: 0, newestBackupMs: now, hostStartMs: now + 1000 }, false],
    ['[NEG] 副本仍有文件不一致 → 抓', { repoHead: 'abc', loadedSha: null, filesDiffer: 3, newestBackupMs: now, hostStartMs: now + 1000 }, false],
    ['[NEG] 找不到交付备份 → 抓（无法证明）', { repoHead: 'abc', loadedSha: null, filesDiffer: 0, newestBackupMs: NaN, hostStartMs: now }, false],
    ['[NEG] 宿主启动早于交付（交付后未重启）→ 抓', { repoHead: 'abc', loadedSha: null, filesDiffer: 0, newestBackupMs: now, hostStartMs: now - 60000 }, false],
    ['[POS] 无 loadedSha 但文件一致且宿主晚于交付启动 → 放行（标注中等强度）', { repoHead: 'abc', loadedSha: null, filesDiffer: 0, newestBackupMs: now, hostStartMs: now + 1000 }, true],
    // 2026-09-18 新增：把"接地"与"待交付"拆开后必须仍具备区分力
    ['[POS] 宿主指纹 == 运行时副本指纹，且仓库还有 3 个文件待交付 → 放行（待交付≠未接地）',
      { repoHead: 'abc', repoLibHash: 'hRepoNew', runtimeLibHash: 'hDelivered', loadedLibHash: 'hDelivered', filesDiffer: 3, newestBackupMs: now, hostStartMs: now + 1000 }, true],
    ['[NEG] 宿主指纹 ≠ 运行时副本指纹（交付了但没重启）→ 抓',
      { repoHead: 'abc', repoLibHash: 'h', runtimeLibHash: 'hNew', loadedLibHash: 'hOld', filesDiffer: 0, newestBackupMs: now, hostStartMs: now + 1000 }, false],
    ['[POS] 无副本指纹时退化到仓库指纹比对（一致）→ 放行',
      { repoHead: 'abc', repoLibHash: 'h1', runtimeLibHash: null, loadedLibHash: 'h1', filesDiffer: 0, newestBackupMs: now, hostStartMs: now + 1000 }, true],
  ];
  let bad = 0;
  for (const [name, input, expect] of cases) {
    const r = judgeDelivery(input);
    const ok = r.ok === expect;
    if (!ok) bad++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : `（期望 ${expect}，实际 ${r.ok}：${r.reasons.join('；')}）`}`);
  }
  console.log(`\nRESULT: ${cases.length - bad}/${cases.length} ${bad ? 'FAIL' : 'PASS'}`);
  process.exit(bad ? 1 : 0);
}

// ---- 采集事实 ----
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const repoHead = String(spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim();
const pkgFiles = (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const out = [];
  const walk = (rel) => {
    const abs = path.join(REPO, rel.split('/').join(path.sep));
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) { for (const e of fs.readdirSync(abs)) walk(`${rel}/${e}`); return; }
    out.push(rel);
  };
  for (const f of pkg.files || []) walk(f);
  return out;
})();

let filesDiffer = 0; const missing = [];
for (const t of TARGETS) {
  for (const rel of pkgFiles) {
    const src = path.join(REPO, rel.split('/').join(path.sep));
    const dst = path.join(t.root, rel.split('/').join(path.sep));
    if (!fs.existsSync(dst)) { missing.push(`${t.label}:${rel}`); filesDiffer++; continue; }
    if (sha(src) !== sha(dst)) { filesDiffer++; missing.push(`${t.label}:${rel}`); }
  }
}

let newestBackupMs = NaN;
// 备份目录名形如 .dsh-relay-backup-2026-09-15T23-50-55-166Z —— **时间部分是连字符**，
// 直接 Date.parse 会得到 NaN（本文件初版正是如此，导致"找不到交付时刻"的假失败）。需把 HH-MM-SS-mmm 还原成冒号点。
const parseBackupStamp = (name) => {
  const m = name.match(/^\.dsh-relay-backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{1,3})Z$/);
  if (!m) return NaN;
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5].padStart(3, '0')}Z`);
};
for (const t of TARGETS) {
  try {
    for (const d of fs.readdirSync(t.root)) {
      const ms = parseBackupStamp(d);
      if (Number.isFinite(ms) && (!Number.isFinite(newestBackupMs) || ms > newestBackupMs)) newestBackupMs = ms;
    }
  } catch { /* 目标不存在 */ }
}

let hostStartMs = NaN;
try {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'bin.js web' } | Select-Object -First 1).CreationDate.ToString('o')"],
    { encoding: 'utf8' });
  hostStartMs = Date.parse(String(ps.stdout || '').trim());
} catch { /* 取不到 */ }

let loadedSha = null; let loadedLibHash = null; let loadedFrom = null;
try {
  // 必须让子进程吐 **JSON** 再解析：初版是 `console.log(sha + ' ' + libhash)` 再按空格切，
  // 而 sha 为空时 `trim()` 会把前导空格吃掉 → 第二个字段**错位**到第一个位置上，
  // 于是实测出现 "loadedSha=c463b7d0... / loadedLibHash=(未暴露)" 这种**假失败**（仪器说谎）。
  // 教训：跨进程传结构化数据就别用位置化的文本拼接。
  const js = "fetch('http://127.0.0.1:3080/dsh-web-relay/health-check')"
    + ".then(r=>r.json())"
    + ".then(j=>console.log(JSON.stringify({sha:j.loadedSha||j.commitSha||null,lib:j.loadedLibHash||(j.selfCheck&&j.selfCheck.loadedLibHash)||null,from:j.loadedFrom||null,boot:j.bootId||null})))";
  const r = spawnSync(process.execPath, ['-e', js], { encoding: 'utf8' });
  const j = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}');
  loadedSha = j.sha || null; loadedLibHash = j.lib || null; loadedFrom = j.from || null;
} catch { /* 取不到 */ }

// 仓库侧 lib 代码指纹：与插件侧**必须用同一算法**（spec 已约定）
// sha256 over 逐文件 `${basename}\n${sha256hex(content)}\n`（按 basename 排序），取前 16 位
const repoLibHash = (() => {
  const dir = path.join(REPO, 'lib');
  const names = fs.readdirSync(dir).filter((f) => /\.(js|mjs)$/.test(f)).sort();
  const parts = names.map((n) => `${n}\n${sha256hex(fs.readFileSync(path.join(dir, n)))}\n`);
  return sha256hex(Buffer.from(parts.join(''), 'utf8')).slice(0, 16);
})();

// 运行时副本侧 lib 代码指纹（同一算法）：这才是"宿主实际加载的那份代码"的参照物。
// 与仓库指纹的差异 = "有文件待交付"（开发期常态），不应据此判 FAIL。
const runtimeLibHash = (() => {
  try {
    const dir = path.join(TARGETS[0].root, 'lib');
    const names = fs.readdirSync(dir).filter((f) => /\.(js|mjs)$/.test(f)).sort();
    const parts = names.map((n) => `${n}\n${sha256hex(fs.readFileSync(path.join(dir, n)))}\n`);
    return sha256hex(Buffer.from(parts.join(''), 'utf8')).slice(0, 16);
  } catch { return null; }
})();

console.log('=== ⑤ 交付接地审计 ===');
console.log(`  仓库 HEAD = ${repoHead} ｜ 清单文件 ${pkgFiles.length} 个 × 3 副本`);
console.log(`  副本不一致/缺失 = ${filesDiffer}${filesDiffer ? '（例：' + missing.slice(0, 3).join(', ') + '）' : ''}`);
console.log(`  最近一次交付 = ${Number.isFinite(newestBackupMs) ? new Date(newestBackupMs).toISOString() : '(找不到备份目录)'}`);
console.log(`  宿主启动时刻 = ${Number.isFinite(hostStartMs) ? new Date(hostStartMs).toISOString() : '(取不到)'}`);
console.log(`  loadedSha = ${loadedSha || '(未暴露——建议插件新增该字段)'}`);
console.log(`  loadedLibHash = ${loadedLibHash || '(未暴露)'} ｜ 仓库侧指纹 = ${repoLibHash} ｜ 运行时副本指纹 = ${runtimeLibHash || '(读不到)'}`);
if (loadedFrom) console.log(`  loadedFrom = ${loadedFrom}`);
const v = judgeDelivery({ repoHead, loadedSha, repoLibHash, loadedLibHash, runtimeLibHash, filesDiffer, newestBackupMs, hostStartMs });
console.log(`  证据强度 = ${v.strength}`);
for (const r of v.reasons) console.log(`  ${v.ok ? '⚠' : '✗'} ${r}`);
console.log(`\n  RESULT: ${v.ok ? 'PASS（宿主已加载仓库代码）' : 'FAIL（无法证明宿主加载了仓库代码）'}`);
if (process.argv.includes('--json')) fs.writeFileSync('D:\\cc-tasks\\delivery-live.json', JSON.stringify({ at: new Date().toISOString(), repoHead, filesDiffer, missing: missing.slice(0, 20), newestBackupMs, hostStartMs, loadedSha, ...v }, null, 2), 'utf8');
process.exit(v.ok ? 0 : 1);
