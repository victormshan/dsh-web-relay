// 归档 /ask 派生快照 expr（lesson L-2026-0909-039 逻辑归档语义：isTest=true + status=done + finalized=true + archivedNote）
// 并打印权威 expr 的步骤清单，供主 agent 实盘核对。
// 用法: node archive-aux-expr.mjs <workspaceRoot> <auxExprId> <authoritativeExprId>
import fs from 'node:fs';
import path from 'node:path';

const [ws, auxId, mainId] = process.argv.slice(2);
if (!ws || !auxId || !mainId) {
  console.error('usage: node archive-aux-expr.mjs <workspaceRoot> <auxExprId> <authoritativeExprId>');
  process.exit(2);
}

const expDir = path.join(ws, 'web-relay', 'experiments');
const readState = (id) => JSON.parse(fs.readFileSync(path.join(expDir, `${id}.steps.json`), 'utf8'));

// 1) 归档派生快照
const auxPath = path.join(expDir, `${auxId}.steps.json`);
const aux = JSON.parse(fs.readFileSync(auxPath, 'utf8'));
aux.isTest = true;
aux.status = 'done';
aux.finalized = true;
aux.finalizedAt = aux.finalizedAt || new Date().toISOString();
aux.archivedAt = new Date().toISOString();
aux.archivedReason =
  `aux 快照逻辑归档（lesson L-2026-0909-039）：本 expr 是 /ask 重规划轮的派生记录，其 Step List 已由主 agent ` +
  `审计后经 /steps/restructure 并入权威 expr ${mainId}，故置 isTest+done+finalized 退出 bootResumeScan/心跳扫描。`;
aux.updatedAt = new Date().toISOString();
fs.writeFileSync(auxPath, JSON.stringify(aux, null, 2) + '\n', 'utf8');
console.log(`[archived] ${auxId} -> isTest=${aux.isTest} status=${aux.status} finalized=${aux.finalized}`);

// 2) 打印权威 expr 的步骤清单（实盘核对）
const main = readState(mainId);
console.log(`[authoritative] ${mainId} status=${main.status} iterations=${main.iterations} autoDecision=${main.autoDecision} steps=${main.steps.length}`);
for (const s of main.steps) {
  console.log(`  [${s.id}] importance=${s.importance} review=${s.review} deps=[${(s.depends_on || []).join(',')}] status=${s.status} :: ${String(s.title).slice(0, 60)}`);
}
