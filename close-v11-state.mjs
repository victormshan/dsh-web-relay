// 收口 v11 链条状态（主 agent 手动收口：链条在旧验收规则下已判过 REJECT 并停止，而规则已修正为
// "两平台都失败才算真回归" → 复验 ACCEPT，故由主 agent 合入并写状态，避免链条在下一个 20 分钟周期重派 cc）。
// 幂等：重复运行只是重写同一份状态。
import fs from 'node:fs';

const STATE = 'D:\\cc-tasks\\chain-state.json';
const TASK = 'ccfix-20260918-acceptcall-b';
const LABEL = 'v11 验收命令形态平台化（纯函数 + win32 明确拒绝）';
const COMMIT = process.argv[2];
if (!COMMIT) { console.error('usage: node close-v11-state.mjs <commitSha>'); process.exit(2); }

const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
if (s.chainId !== 'v11-acceptcall-b') {
  console.error(`拒绝：当前状态归属 ${s.chainId}，不是 v11-acceptcall-b（避免误改在飞链条的状态）`);
  process.exit(1);
}
const result = JSON.parse(fs.readFileSync(`D:\\cc-tasks\\tasks\\${TASK}\\result.json`, 'utf8'));
const now = new Date().toISOString();
// 先备份（与 cc-chain 的换链备份同一习惯：状态可回滚）
fs.writeFileSync(`${STATE}.${s.chainId}.pre-manual-close.bak`, JSON.stringify(s, null, 2), 'utf8');
s.items = s.items || {};
s.items[LABEL] = {
  status: 'accepted-awaiting-review',
  result: { status: result.status, exit: result.exit, errorCode: result.errorCode, start: result.start, end: result.end },
  commit: COMMIT,
  at: now,
  closure: null,
  note: '主 agent 手动收口：cc 自报 v2-validate-failed（runner 自带验收步骤当时仍受旧实现影响），'
    + '但独立验收 ACCEPT 8/8、执行接地探针 10/10、全量测试 WSL 0 失败（Windows 3 项为命令形态 POSIX 用例，平台差异）',
};
s.index = 1;
s.completedAt = s.completedAt || now;
s.manualClose = { at: now, by: 'relay-main-agent', why: '验收规则自 Windows-only 修正为跨平台交集后复验为 ACCEPT' };
fs.writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8');
console.log(`已收口：chainId=${s.chainId} index=${s.index} completedAt=${s.completedAt} commit=${COMMIT}`);
