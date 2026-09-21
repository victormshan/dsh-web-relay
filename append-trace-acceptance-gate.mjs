// 记录：执行接地门禁 ①②（acceptanceScript 接线 + 装填门禁）已完成并验证
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — 执行接地门禁 ①② 落地：acceptanceScript 断线接通 + 装填门禁

【起点是一个实测发现：钩子早已存在，但线是断的】
  cc-dispatch.mjs L4 声明了 spec 字段 acceptanceScript、L50 把它写进 task.json；check-spec L279 与
  stage-deferred L29 也在透传——但 **verify-cc-task / cc-chain / runner.sh 全都不读它**。
  即管线一路带着"该怎么执行验收"，然后没有任何消费方运行它。所以第一步不是设计新机制，而是**接通断线**。

【① 接线（verify-cc-task.mjs）】
  · 新增第 7 项验收「验收脚本」：优先用 --acceptance，否则读 task.json 里的 acceptanceScript；
    在**任务产物**上执行探针（注入 DSH_TASK_ID/DSH_TASK_DIR/DSH_REPO）。
  · **退出码契约（本项最关键）**：探针 exit 0 → PASS；exit 1 → FAIL（**业务判定**）；
    探针缺失/超时/异常退出 → **INSTRUMENT-ERROR，验收器以 exit 3 结束**，绝不伪装成"产物不合格"。
  · 未声明 acceptanceScript 的任务打印 **[SKIP]**（可见），不计入 ACCEPT/REJECT——静默跳过的检查等于没有检查。
  · 整段包 try/catch：任何意外异常降级为 exit 3。
  · cc-chain.mjs 相应区分：**exit 3 → 项状态 probe-broken、停止链条(exit 5)、不计 failCount、不重派**
    （工具坏了重派只会重复烧额度——这正是 2026-09-16 那次 25 次重派循环的成因）。

【② 装填门禁（arm-chain.mjs）】
  · 逐项跑 check-spec，任一不过 → **拒绝装填**（防的是本轮三次"带着坏规格装填"：语料反引号致生成物语法错、
    假锚点、引用不存在的测试文件）。
  · 若规格声明了 acceptanceScript，则该探针**必须自带负控**：node <probe> --selftest 必须通过——
    即它必须证明自己**在坏输入上会失败**。没有负控的探针 = 可能永真的门禁（本会话已出现三次"假守卫"）。
  · 若整条链条没有任何执行接地验收 → 打印明确告警（这类任务只能靠人工/模型阅读判定，而三轮实验显示该路径无法给出干净判定）。

【验证（不是只看代码）】verify-acceptance-wiring.mjs —— 四类契约 + 正向装填 + 卫生，**14/14 通过**：
  A 探针通过 → exit 0 且打印 [PASS] 验收脚本
  B 探针缺失 → **exit 3**、输出含 INSTRUMENT-ERROR、且**不得**出现 ACCEPT/REJECT 字样
  C 负控失败的探针 → arm-chain 拒绝装填（exit 1）、**指针未被改写**
  D 探针判不合格 → exit 1（REJECT），与 B 的 exit 3 明确区分
  E 合法探针 → 允许装填，并报告"执行接地验收：N 项"，测试后指针还原
  F 测试自身不留临时产物（此前 selftest-probes 把 _buggy*/_fixed* 写进 probes/ 且不清理，已改为系统临时目录）
  另新增可复用探针 probes/accept-smoke.mjs（自带负控：不存在的任务必须判失败）。

【★ 接线过程中我自己制造并当场修掉的同类事故】第一版接线引用了 verify-cc-task.mjs 里**不存在的常量 WORK**
  → ReferenceError → 进程崩溃退出 1 → **被调用方读成"判定不合格"**。这正是本轮要治的病（工具崩溃≠业务判定），
  而且是被我自己的接线测试（A/B/D 三项同时失败）抓出来的。两处修正：用脚本自身目录解析工作区（不硬编码）；
  把验收块整体 try/catch 降级为 exit 3。

【回归】regression-post-restart.mjs 由 17 项扩到 **19/19 通过**（新增"验收接线四类契约""验收探针负控自检"）；
  受影响的既有工具均无回归（verify-cc-task 对未声明探针的任务仍 ACCEPT 7/7 且显示 SKIP；
  cc-chain 的 final-status 自测 5/5；arm-chain 校验器自测 7/7）。工作区无临时产物残留。

【下一步（尚未做，按优先级）】③ 门禁自审 meta-gate（枚举所有 verify-*/--selftest，要求每个至少含一个负控）；
  ④ verify-chain-run.mjs（链条运行后的不变量断言 + 每周期护栏触发统计，防 25 次重派那类问题靠运气发现）；
  ⑤ 交付接地（断言宿主确实加载了新代码 + 在 /health-check 暴露已加载 commit sha）；
  ⑥ verify-claims.mjs（报告里的实测数字可复跑）。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
