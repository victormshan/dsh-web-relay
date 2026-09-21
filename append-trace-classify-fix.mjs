// 记录：分类器回退修复的验收结论 + 主 agent 一次假失败的自我更正
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — 失败分类回退修复验收（ACCEPT）+ 一次假失败的自我更正

【任务与无人值守】链条 v5-classify 于 08:20:01 自动触发（\`链条 v5-classify 启动，共 1 项，当前 index=0\`，
换链条状态隔离生效）→ 08:31 结算 done → 提交 347ac69（lib/cc-stats.mjs +85 / test/cc-stats.test.mjs +133）。
这是本会话**第三次**无人值守派发成功。

【机械验收】verify-cc-task = ACCEPT（7/7）：2 文件全在声明范围、无 BOM/CRLF、全量 629/629、
*.test.js 子集 456/456、verify-files-coverage OK。

【语义验收：走生产代码路径的权威回放 = 11/11】
用 lib/cc-stats.mjs 的 loadChainTaskResults + summarizeChainTasks 直接跑 D:\\cc-tasks 真实数据：
  total=37 ok=26 failed=6 markerMissing=5 successRate=0.7027
  byFailure={cc-quota-exhausted:2, cc-timeout:2, runner-failed:2}
与 spec 验收 ③ 写下的预期**逐项一致**：unknown 3→0、泛化 timeout 1→0（并入 cc-timeout=2）、
failed 10→6、markerMissing 1→5。即 **5 条此前被判「失败」的任务被正确识别为「产物可能完好、仅缺完成标记」**；
其中 ccfix-20260915-autoiteraudit（errorCode=cc-failed 但 reason 为 exit=0 + done.flag=missing）
落进 markerMissing，证明「调用点合并 errorCode 与 reason」这条要求确实落地了
（修前该行因 errorCode 非空而 reason 根本不被查看）。

【❗ 主 agent 的假失败与更正（必须留痕）】
我第一轮判定「验收不通过」，依据是自己的分析脚本 analyze-cc-channel.mjs 跑出 failed=10/markerMissing=1，
并据此指控 cc 未落实「合并 reason」且新增了分桶矛盾。**该指控是错的**：
- 真因：那个脚本**自己复刻了调用方的旧分类逻辑**（classifyCcFailure(errorCode || reason)），
  并未走修复后的代码路径；被验证的逻辑一改，复刻版立刻过期并开始说谎。
- 证伪过程：改用生产函数直接回放 → 数字与 cc 报告完全一致。
- 同类前科：本会话已出现第二次「验证器本身有问题」（前一次是自检契约切片守卫对变异仍全绿）。
  这正是 L-069「诊断说谎比不诊断更糟」的又一实例。
- 处置：analyze-cc-channel.mjs 已重写为**直接调用生产函数**，并在文件头写明这次教训，
  使其不可能再与生产逻辑漂移。另修正了权威回放脚本里我自己的另一处错断言
  （total 是窗口过滤后的计数，不该等于读盘总数 —— 37 vs 47 的差正是 10 条窗口外记录）。

【修正后的通道口径（与早先分析相比更准确）】
- 通道自身失败率 = 4/37 = **10.8%**（与早先估计的 ~11% 一致）
- 「额度内、且不含缺标记」成功率 = 26/30 = **86.7%**（早先只能给「约 88%」的估计，现为实测）
- 早先「raw 69.4% 会被误读」的判断，现在有了修好分类器后的对照支撑。

【未生效提示】修复只在仓库（已提交/推送），**运行时 /health-check 仍是旧规则**
（实测 byFailure 仍为 {unknown:3, timeout:1, runner-failed:3, cc-timeout:1, quota:2}）——
需 deliver-three-copies + 重启宿主才对运行时生效。该项待用户决定。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
