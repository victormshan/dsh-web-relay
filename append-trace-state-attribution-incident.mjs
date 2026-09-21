// 记录：诊断模式改写链条归属的事故、修复与加固（2026-09-16 08:00 前后）
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — 事故：诊断模式改写链条归属（我自己的修复不完整），已修复并加固

【如何被发现】重启后我做例行状态核对时，chain-state 出现**自相矛盾**：
\`chainId=v1-v3\` 而 item 是「A4b …」、\`index=1\`、\`completedAt=23:48:18Z\`（即项与进度属 v4-a4b，归属却是 v1-v3）。
若不在触发前发现，08:00 的调度会把状态判为「换链条」→ 重开 → **把已完成的 A4b 重新派发一遍**（重复实现 + 白耗额度）。

【根因：我的修复只做了一半】当天早些时候我为「诊断模式产生状态副作用」加了 \`diagnosticOnly\` 豁免，
但只挡住了「换链条 + 写备份」那一段，末尾那句 \`state.chainId = chain.id\` **仍是无条件执行**。
而诊断路径依然会 save()（\`quotaAvailable()\` 探针成功后清空 \`state.quotaResetsAt\` → \`save()\`），
于是把活跃链条的**归属**改写成了默认链条（不传链条文件时默认 v1-v3）。
触发路径：\`regression-post-restart.mjs\` 内含 \`--probe-only\` 与 \`--selftest-quota\` 两个诊断用例。

【修复】\`cc-chain.mjs\`：\`state.chainId = chain.id\` 改为仅在非诊断模式执行，并把成因与后果写进注释。
【状态修复】\`fix-chain-state-attribution.mjs\`：把 chainId 改回 \`v4-a4b\`（项/index/completedAt 本就是它的，
仅归属被写错）；核对 \`chain-state.v1-v3.json\` 备份完好（chainId=v1-v3 index=5 项数=5，未被覆盖）。

【对照证据（修复可证伪）】
- 修复前：跑 \`--probe-only\` + \`--selftest-quota\` 后 chainId 由 v4-a4b 变为 **v1-v3**（真实观察到的污染）。
- 修复后：同一操作后 chainId 保持 **v4-a4b / index=1**。
- 端到端：08:00:01 触发 → \`链条 v4-a4b 启动，共 1 项，当前 index=1\` → \`链条已于 2026-09-15T23:48:18.505Z 完成，本次跳过\`；
  queue=0、A4b 的 result.json 结束时间仍为 23:48:09Z（**未被重跑**）、锁已释放。

【加固：让守卫真的能抓到】\`regression-post-restart.mjs\` 原先那条「链条探针模式(无副作用)」
只校验退出码与输出关键字，**没校验状态文件**——所以这次污染从它眼皮底下过去了（诊断说谎比不诊断更糟，
L-069 同类）。现新增状态不变式：对 \`--probe-only\` 与 \`--selftest-quota\` 两个用例，
比对执行前后的 \`{chainId, index, completedAt, items 键}\` 签名，不一致即 FAIL 并打印前后签名。
（只比对归属字段、不比对整文件：探针会**合法地**写 \`quotaResetsAt\`。）
加固后套件 14/14，两条用例均输出 \`状态不变=true\`。

【教训（拟入教训库）】「加豁免」不等于「消除副作用」：这次我把副作用拆成了两半（换链条 vs 改写归属），
只豁免了显眼的那一半；而 save() 是散落在多处的，任何一处被触发都会把内存里的改写落盘。
判据应是「诊断模式下**内存状态对象是否被改动**」，而不是「是否走了某个分支」。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
