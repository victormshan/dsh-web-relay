// 决定性校准：把**同一批**两臂输出同时交给 token 匹配器与独立盲评（外部 AI），
// 用于判别 token 口径下的 D>S 差异是"真洞察"还是"风格伪影"（D 的协议要求引用证据 → 答案更长更密）。
//
// 设计：从每臂各取 6 次运行（确定性等距抽样，非择优），取 specific 两例答案 → 共 24 份；
//       匿名化（每例内 12 份随机标号 A1..A12，映射不告知裁判）；裁判按 ground truth 打 0/1；
//       再与 token 口径在**同一 12 份输出**上对比。
import fs from 'node:fs';
import path from 'node:path';

const CC = 'D:\\cc-tasks';
const AR = path.join(CC, 'tasks', '_retry-archive');
const labels = JSON.parse(fs.readFileSync(path.join(CC, 'genexp-labels.json'), 'utf8'));
const specific = labels.cases.filter((c) => c.genericity === 'specific');

const parseAlt = (rp) => {
  const t = fs.readFileSync(rp, 'utf8');
  const a = t.indexOf('GEN-RESULT-BEGIN'); const b = t.indexOf('GEN-RESULT-END');
  if (a < 0 || b < 0 || b < a) return null;
  const out = new Map();
  const parts = t.slice(a, b).split(/CASE\s*(\d+)\s*[:：]/);
  for (let i = 1; i < parts.length; i += 2) {
    const id = Number(parts[i]); const body = parts[i + 1] || '';
    const alt = (body.match(/ALTERNATIVE\s*[:：]\s*([^\n]*)/i) || [, ''])[1].trim();
    const risk = (body.match(/RISK\s*[:：]\s*([^\n]*)/i) || [, ''])[1].trim();
    out.set(id, { alt, risk, text: `${alt} ${risk}`.toLowerCase() });
  }
  return out;
};
const caseHit = (c, got) => !!got && c.tokens.every((toks) => toks.some((tk) => got.text.includes(String(tk).toLowerCase())));

// ---- 抽样（等距，不择优）----
const sRuns = [];
for (let i = 3; i <= 23; i += 4) sRuns.push({ arm: 'S', tag: `r${String(i).padStart(2, '0')}`, dir: path.join(CC, 'tasks', `ccgen-20260916-prop-s-r${String(i).padStart(2, '0')}`) });
const dArch = fs.readdirSync(AR).filter((x) => x.startsWith('ccgen-20260916-prop-d')).sort();
const dRuns = [];
for (let i = 3; i <= 23; i += 4) if (dArch[i]) dRuns.push({ arm: 'D', tag: `ar${i}`, dir: path.join(AR, dArch[i]) });

const runs = [...sRuns, ...dRuns].map((r) => ({ ...r, got: parseAlt(path.join(r.dir, 'out', 'report.md')) })).filter((r) => r.got);
console.log(`  抽样：S ${runs.filter((r) => r.arm === 'S').length} 次、D ${runs.filter((r) => r.arm === 'D').length} 次（等距抽样，非择优）`);

// ---- 匿名化：每例内把 12 份答案洗牌标号 ----
let seed = 20260916;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 0x100000000; };
const blocks = [];
const mapping = [];
for (const c of specific) {
  const items = runs.map((r) => ({ arm: r.arm, tag: r.tag, ...r.got.get(c.id) }));
  const order = items.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
  const lines = order.map((idx, pos) => {
    const lab = `A${pos + 1}`;
    mapping.push({ caseId: c.id, label: lab, arm: items[idx].arm, tag: items[idx].tag });
    return `【案例 ${c.id} · ${lab}】推荐做法：${items[idx].alt}\n    自述风险：${items[idx].risk}`;
  });
  blocks.push(`=== 案例 ${c.id}：${c.title} ===\n【评分基准（该情境下经事件验证的关键洞察）】\n${c.truth}\n\n${lines.join('\n\n')}`);
}

