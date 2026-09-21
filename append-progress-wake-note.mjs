// 记录「推进到 Step 2」的唤醒处置与额度门控（node 写 UTF-8）
import fs from 'node:fs';

const p = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();
const lines = [
  '',
  `## [主 agent] ${now}`,
  '',
  '【推进唤醒处置：Step 1 已通过（Swarm 双角色盲审）→ 请执行 Step 2】',
  '本唤醒为**合法推进唤醒**（非陈旧）：step 1 = approved/reviewedBy=external，notes 完整，提交 4d43ea1 在案。',
  'Step 2（V1-2）的代码工作受**外部额度约束**，处置如下：',
  '- 实测额度：`You\'ve hit your session limit · resets 3:20am`；V1-2 已由链条试派一次并以 errorCode=cc-quota-exhausted 失败（tasks/v1-2-autoiter-decl-integrity/result.json）。',
  '- 链条状态：index=1，V1-2=quota-paused；计划任务 dsh-cc-chain-v1v3-b 每 20 分钟触发（Next Run 00:40，窗口至 08:20）→ 额度恢复后自动：clearStaleAttempt 归档残留 → 重派 → 验收 → 提交 → 续跑。',
  '- 因此**不在当前窗口手动派发**（必然再次耗尽，只会再产生一条 quota-exhausted 记录）。',
  '- 协议动作时序决策：Step 2 的 /steps/update start→complete→auto-review **在代码落地后一次性执行**（与 Step 1 相同做法）——避免现在 start 又产生一条孤儿唤醒（本次前面刚处置过一次 start 唤醒的乱序投递）。',
  '',
  '【规格补强（本轮实测获得）】V1-2 注入点覆盖范围已实测确认：/ask 的 gemini-free 分支把**同一个 guidedPrompt**',
  '传给全部降级节点——callGemini(L2102)、webGeminiAsk(L2106/L2117)、callDialogModel(L2110/L2121)，',
  '故注入 L2086-2096 一处即覆盖 external→web-gemini→dialog 整条链；另有独立 provider=web-gemini 分支（L2128+，guidedPrompt 组装见 L2132-2135）可作第二注入点。',
  '该事实已写入 cc-specs/v1-2.mjs 的注入点要求，使验收口径精确（链条按 spec 现场构建，改完即对下次派发生效）。',
  '',
];
const body = lines.join('\n');
fs.appendFileSync(p, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(p).size);
