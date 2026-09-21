// 记录：重派循环事故的根因链、修复与 25 次复核结论
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — 事故：我自己触发的 25 次重派循环（根因链 + 四处修复），及 D 组 25 次复核结论

【现象】12:00–20:00 之间，链条每 20 分钟重派 D 组一次，**共 25 次**；每次 result 都是 status=done / exit=0、
报告完整（25/25 可解析），但**每次 \`验收: REJECT\`** → clearStaleAttempt 归档 → 下个触发重派，无终止条件。
代价：约 **87 分钟** cc 执行时间与相应配额。**未造成代码损坏**（产物完整、仓库无改动）。

【根因链：三个缺陷叠加，全部在我这边】
1. **触发源**：为生成类实验做独立盲评时调 \`/ask\`，**重试那次漏传 workspacePath** →
   relay 以宿主 cwd（D:\\dsh-web-relay\\bin）为基准落盘 → 在仓库内生成 \`bin/web-relay/{experiments,traces}/\`
   （内容即我那次盲评的记录，时间戳 02:45:54Z 与调用时刻吻合）。
2. **未被忽略**：.gitignore 原为 \`web-relay/experiments/\`——**含中间斜杠的模式锚定仓库根**，
   故 \`bin/web-relay/\` 不被忽略 → \`git status\` 报 \`?? bin/web-relay/\`。
3. **击穿验收器（崩溃级）**：verify-cc-task 用**默认模式**的 \`git status --porcelain\`，
   它把未跟踪目录**聚合为目录项**；编码卫生检查对该项 readFileSync → **EISDIR 抛错** → 验收器崩溃 →
   非零退出被链条读成 REJECT。（这也解释了为何 S 组在修复后是 ACCEPT 7/7 而 D 组每轮都 REJECT：
   D 组开始跑时污染目录已经存在。）
4. **放大成循环**：\`verify-rejected\` 在 clearStaleAttempt 的可重派列表里（本意"修好后可重跑"），
   与周期性触发叠加 → 持久性失败 → **无限重派**，且当时**没有任何重派计数上限**。

【四处修复（均已验证）】
- verify-cc-task 改用 \`git status --porcelain -uall\`（逐个列出未跟踪文件，不聚合目录）；
- 编码卫生检查加 isFile() 防御，跳过非文件项；崩溃复现用例现能给出正常判定而非抛错；
- **cc-chain.mjs 新增重派护栏**：同一项连续失败达 DSH_CC_MAX_ITEM_ATTEMPTS（默认 3）→
  置 \`paused-too-many-attempts\` 并 exit 4 停下等人（verify-rejected 路径已开始累加 failCount）；
- .gitignore 改为 \`**/web-relay/experiments/\`、\`**/web-relay/traces/\`（任意层级生效），
  并把仓库污染目录清出（归档至 D:\\cc-tasks\\_repo-pollution-archive\\），仓库恢复干净；
  提交 c51d9df 已推送（347ac69..c51d9df）。

【调度器当前状态】**已由我暂停**（run-chain.cmd 改为 no-op，备份 run-chain.cmd.v6-gen-d.bak）。
理由：armed 的调度器指向"项处于失败态"的链条正是本次循环成因；重新武装应绑定**新链条（新 chainId）**，
而不是修补旧链后继续跑。

【意外收获：D 组 25 次独立复核（用户要求的"复核"以更大样本形式达成）】
按与 S 组**同一套**（预登记、已知有偏）token 口径全量评分：
  案例1 命中 14/25 ｜ 案例2 命中 14/25 ｜ specific 命中均值 **1.12/2**（S 单次 = 1/2）
  得 0/2 的次数 **6/25** ｜ 两例同时命中 9/25
→ **run-1（被配额终止、得 0/2）属代表性样本**：有 6/25 次同为 0/2，其值落在分布内。
   故"打平"的判断**不依赖单次抽样**；且 **D 组内部变异性（0–2）远大于两臂之间的差异**。
→ 仍需承认：S 组 n=1，无法做分布比较（复核**没能**补上这一半）；token 指标有系统性假阴性。
   故复核支持"未见显著提升"，但**不能**给出效应量。

【方法学教训（已写入报告 §9.3）】
① "可重派"必须有次数上限——retry-on-failure 与周期性触发组合若无终止条件，持久性失败会自动升级为资源泄漏；
② 验收器崩溃与"判定不合格"在调用方无法区分（都是非零退出）→ 崩溃应输出可区分信号；
③ 忽略规则要防"就地生成"：只锚定仓库根的数据目录规则会被"以别的 cwd 运行"的组件击穿；
④ 自己的调用也要传全参数——一个可省略参数（workspacePath）导致的仓库污染，最终演变成 25 次重派。

【交付物】D:\\dsh relay test\\_EXPERIMENTS-2026-09-16.md 已增补 §9（复核 + 事故 + 教训），
证据索引补入 25 次复核明细与独立盲评文件。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
