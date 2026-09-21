// 设计2 预登记落盘（脚本文件形式——不再用内联 node -e，今天已被 shell 吃掉太多次中文引号）
//
// ⚠ 写本类脚本时的硬规则：**body 是模板字符串，正文里不得出现反引号**（会截断模板导致 SyntaxError）。
//    需要引用代码时用「」或双引号。这个坑今天已犯三次（genexp2 生成器、本文件），故写死在文件头。
import fs from 'node:fs';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const now = new Date().toISOString();

const body = `
## [主 agent] ${now} — 设计2 预登记（散文反证 P vs 可执行反例 E；判定者 = 执行探针）

【问题（与前两轮**不同**，务必分清）】前两轮问的是「哪一臂的**方案文本**更贴近关键洞察」→ 需要模型裁判 → 遭遇风格混杂与自偏好。
本轮问的是「在必须交出**可执行修复**的任务里，要求反证方提交**可执行反例**，是否比要求其写**散文批判**产出更好的修复」。
**判定由隐藏探针执行给出：无模型裁判、无风格通道、无自偏好**——这是评估端最干净的形式，也正好回应外部 AI 探讨里
「若协商无效就把算力转向 Execution-Guided」的判决。

【语料：3 个自包含带 bug 模块，各自对应本会话一次真实事故】
  1) collectChanged —— 未跟踪目录被当作文件读取 → EISDIR 崩溃（而调用方只看退出码，于是把"工具崩溃"读成"判定不合格"）
  2) loadChainState —— 无条件覆盖 chainId → 换链条后继承旧 completedAt/index → 新链条永不派发
  3) decideRedispatch —— 可重派集合无次数上限 → 持续失败时每 20 分钟重派、无限循环（实测 25 次 / 约 87 分钟）

【仪器自检（先做；未通过则不花 cc 任务）】probes/selftest-probes.mjs：
  要求三个探针对 **bug 版判 FAIL**、对**我写的参考修复判 PASS** → 实测 **3/3 区分力通过**。
  ★ 该自检当场抓出**我参考修复里的一个真 bug**：「line.trim().slice(3)」会删掉 porcelain 状态列的前导空格、
    切进文件名（只有"普通修改"一例暴露，未跟踪案例侥幸通过）→ 已改为**不先 trim 整行**。
    **若省略这一步，这个错会污染整轮实验的判定基线。**

【预登记（此刻尚未跑任何一轮）】
  H1：E 组隐藏探针通过率 > P 组；H0：无差异。
  主指标：**探针通过率**（每臂 8 轮 × 3 案例 = 24 次），判定由**执行**给出。
  次指标：E 组 NO_REPRO 出现次数（机制遵守度）；两臂报告字节数（风格对照）。
  判定规则：**仅当 E 通过率 > P 且置换检验 p<0.05 才判 E 更优**；否则判"无可检出差异"。规则此刻固定。

【不变量（verify-exec-specs.mjs，14/14 通过）】16 份语法通过；同臂各轮 prompt 逐字节相同；
  两臂共通前缀含三案例源码；E 协议含"可执行复现脚本"要求而 P 协议不含（散文）；两臂均要求保持导出名与写 done.flag；
  ground truth 与修复手法（uall / EISDIR / statSync / isFile / failCount）**未泄漏**进任何一臂；
  链条 16 项、spec 齐全、taskId 唯一、交错排列（P,E,P,E…）。
  （过程中一条 FAIL 是**我的检查词选错**：把案例 1 bug 源码里的 readFileSync 当成了泄漏 → 已修正。）

【装填】链条 v8-exec，用 arm-chain.mjs **指针式**装载（不再手改 run-chain.cmd）。
`;

fs.appendFileSync(trace, body, 'utf8');
console.log('  追加字节 =', Buffer.byteLength(body, 'utf8'), '| 轨迹现字节 =', fs.statSync(trace).size);
