// 修正 L-2026-0915-069：先前写成「cc 自述不可复现」，实测应为「跨环境复跑得到的不是否证，
// 而是另一个事实」——cc 在 WSL 跑（3 个 shadow-gate 失败确凿可复现），主 agent 在 Windows 跑（全绿）。
import fs from 'node:fs';

const FILE = 'D:\\dsh-web-relay\\docs\\main-agent-lessons.json';
const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const l = doc.lessons.find((x) => x.id === 'L-2026-0915-069');
if (!l) throw new Error('未找到 L-2026-0915-069');

l.title = '执行体的自述必须**在同环境**复跑才能采信——cc 报的「3 个既有失败」在 WSL 精确成立、在 Windows 不成立（同一提交、同一测试计数），跨环境复跑不是否证';
l.decision = '① 采信/否证执行体的失败自述前，先确认**它是在哪个环境跑的**：本项目的 cc（headless claude）在 **WSL**（/mnt/d/dsh-web-relay）跑测试，而主 agent 的验收器在 **Windows** 跑——两侧环境不同，失败清单不可直接互证；② 因此「在 Windows 复跑全绿」**不能**用来否定「WSL 有 3 个失败」，二者是**两个事实**，应同时记录并说明成因；③ 判据应是「失败清单是否与自述一致」（本次完全一致：同为 test/shadow-gate.test.js 的 3 项）＋「本次改动文件是否可能影响这些用例」（本次 4 个改动文件均不涉及 shadow-gate → 逻辑上不可能由本次引入）；④ 写 cc 规格时，**不要**把「全量测试 0 失败」写成硬性验收条——cc 在 WSL 永远有这 3 项失败，该条款不可满足，会诱导 cc 反复做 git stash 自证（已发生 2 次）甚至去「修」一个并不存在的缺陷；正确写法是「排除 test/shadow-gate.test.js 后 0 失败，并注明 Windows 侧全量口径由主 agent 验收」。';
l.rationale = '跨环境复跑得到的是**另一个事实**，不是对原事实的否证。混淆二者会两头出错：要么采信了本环境其实为红的结论，要么——像本条最初被误写的那样——把**准确的自述**否证掉，既不公允，也会让后续判断失去一条可信的信号源。环境差异本身是必须写进结论的**事实成分**，而不是可以互相抵消的噪声。';
l.evidence = '2026-09-15 两次 cc 任务（ccfix-20260915-swarmparse、ccfix-20260915-autoiteraudit）均自述「3 个失败为 shadow-gate.test.js 既有环境问题，已用 git stash 证明改动前后一致」。主 agent 实测两环境：**WSL** `node --test --test-reporter=tap test/*.test.js` → 390 例、3 失败，精确为 test/shadow-gate.test.js 的 `not ok 308 TC-Green: repoPath 识别 + L1 语法预检`、`not ok 311 TC-GC: Shadow GC`、`not ok 314 getGitHead`（与 cc 自述**完全一致**）；**Windows** 同口径 `node verify-cc-task.mjs ...` → *.test.js 子集 **390/390 通过**、全量 **530/530 通过**、0 失败。两侧测试计数相同（390）而失败数不同（3 vs 0）→ 差异来自环境（WSL drvfs/`/mnt/d` 上的 git 行为）而非代码。本条最初被主 agent 误写为「3 个失败不可复现、cc 自述不成立」，经 WSL 复跑后**自我更正**为「同环境可复现，跨环境不可互证」。';

fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log('[lessons] 已更正 L-2026-0915-069（标题/decision/rationale/evidence）');
console.log('[lessons] 新标题: ' + l.title);
