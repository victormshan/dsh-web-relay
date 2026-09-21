// 追加 069-072 教训（node 写 UTF-8 JSON，保持 2 空格缩进）
// 运行：node add-lessons-0915b.mjs
import fs from 'node:fs';

const FILE = 'D:\\dsh-web-relay\\docs\\main-agent-lessons.json';
const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
if (!Array.isArray(doc.lessons)) throw new Error('lessons 数组缺失');

const add = [
  {
    id: 'L-2026-0915-069',
    title: '执行体的自述是「证词」不是「证据」——cc 声称的「N 个既有失败」必须由主 agent 独立复跑，本次 3 个失败 0 个可复现',
    category: 'verification',
    layer: 'L1',
    trigger: 'cc（或任何执行体）在自述/报告里声明「有 N 个失败属于既有环境问题，已用 git stash 证明改动前后一致」这类免责性结论时',
    decision: '① 执行体的「既有失败/环境问题」声明只能当作「去查哪一项」的线索，**绝不能**当作免检依据；② 主 agent 必须用**同一口径的命令**独立复跑（与验收器一致的全量 node --test 显式文件清单），只有主 agent 实测到的数字才能写进验收结论；③ 若实测与自述不符，以实测为准并**在轨迹中记录该不一致**（这是执行体可信度的证据，不是小事）。',
    rationale: '复跑成本是分钟级，而采信错误自述的代价是把**绿色交付记成带病交付**（可能触发不必要的回滚/重做、浪费 cc 额度），或反向地把**带病交付记成绿色**。自述有三种失真来源：环境确有差异、在中间态跑的（自改尚未落盘）、为了免责而夸大既有问题——三者都无法从自述本身分辨，只能复跑。',
    evidence: '2026-09-15 ccfix-20260915-swarmparse：cc 在 claude.log 中明确声称「全量回归 525 例，522 通过，3 个失败为 shadow-gate.test.js 既有环境问题（已用 git stash 证明改动前后一致，stash 已弹回还原）」。主 agent 独立复跑：`node verify-cc-task.mjs ccfix-20260915-swarmparse` → 全量 **tests=525 pass=525 fail=0**、*.test.js 子集 385/385；单跑 `node --test test/shadow-gate.test.js` → **10/10 通过**。即该「3 个失败」**不可复现**，cc 的自述在本项上不成立。',
    confidence: 'high',
    status: 'proposed',
    suggested: 'proposed',
    crossRef: ['L-2026-0915-060', 'L-2026-0915-068'],
    recordedAt: new Date().toISOString(),
  },
  {
    id: 'L-2026-0915-070',
    title: 'done.flag 缺失二次复发：runner 的 cc-failed 把「没写完成标记」与「写坏代码」混为一谈，目前该分类假阴性率 100%，须新增 cc-marker-missing',
    category: 'channel-reliability',
    layer: 'L1',
    trigger: 'runner.sh 写出 result.json 且 reason 含 `claude exit=0; done.flag=missing`（errorCode=cc-failed）时',
    decision: '① 主 agent 遇到该 errorCode **不得**直接判失败或重试——必须按「工作树可能已有完整产物」处理：先 `git status --porcelain` 看改动、比对规格写入范围、跑独立验收（verify-cc-task），**按产物判定而非按标记判定**；② 通道侧应新增独立分类 `cc-marker-missing`（判据：claude exit=0 且有工作树改动但 done.flag 缺失），使其与「真写坏代码」在审计上可区分，并据此进入「人工核验」路径而非「重试」路径。',
    rationale: '失败分类的唯一价值是决定下一步动作：真失败→重试/降级；标记缺失→人工核验产物。混为一谈会让无人值守链条在**产物完好时重跑**（浪费稀缺的 cc 额度），或在产物坏时因「反正分类一样」而误收，两头都错。',
    evidence: '两次实测同一签名：① V1-2（提交 c4b3125）result.json = `{status:"failed",errorCode:"cc-failed",reason:"claude exit=0; done.flag=missing"}`，独立验收 7/7 ACCEPT；② ccfix-20260915-swarmparse（提交 947fd3e）result.json 完全相同签名，独立验收 **7/7 ACCEPT**（全量 525/525）。即该分类下 2/2 产物实际完好 → 假阴性率 100%。',
    confidence: 'high',
    status: 'proposed',
    suggested: 'proposed',
    crossRef: ['L-2026-0915-069'],
    recordedAt: new Date().toISOString(),
  },
  {
    id: 'L-2026-0915-071',
    title: 'node --check 抓不到「模板串被反引号提前闭合」——那是合法 JS，只会在 import 时炸；且门控输出被 Select-String 过滤会制造「已通过」的错觉',
    category: 'tooling-trap',
    layer: 'L1',
    trigger: '写 cc 规格（含 prompt 模板字面量）后做派发前检查时；以及任何「跑门控脚本看几行输出」的场合',
    decision: '① 规格的派发前检查**必须真正 import 该模块**（`node check-spec.mjs <spec>` 就会 import），**不能**只跑 `node --check`——反引号提前闭合模板串、`${}` 注入等写法**语法完全合法**，node --check 返回 0，只有模块求值（ReferenceError: xxx is not defined）才暴露；② 门控/校验脚本的输出**必须看进程退出码并看全文**，禁止用 Select-String/grep 过滤后再下「通过」的结论——过滤会把报错行本身滤掉，剩下的空白被误读成「无异常」；③ 判据用「退出码 + 是否出现 RESULT/OK 行」双重确认。',
    rationale: '这两个坑叠加时最危险：门控**确实**报了错，但报错内容与过滤模式不匹配而消失，于是「门控通过」的错误结论被建立，直到真正的动作（dispatch/import）才炸——把「本可在写规格后 1 秒发现」的问题推迟到「派发时」，且极易被误判为通道故障而非规格笔误。',
    evidence: '2026-09-15 cc-specs/fix-swarm-parse.mjs：prompt 模板串内写了未转义的 `` `/steps/auto-review` ``，反引号闭合模板串使 `steps` 成为未定义标识符。`node --check` **exit=0 通过**（合法 JS）；真正暴露是 `cc-dispatch.mjs` import 时 `ReferenceError: steps is not defined at fix-swarm-parse.mjs:49`。同时该次 `node check-spec.mjs ... | Select-String -Pattern \'RESULT|编码自检|refs\'` 输出为空——门控其实已失败，但报错行不匹配过滤模式而被滤掉，造成「门控通过」的错觉。修法：转义为 \\` 后 `node --check` 与 `check-spec.mjs`（RESULT: OK）双双通过。同类笔误本会话累计第 5 次（见 066）。',
    confidence: 'high',
    status: 'proposed',
    suggested: 'proposed',
    crossRef: ['L-2026-0915-066', 'L-2026-0915-067'],
    recordedAt: new Date().toISOString(),
  },
  {
    id: 'L-2026-0915-072',
    title: '「范围外」测试改动的接受准则：断言若编码的正是被修掉的缺陷行为，改动属正当——但必须逐行判定断言强度是升是降',
    category: 'verification',
    layer: 'L1',
    trigger: 'cc 交付改了规格未声明的测试文件，理由是「原断言断言的正是被修复的缺陷行为，不改则修复必然红」时',
    decision: '① 先看 diff 是否**只**改「编码旧缺陷行为」的那一处断言，有无顺手删改无关用例；② 判定断言强度：**强化或持平可接受**（改期望值本身 + 新增断言），**弱化必须拒绝**（删除断言、改成 includes/正则放宽、改成恒真、注释掉）；③ 接受时用 `--allow <file>` 显式放行，并把「为何接受」写进提交信息与轨迹，**不得**默默放过；④ 若无法逐行确证强度未降，一律要求重做。',
    rationale: '「测试必须随语义演进」与「测试是防回归底线」天然冲突：语义修正会让编码旧行为的断言必然变红，但特权一旦给宽，弱化断言（把红的改成绿的最省事做法）就会伪装成「同步更新」。唯一安全的仲裁方式是把判断收敛到一个可操作的客观标准——**断言强度是否上升或持平**，并把例外显式留痕，使事后审计能复核这次放行。',
    evidence: '2026-09-15 ccfix-20260915-swarmparse：cc 改了范围外的 test/swarm-review.test.js。逐行审查：原 `assert.equal(parseRoleReview(\'乱码\').verdict, \'rejected\')` 断言的正是被修掉的「无法解析即静默 rejected」缺陷行为；改后为 `assert.equal(r.verdict, \'unknown\')` 并**新增** `assert.ok(r.raw.length > 0)` → 期望值随语义修正 + 断言数量增加，判定为**修正+强化**，接受并用 `--allow test/swarm-review.test.js` 放行，独立验收 7/7 ACCEPT（全量 525/525）。',
    confidence: 'high',
    status: 'proposed',
    suggested: 'proposed',
    crossRef: ['L-2026-0915-069'],
    recordedAt: new Date().toISOString(),
  },
];

for (const l of add) {
  if (doc.lessons.some((x) => x.id === l.id)) throw new Error(`重复 id: ${l.id}`);
  doc.lessons.push(l);
}

fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log(`[lessons] 追加 ${add.length} 条 → 总 ${doc.lessons.length} 条`);
console.log('[lessons] 新增: ' + add.map((l) => l.id).join(', '));
