// 记录：verify-cc-task 只读任务缺陷修复 + 生成类实验 S 组初步结果与匹配器局限
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — 工具缺陷修复（verify-cc-task 只读任务被误拒）+ 生成类实验 S 组初步结果

【工具缺陷（我的，非 cc 的问题）】v6-gen 的 S 组于 10:20 派发、10:23 结算：result.json status=**done**、
exit=0、done.flag 已写（说明生成类 spec 补的 done.flag 指令生效），**但链条判它 verify-rejected 并停止 → D 未派发**。
回源 verify-cc-task.mjs：写入范围检查把「零改动」一律判 FAIL（"无法归属改动"），
而**只读分析任务**（kind=understand、prompt 未声明任何 /mnt/d/dsh-web-relay/<文件> 路径）本来就应当零改动。
即该工具**假设每个 cc 任务都会产出仓库改动或提交**，无法表达"只读任务"这一合法形态。
- 影响面：v6-gen S、v6-ab A/B 三组都被此缺陷误拒（此前我只把 A/B 归因于 done.flag 缺失，未识别这一层）。
- 修复：把判定抽成纯函数 decideScope({declaredCount, changed, allowed})，语义区分
  ①声明 0 且改动 0 → **符合预期（只读任务）PASS**；②声明 0 却有改动 → 越界 FAIL（**守卫未被放宽**）；
  ③声明>0 而改动 0 → 缺产物 FAIL；④声明>0 且有改动 → 逐个核对范围。
- 验证：新增 --selftest-scope **5/5 通过**，其中第 2、5 例正是"没声明却改了文件""改动越界"必须 FAIL；
  重验 S 组 → **ACCEPT 7/7**。修复不是把门放宽，而是把"零改动"在两种语义下区分开。
- 处置：S 产物有效故不重跑（避免丢弃已完成数据），另建 v6-gen-d（仅 D 组）装填，10:40 触发。

【生成类实验 S 组初步结果（token 指标，预登记口径）】
  specific 1/2 ｜ 全例 3/4 ｜ 解析缺失 0 ｜ done.flag=true
  案例1 specific ✓✓ ｜ 案例2 specific ✗（组1 ✗ / 组2 ✓）｜ 案例3 mid ✓✓ ｜ 案例4 generic ✓✓

【必须记录的两点局限】
1. **疑似匹配器假阴性**：案例 2 的实际 ALTERNATIVE 为「给诊断模式一条独立的函数级代码路径
   （在任何写状态的调用之前 return），不是在共享初始化函数内用 if 分支跳过某几步副作用」——
   语义上正对应 ground truth 的"不能靠加豁免分支"，但未命中我预登记的组 1 token。
   **处置：不调 token**（见到结果后改判据是我自己方法论明令禁止的）。主判定仍用预登记 token 指标；
   人工阅读作为**事后敏感性分析**单独标注。方向性提示：若该例实为命中，则 S specific = 2/2，
   **D 更不可能超过 → 负结果只会更强**。
2. **混淆控制得到实证**：案例 4（generic「大任务要拆」）S **未用任何特殊协议即答对**
   （组1 组2 全中）。这直接证明把 generic 排除出主指标是必要的——否则 S 看起来 4/4，
   任何协议改进都会被掩盖。这条为「通用建议会吹高效应」的担忧提供了本系统内的实测支持。

【D 组】已装填 v6-gen-d，10:40 触发；观察器 pwsh-4（窗口至 11:17）。评分器在只有一组时
**拒绝给结论**（已实测）——避免半组数据被读成实验结论。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
