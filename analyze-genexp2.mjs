// 第二轮分析器：**改进后的仪器**（在第一轮已证缺陷上针对性设计）
//   ① 风格归一：剥离 markdown、折叠空白、**统一截断到同一长度** → 掐掉"长度/词密度"通道
//   ② 主指标：**成对盲评**（每例 8 对 S-vs-D + 1 对锚点），给出胜率与 Wilson 95% CI
//   ③ 仪器自检：每例的锚点对 = 金标准答案 vs 敷衍答案；裁判必须选中金标准，否则**该例判定作废**
//   ④ 次指标：风格归一后的 token 命中率；以及对照组的"过度设计命中"（negTokens）
// 预登记判定规则：锚点全通过后，仅当合并胜率 CI 下界 > 50% 才判 D 更优；CI 跨 50% 判"本规模下无差异"。
import fs from 'node:fs';
import path from 'node:path';

const CC = 'D:\\cc-tasks';
const labels = JSON.parse(fs.readFileSync(path.join(CC, 'genexp2-labels.json'), 'utf8'));
const CASES = labels.cases;
const N = 8;                    // 每臂轮数
const TRUNC = 220;              // 风格归一后的统一截断长度（所有答案一视同仁）

// ---------- 风格归一 ----------
const normalize = (s) => String(s || '')
  .replace(/```[\s\S]*?```/g, ' ')          // 代码块
  .replace(/[*_`>#]+/g, ' ')                // markdown 记号
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // 链接
  .replace(/\s+/g, ' ')                     // 折叠空白
  .trim()
  .slice(0, TRUNC);                         // ★ 统一截断：长度不再是区分信号

// ---------- 读取 16 份产物 ----------
const parseBlock = (rp) => {
  const t = fs.readFileSync(rp, 'utf8');
  const a = t.indexOf('GEN2-RESULT-BEGIN'); const b = t.indexOf('GEN2-RESULT-END');
  if (a < 0 || b < 0 || b < a) return null;
  const out = new Map();
  const parts = t.slice(a, b).split(/CASE\s*(\d+)\s*[:：]/);
  for (let i = 1; i < parts.length; i += 2) {
    const id = Number(parts[i]); const body = parts[i + 1] || '';
    const alt = (body.match(/ALTERNATIVE\s*[:：]\s*([^\n]*)/i) || [, ''])[1].trim();
    const risk = (body.match(/RISK\s*[:：]\s*([^\n]*)/i) || [, ''])[1].trim();
    out.set(id, { alt, risk, text: `${alt} ${risk}` });
  }
  return out;
};
const runs = { S: [], D: [] };
for (let r = 1; r <= N; r++) {
  const t = String(r).padStart(2, '0');
  for (const [arm, a] of [['S', 's'], ['D', 'd']]) {
    const id = `ccgen2-20260917-${a}${t}`;
    const got = parseBlock(path.join(CC, 'tasks', id, 'out', 'report.md'));
    if (!got) { console.log(`  ✗ ${id} 无法解析，实验中止`); process.exit(2); }
    runs[arm].push({ id, got });
  }
}
console.log(`  载入: S=${runs.S.length} D=${runs.D.length}`);

// ---------- 次指标：风格归一后的 token 命中 ----------
const tokenHit = (c, text) => c.tokens.every((group) => group.some((tk) => text.toLowerCase().includes(String(tk).toLowerCase())));
const negHit = (c, text) => (c.negTokens || []).some((tk) => text.toLowerCase().includes(String(tk).toLowerCase()));

console.log('\n=== 次指标（风格归一口径；同批输出）===');
for (const c of CASES) {
  const rate = (arm) => {
    const n = runs[arm].filter((r) => tokenHit(c, normalize(r.got.get(c.id).text))).length;
    return `${n}/${runs[arm].length}`;
  };
  const neg = (arm) => runs[arm].filter((r) => negHit(c, normalize(r.got.get(c.id).text))).length;
  if (c.kind === 'control') {
    console.log(`  案例${c.id} [对照] token 命中 S ${rate('S')} / D ${rate('D')} ｜ 过度设计命中 S ${neg('S')} / D ${neg('D')}`);
  } else {
    console.log(`  案例${c.id} [洞察] token 命中 S ${rate('S')} / D ${rate('D')}`);
  }
}

// ---------- 主指标：成对盲评（每例一次裁判调用）----------
const VAGUE = '建议先充分梳理需求、注意边界情况与一致性，做好日志与监控，必要时引入缓存与重试，并保证改动可回滚。';
let seed = 0x2f6e2b1;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 0x100000000; };

const perCase = [];
const mappings = [];
for (const c of CASES) {
  // 8 对（S_r vs D_r）+ 1 对锚点（金标准 vs 敷衍）
  const pairs = [];
  for (let i = 0; i < N; i++) {
    const sTxt = normalize(runs.S[i].got.get(c.id).text);
    const dTxt = normalize(runs.D[i].got.get(c.id).text);
    const dIsA = rnd() < 0.5;                       // 随机决定哪位是"甲"
    pairs.push({ kind: 'test', i, A: dIsA ? dTxt : sTxt, B: dIsA ? sTxt : dTxt, dIsA });
  }
  const goldIsA = rnd() < 0.5;
  pairs.push({ kind: 'anchor', A: goldIsA ? normalize(c.truth) : normalize(VAGUE), B: goldIsA ? normalize(VAGUE) : normalize(c.truth), goldIsA });

  const body = pairs.map((p, idx) => {
    const tag = p.kind === 'anchor' ? '对A' : `对${idx + 1}`;
    return `【${tag}】\n  甲：${p.A}\n  乙：${p.B}`;
  }).join('\n\n');

  const prompt = `你是独立的方案评审裁判。下面给出情境「${c.title}」的**评分基准**（该情境下经事件验证的关键洞察）与若干**匿名答案对**。

【评分基准】${c.truth}

【判定要求】
- 逐对判断**哪一份更贴近评分基准**（命中基准中的关键洞察），或判定"平"。
- **只看是否命中基准中的关键洞察**；答案更长、术语更多、结构更完整、排版更漂亮，**都不构成加分**。
- 若两份都没命中或命中程度相当，判"平"。

${body}

【输出格式（严格，逐行，勿加其它内容）】
${pairs.map((p, idx) => `${p.kind === 'anchor' ? '对A' : '对' + (idx + 1)}: 甲|乙|平`).join('\n')}`;

  let verdictText = null;
  for (const provider of ['gemini-free', 'web-gemini']) {
    try {
      const r = await fetch('http://127.0.0.1:3080/dsh-web-relay/ask', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // ★ 必传 workspacePath（漏传会让 relay 以宿主 cwd 为基准、在仓库内落盘——今天已因此出过一次事故）
        body: JSON.stringify({ provider, prompt, workspacePath: 'D:\\dsh relay test', exprId: 'expr-2026-09-13_17-36-07' }),
      });
      const j = await r.json();
      if (j && j.ok) { verdictText = String(j.text || j.answer || ''); console.log(`\n  [案例${c.id}] 裁判通道=${j.providerLabel || provider}`); break; }
      console.log(`  [案例${c.id}] ${provider} 失败: ${String(j && (j.error || '')).slice(0, 90)}`);
    } catch (e) { console.log(`  [案例${c.id}] ${provider} 异常: ${e.message}`); }
  }
  if (!verdictText) { console.log(`  ✗ 案例${c.id} 裁判不可用 → 实验无法判定`); process.exit(3); }
  fs.writeFileSync(path.join(CC, `genexp2-judge-case${c.id}.txt`), verdictText, 'utf8');

  const verdict = new Map();
  for (const m of verdictText.matchAll(/对\s*(A|\d+)\s*[:：]\s*(甲|乙|平)/g)) verdict.set(m[1], m[2]);

  // 锚点自检
  const anchor = verdict.get('A');
  const goldSide = pairs[N].goldIsA ? '甲' : '乙';
  const anchorOk = anchor === goldSide;
  console.log(`  [案例${c.id}] 锚点: 裁判选=${anchor || '(缺)'} 金标准=${goldSide} → ${anchorOk ? 'PASS' : 'FAIL（该例判定作废）'}`);

  let dWin = 0; let sWin = 0; let tie = 0; let missing = 0;
  for (let idx = 0; idx < N; idx++) {
    const v = verdict.get(String(idx + 1));
    if (!v) { missing++; continue; }
    if (v === '平') { tie++; continue; }
    const pickedD = (v === '甲') === pairs[idx].dIsA;
    if (pickedD) dWin++; else sWin++;
  }
  mappings.push({ caseId: c.id, pairs: pairs.map((p, idx) => (p.kind === 'anchor' ? { anchor: true, goldIsA: p.goldIsA } : { i: p.i, dIsA: p.dIsA })), anchorOk });
  perCase.push({ caseId: c.id, kind: c.kind, title: c.title, dWin, sWin, tie, missing, anchorOk });
}

// ---------- 聚合（Wilson 95% CI）----------
console.log('\n=== 主指标：成对盲评 ===');
const valid = perCase.filter((x) => x.anchorOk);
const D = valid.reduce((s, x) => s + x.dWin, 0);
const S = valid.reduce((s, x) => s + x.sWin, 0);
const T = valid.reduce((s, x) => s + x.tie, 0);
const miss = perCase.reduce((s, x) => s + x.missing, 0);
for (const x of perCase) {
  console.log(`  案例${x.caseId} [${x.kind}] D胜 ${x.dWin} / S胜 ${x.sWin} / 平 ${x.tie}${x.anchorOk ? '' : '  ← 锚点未过，已剔除'}`);
}
const n = D + S;
const p = n ? D / n : NaN;
const z = 1.96;
const denom = 1 + (z * z) / n;
const center = (p + (z * z) / (2 * n)) / denom;
const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
const lo = Math.max(0, center - half); const hi = Math.min(1, center + half);
console.log(`\n  有效案例 = ${valid.length}/${CASES.length}（锚点全过才算）｜ 有效对 = ${n}（平 ${T}，缺失 ${miss}）`);
console.log(`  D 胜率 = ${(p * 100).toFixed(1)}%  （D ${D} : S ${S}）  Wilson 95% CI = [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]`);

console.log('\n=== 结论（按预登记规则）===');
if (valid.length !== CASES.length) {
  console.log(`  ⚠ 有 ${CASES.length - valid.length} 例锚点未通过 → 仪器在该例不可信；结论降级为"部分有效"。`);
}
if (!(n > 0)) console.log('  ⚠ 无有效对 → 不构成结论。');
else if (lo > 0.5) console.log('  → 支持 H1：胜率 CI 下界 > 50%，D 更优。');
else if (hi < 0.5) console.log('  → 反方向：胜率 CI 上界 < 50%，S 更优。');
else console.log('  → 不支持 H1：CI 跨 50% → **本规模下两臂无显著差异**（不主张提升）。');

fs.writeFileSync(path.join(CC, 'genexp2-result.json'), JSON.stringify({
  at: new Date().toISOString(), perCase, validCases: valid.length, dWin: D, sWin: S, tie: T, missing: miss,
  winRate: p, wilsonCI: [lo, hi], mappings,
}, null, 2), 'utf8');
console.log('\n  → 明细已写 D:\\cc-tasks\\genexp2-result.json');
