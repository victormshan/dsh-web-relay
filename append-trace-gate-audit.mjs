// 记录：执行接地门禁 ③（门禁自审 meta-gate）完成并验证
// ⚠ 本文件 body 是模板字符串：**正文不得出现反引号**（用「」代替），否则会截断模板报 SyntaxError。
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — 执行接地门禁 ③ 落地：门禁自审 meta-gate（给门禁装门禁）

【动机：本会话最贵的教训是"说谎的验证器"】三次假守卫：
  ① 自检契约切片守卫：对源码做变异后**仍然全绿**（假守卫）；
  ② 通用 parity 脚本：把协议标题写死，换一组 spec 就误报 FAIL；
  ③ 设计2 探针：只有"坏输入必须失败"一侧 → **误杀我的正确参考修复**（补上"好输入必须通过"一侧才暴露）。
故 meta-gate 立三条硬规则：
  **规则 A（双侧自检）**：每个门禁自检必须**同时**出现 [NEG] 与 [POS] 标记。
    只证明"能失败"会误杀正确输入；只证明"能通过"就是永真门禁。
  **规则 B（变异负控）**：对以文件为输入的门禁，meta-gate **真把目标改坏**再跑，要求门禁报失败。
  **规则 C（持续执行）**：每个门禁必须被 regression-post-restart.mjs 引用，否则它不会被自动执行。

【落地内容】
  · verify-gates.mjs：按上述三规则审计 6 个门禁 + 2 个真实变异负控；并携带 **--selftest（meta-gate 自身两侧自检）**。
  · 为 5 个门禁的自检加双侧标记（arm-chain / verify-cc-task / verify-acceptance-wiring / cc-chain L410 / accept-smoke），
    并把 selftest-probes 的输出也标记为 [NEG]/[POS]。
  · verify-run-chain-cmd.mjs 新增 --path 注入（使"把 run-chain.cmd 改坏"这个负控可执行）。
  · 回归套件由 19 项扩到 **21/21**（新增"设计2 探针两侧区分力""门禁自审自检(meta)"）。

【结果】verify-gates.mjs **PASS（8 项）**：
  规则 A：6/6（链条装载器校验、改动范围判定、验收接线四类契约、项终态判定 L410、验收探针负控、设计2 探针两侧区分力）
  规则 B：2/2（调度器入口注入非 ASCII 字节 → 门禁报失败；规格锚点改成不存在 pattern → check-spec 报失败）
  规则 C：6/6 均已被回归套件引用
  meta-gate 自身 --selftest：4/4（放行合法输出；拦下缺 [NEG]、缺 [POS]、自检退出码非 0 三类坏输出）

【★ 过程中被自己的审计抓到的两个问题（都当场修）】
  1) **WORK 解析错误**：初版用 new URL(import.meta.url).pathname → 得到 URL 编码路径 D:\\dsh%20relay%20test →
     所有子进程 cwd 失效、ENOENT 被伪装成"门禁失败"。改用 fileURLToPath + path.dirname。
  2) **负控空转**：初版拿 cc-specs/v1-1.mjs 去改锚点，但**该文件根本没有 anchors**（是 anchors 约定之前的老规格）
     → apply() 是空操作 → "门禁没报失败"只说明负控是空的。**已加断言：变异必须真的改变内容，
     否则单列为 FAIL（"该负控空转，等同于假门禁"）**。这条断言本身正是规则 B 的精神。

【卫生与隔离】变异只发生在系统临时副本上：实测 run-chain.cmd 非 ASCII 字节仍为 0、指针仍指 v8-exec、工作区无临时残留。

【下一步（尚未做）】④ verify-chain-run.mjs（链条运行后不变量断言 + 每周期护栏触发统计，让"25 次重派"那类问题
  不再靠运气发现）；⑤ 交付接地（断言宿主确实加载了新代码 + 在 /health-check 暴露已加载 commit sha）；
  ⑥ verify-claims.mjs（报告里的实测数字可复跑）。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