const prompt = `你是独立的方案评审裁判。下面有 2 个工程情境，每个情境下有 12 份**匿名**答案（A1..A12），以及该情境"经事后事件验证过的关键洞察"作为评分基准。

请对**每一份答案**判定它是否抓住了基准中的关键洞察：1=抓住，0=未抓住。
标准从严：只有实质命中才算 1；**措辞不同但语义等价算 1**；泛泛而谈（如"要注意一致性"）算 0；
**答案更长、术语更多、结构更完整，都不构成加分**——只看是否命中基准中的那条关键洞察。

${blocks.join('\n\n')}

【输出格式（严格，每行一条，勿加其它内容）】
CASE 1: A1=0|1, A2=0|1, A3=0|1, A4=0|1, A5=0|1, A6=0|1, A7=0|1, A8=0|1, A9=0|1, A10=0|1, A11=0|1, A12=0|1
CASE 2: A1=0|1, ... （同样 12 项）`;

fs.writeFileSync(path.join(CC, 'judge2-prompt.txt'), prompt, 'utf8');
fs.writeFileSync(path.join(CC, 'judge2-mapping.json'), JSON.stringify(mapping, null, 2), 'utf8');
console.log(`  裁判提示词 ${Buffer.byteLength(prompt, 'utf8')} 字节；匿名映射已存（不告知裁判）`);

const jr = await fetch('http://127.0.0.1:3080/dsh-web-relay/ask', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  // ★ 必传 workspacePath：漏传会让 relay 以宿主 cwd 为基准、在仓库内落盘（今天已因此触发一次重派循环）
  body: JSON.stringify({ provider: 'gemini-free', prompt, workspacePath: 'D:\\dsh relay test', exprId: 'expr-2026-09-13_17-36-07' }),
});
const jj = await jr.json();
if (!jj || !jj.ok) { console.log('  裁判调用失败: ' + JSON.stringify(jj).slice(0, 200)); process.exit(2); }
const txt = String(jj.text || jj.answer || '');
fs.writeFileSync(path.join(CC, 'judge2-output.txt'), txt, 'utf8');
console.log('  providerLabel=' + (jj.providerLabel || '-'));
console.log('--- 裁判原始输出 ---');
txt.split(/\r?\n/).filter((l) => l.trim()).forEach((l) => console.log('  ' + l.slice(0, 200)));

// ---- 解析裁判结果并还原，与 token 口径对比 ----
const verdict = new Map();
for (const m of txt.matchAll(/A(\d+)\s*=\s*([01])/g)) verdict.set(`A${m[1]}`, Number(m[2]));
const byArmJudge = { S: [], D: [] };
for (const mp of mapping) {
  const v = verdict.get(mp.label);
  if (v === undefined) continue;
  byArmJudge[mp.arm].push(v);
}
const byArmToken = { S: [], D: [] };
for (const c of specific) {
  for (const r of runs) {
    const got = r.got.get(c.id);
    byArmToken[r.arm].push(caseHit(c, got) ? 1 : 0);
  }
}
const rate = (a) => (a.length ? (a.reduce((s, x) => s + x, 0) / a.length) : NaN);
console.log('\n=== 同一批输出、两台仪器对比 ===');
console.log(`  token 口径:  S ${(rate(byArmToken.S) * 100).toFixed(0)}%  vs  D ${(rate(byArmToken.D) * 100).toFixed(0)}%   （n=${byArmToken.S.length}/${byArmToken.D.length}）`);
console.log(`  独立盲评:    S ${(rate(byArmJudge.S) * 100).toFixed(0)}%  vs  D ${(rate(byArmJudge.D) * 100).toFixed(0)}%   （n=${byArmJudge.S.length}/${byArmJudge.D.length}）`);
const dTok = rate(byArmToken.D) - rate(byArmToken.S);
const dJud = rate(byArmJudge.D) - rate(byArmJudge.S);
console.log(`  差值: token ${dTok >= 0 ? '+' : ''}${(dTok * 100).toFixed(0)}pp   ｜  盲评 ${dJud >= 0 ? '+' : ''}${(dJud * 100).toFixed(0)}pp`);
console.log(`\n  判读: ${dTok > 0.15 && dJud <= 0.05 ? 'token 的 D>S 优势**未被独立盲评复现** → 很可能是**风格伪影**（答案更长/更密而非更准）'
  : dJud > 0.15 ? '两台仪器方向一致 → D 的优势**不是风格伪影**'
    : '两台仪器均无显著差异 → 未见协议带来的提升'}`);
