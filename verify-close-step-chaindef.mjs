// 验证 protocol-close-step.mjs 的链条定义解耦（真实执行路径，不光看源码）
//
// 为什么要桩：7 步全 approved 时，收口器在 L90 就 noop 退出，**永远走不到链条定义那行**。
// 所以要构造一个「非 approved 且属于新链条」的步骤，才能证明：
//   修复前（硬编码 v1-v3）→ defItem=null → L122「链条项无记录则拒绝收口」被**静默绕过**（危险）
//   修复后（解析新定义）  → defItem 命中 → 守卫**真正生效**（exit 3 / no-chain-record）
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const WORK = 'D:\\dsh relay test';
const SRC = path.join(WORK, 'protocol-close-step.mjs');
const src = fs.readFileSync(SRC, 'utf8');
const tmp = [];
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  ok ? pass++ : fail++;
};

// ---- 桩服务器：只回答 GET /steps 与两个 POST，不做任何真实状态变更 ----
const stub = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url.startsWith('/dsh-web-relay/steps')) {
    return send(200, { currentStep: '8', steps: [{ id: '8', status: 'executing', title: 'stub 新链条步骤', reviewedBy: null }] });
  }
  if (req.method === 'POST' && req.url.startsWith('/dsh-web-relay/steps/update')) return send(200, { ok: true });
  if (req.method === 'POST' && req.url.startsWith('/dsh-web-relay/steps/auto-review')) {
    return send(200, { stepState: { steps: [{ id: '8', status: 'executing', reviewedBy: null }] } });
  }
  return send(404, { error: 'stub: no route', url: req.url });
});

await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const port = stub.address().port;
const BASE = `http://127.0.0.1:${port}/dsh-web-relay`;

// 临时新链条定义：含 planStepId '8'（v1-v3 里没有）
const stubDefName = '_stub-v4.mjs';
const stubDefPath = path.join(WORK, 'cc-chains', stubDefName);
fs.writeFileSync(stubDefPath, `export const chain = { id: 'stub-v4', items: [\n  { label: 'A4a 编码通道统计（桩）', planStepId: '8', spec: 'cc-specs/feat-chain-stats-a.mjs', taskId: 'stub-task-from-def' },\n] };\n`, 'utf8');
tmp.push(stubDefPath);

// 收口器副本：BASE 指向桩。chain-def-resolve.mjs 用相对路径 import，副本放 WORK 根即可解析。
const copyPath = path.join(WORK, '_stub-close-step.mjs');
const fixedSrc = src.replace("const BASE = 'http://127.0.0.1:3080/dsh-web-relay';", `const BASE = '${BASE}';`);
if (fixedSrc === src) throw new Error('未能改写 BASE —— 源文件该行已变，验证脚本需同步');
fs.writeFileSync(copyPath, fixedSrc, 'utf8');
tmp.push(copyPath);

// 修复前副本：把解耦那行换回硬编码，作为 before 对照
const preFixPath = path.join(WORK, '_stub-close-step-prefix.mjs');
const preFixSrc = fixedSrc.replace(
  /const chainDefPath = loadChainDefPath\(\{ work: WORK \}\);/,
  "const chainDefPath = path.join(WORK, 'cc-chains', 'v1-v3.mjs');",
);
if (preFixSrc === fixedSrc) throw new Error('未能还原硬编码 —— 解耦那行已变，验证脚本需同步');
fs.writeFileSync(preFixPath, preFixSrc, 'utf8');
tmp.push(preFixPath);

// 必须用异步 spawn：桩服务器与本验证脚本同进程，spawnSync 会阻塞事件循环 → 子进程请求无人应答 → 死锁。
function run(file, { env = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file, '8', '--dry-run'], {
      cwd: WORK,
      env: { ...process.env, DSH_CC_CHAIN_DEF: '', ...env },
    });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; p.kill(); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: killed ? 'timeout' : code,
        defLine: (out.match(/链条定义: (.*)/) || [, '(无)'])[1].trim(),
        // 守卫的可读输出是「在 chain-state 中无记录」；'no-chain-record' 只在 --json 载荷里（未传 --json）
        guardFired: /在 chain-state 中无记录|no-chain-record/.test(err) || /在 chain-state 中无记录|no-chain-record/.test(out),
        out, err,
      });
    });
  });
}

console.log('=== ① 修复后 + 新链条定义（env 指定）→ 守卫必须生效 ===');
const A = await run(copyPath, { env: { DSH_CC_CHAIN_DEF: stubDefPath } });
check('链条定义解析到新定义（而非 v1-v3）', A.defLine === stubDefPath, `实际=${A.defLine}`);
check('拒绝收口 exit=3 且命中「在 chain-state 中无记录」守卫', A.code === 3 && A.guardFired, `exit=${A.code} guardFired=${A.guardFired} err=${A.err.trim().slice(0, 160)}`);

console.log('=== ② 修复前（硬编码 v1-v3）+ 同样场景 → 守卫被静默绕过（对照）===');
const B = await run(preFixPath, { env: { DSH_CC_CHAIN_DEF: stubDefPath } });
check('修复前解析到 v1-v3（忽略 env）', B.defLine.endsWith('v1-v3.mjs'), `实际=${B.defLine}`);
check('修复前**未**拒绝收口（证明这是真实缺陷）', B.code !== 3 && !B.guardFired, `exit=${B.code}（期望 ≠3）`);

console.log('=== ③ 修复后 + 不设 env（调度器仍指 v1-v3）→ 保持既有行为不回归 ===');
const C = await run(copyPath, {});
check('解析回退到 v1-v3（与改造前一致）', C.defLine.endsWith('v1-v3.mjs'), `实际=${C.defLine}`);
check('v1-v3 无 step 8 → defItem 为空 → 不误报「无记录」', !C.guardFired && C.code !== 3, `exit=${C.code}`);

console.log('=== ④ before/after 差异结论 ===');
check('同一场景下修复改变了行为（A 拒绝 / B 放行）', A.code === 3 && B.code !== 3, `A=${A.code} B=${B.code}`);

stub.close();
for (const f of tmp) { try { fs.unlinkSync(f); } catch { /* 已删 */ } }
console.log(`\nRESULT: ${pass}/${pass + fail} 通过${fail ? `（${fail} 失败）` : ''}`);
process.exit(fail ? 1 : 0);
