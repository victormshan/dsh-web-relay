// 设计2 分析器：从每份报告抽取 3 段修复源码 → 交给**隐藏探针执行** → 统计通过率。
// 判定全程无模型参与：这是本设计最关键的属性（消掉风格混杂与自判自偏好）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WORK = 'D:\\dsh relay test';
const CC = 'D:\\cc-tasks';
const N = 8;
const CASES = [1, 2, 3];

const extractFixes = (reportPath) => {
  const t = fs.readFileSync(reportPath, 'utf8');
  const out = new Map();
  for (const id of CASES) {
    const b = t.indexOf(`===EXEC-FIX ${id} BEGIN===`);
    const e = t.indexOf(`===EXEC-FIX ${id} END===`);
    if (b < 0 || e < 0 || e < b) { out.set(id, null); continue; }
    let src = t.slice(b + `===EXEC-FIX ${id} BEGIN===`.length, e).trim();
    // 容错：若模型仍套了 markdown 围栏，剥掉一层
    src = src.replace(/^```[a-zA-Z]*\s*\n/, '').replace(/\n```\s*$/, '').trim();
    out.set(id, src);
  }
  return out;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'execjudge-'));
const judge = (arm, round, caseId, src) => {
  if (!src) return { ok: false, reason: '未抽取到源码' };
  const f = path.join(tmp, `${arm}${round}-${caseId}.mjs`);
  fs.writeFileSync(f, src, 'utf8');
  const r = spawnSync(process.execPath, [path.join(WORK, 'probes', 'run-probe.mjs'), String(caseId), f], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/RESULT: (\d+)\/(\d+)/);
  return { ok: r.status === 0, pass: m ? Number(m[1]) : -1, total: m ? Number(m[2]) : -1, tail: out.trim().split('\n').slice(-1)[0] || '' };
};

const arms = { P: [], E: [] };
const detail = [];
for (const arm of ['P', 'E']) {
  for (let r = 1; r <= N; r++) {
    const t = String(r).padStart(2, '0');
    const id = `ccexec-20260917-${arm.toLowerCase()}${t}`;
    const rp = path.join(CC, 'tasks', id, 'out', 'report.md');
    if (!fs.existsSync(rp)) { detail.push({ arm, round: r, caseId: '-', ok: false, reason: '报告缺失' }); continue; }
    const txt = fs.readFileSync(rp, 'utf8');
    const noRepro = (txt.match(/NO_REPRO/g) || []).length;
    const fixes = extractFixes(rp);
    for (const c of CASES) {
      const v = judge(arm, r, c, fixes.get(c));
      arms[arm].push({ round: r, caseId: c, ...v });
      detail.push({ arm, round: r, caseId: c, ok: v.ok, pass: v.pass, total: v.total, reason: v.reason || '' });
    }
    arms[arm].noRepro = (arms[arm].noRepro || 0) + noRepro;
    arms[arm].bytes = (arms[arm].bytes || 0) + Buffer.byteLength(txt, 'utf8');
  }
}

const rate = (a) => a.filter((x) => x.ok).length / (a.length || 1);
console.log('=== 设计2：执行判定结果（无模型裁判）===');
for (const arm of ['P', 'E']) {
  const a = arms[arm];
  const pass = a.filter((x) => x.ok).length;
  console.log(`  ${arm} 组（${arm === 'P' ? '散文反证' : '可执行反例'}）: 探针通过 ${pass}/${a.length} = ${(rate(a) * 100).toFixed(1)}%`);
  console.log(`     按案例: ${CASES.map((c) => `案例${c} ${a.filter((x) => x.caseId === c && x.ok).length}/${a.filter((x) => x.caseId === c).length}`).join('  ')}`);
  console.log(`     NO_REPRO 出现 ${a.noRepro || 0} 次 ｜ 报告总字节 ${a.bytes || 0}`);
}

// 置换检验（两臂通过率之差）
const pool = [...arms.P.map((x) => (x.ok ? 1 : 0)), ...arms.E.map((x) => (x.ok ? 1 : 0))];
const nP = arms.P.length;
const obs = rate(arms.E) - rate(arms.P);
let ge = 0;
const ITER = 20000;
let s0 = 0x51ed270b;
const rnd = () => { s0 ^= s0 << 13; s0 >>>= 0; s0 ^= s0 >>> 17; s0 ^= s0 << 5; s0 >>>= 0; return s0 / 0x100000000; };
for (let it = 0; it < ITER; it++) {
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  const rp = a.slice(0, nP).reduce((s, v) => s + v, 0) / nP;
  const re = a.slice(nP).reduce((s, v) => s + v, 0) / (a.length - nP);
  if (Math.abs(re - rp) >= Math.abs(obs) - 1e-12) ge++;
}
const p = ge / ITER;
console.log(`\n  观测差（E − P）= ${(obs * 100).toFixed(1)}pp`);
console.log(`  置换检验（${ITER} 次，双尾）p ≈ ${p.toFixed(4)}`);

console.log('\n=== 结论（按预登记规则：E 更优 ⇔ 通过率更高 且 p<0.05）===');
if (obs > 0 && p < 0.05) console.log('  → 支持 H1：要求可执行反例显著提升修复质量。');
else if (Math.abs(obs) < 1e-9) console.log('  → 两臂通过率相同 → 无可检出差异。');
else console.log(`  → 不支持 H1（差 ${(obs * 100).toFixed(1)}pp，p=${p.toFixed(4)}）→ 本规模下无可检出差异。`);

console.log('\n=== 逐条明细（失败者附原因）===');
for (const d of detail) {
  if (!d.ok) console.log(`  ✗ ${d.arm}${String(d.round).padStart(2, '0')} 案例${d.caseId}  ${d.reason || `探针 ${d.pass}/${d.total}`}`);
}
fs.writeFileSync(path.join(CC, 'exec-result.json'), JSON.stringify({ at: new Date().toISOString(), P: { n: arms.P.length, pass: arms.P.filter((x) => x.ok).length, noRepro: arms.P.noRepro, bytes: arms.P.bytes }, E: { n: arms.E.length, pass: arms.E.filter((x) => x.ok).length, noRepro: arms.E.noRepro, bytes: arms.E.bytes }, obsDiff: obs, permutationP: p, detail }, null, 2), 'utf8');
console.log('\n  → 明细已写 D:\\cc-tasks\\exec-result.json');
fs.rmSync(tmp, { recursive: true, force: true });
