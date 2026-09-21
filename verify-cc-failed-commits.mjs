// 精确核对：非 ok 的 cc 任务是否留下了提交
// 用词边界匹配提交信息里的「cc 任务 <id>」，避免两种误判：
//   ① 子串误判（ccfeat-20260916-chainstats 会命中 -chainstats-b 的提交）
//   ② id 后的全角标点（，/））各不相同，PowerShell 里传参会出错
import { execFileSync } from 'node:child_process';

const REPO = 'D:\\dsh-web-relay';
const raw = execFileSync('git', ['-C', REPO, 'log', '--all', '--format=%H%x09%s'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const commits = raw.split('\n').filter(Boolean).map((l) => {
  const [sha, ...rest] = l.split('\t');
  return { sha: sha.slice(0, 7), subject: rest.join('\t') };
});

const failedIds = [
  'rev-1a086c1d6b2', 'restart-interrupt-rca', 'ccfix-20260914-hb', 'ccfix-20260914-hb2',
  'ccfix-20260914-stats', 'v1-2-autoiter-decl-integrity', 'ccfix-20260915-swarmparse',
  'ccfix-20260915-autoiteraudit', 'ccfeat-20260915-selfcheck', 'ccfeat-20260916-chainstats',
  'ccfix-20260915-markermissing',
];

let withCommit = 0;
console.log('=== 非 ok 任务 → 是否留下了提交（词边界精确匹配）===');
for (const id of failedIds) {
  // 任务 id 必须作为完整词出现：后面允许全角/半角标点或行尾，但不允许再跟字母数字
  const re = new RegExp(`cc\\s*任务\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
  const hit = commits.find((c) => re.test(c.subject));
  if (hit) { withCommit++; console.log(`  [产出提交] ${id.padEnd(32)} ${hit.sha}  ${hit.subject.slice(0, 76)}`); }
  else console.log(`  [确无提交] ${id}`);
}
console.log(`\n  → ${failedIds.length} 个非 ok 任务中，有 ${withCommit} 个实际产出了落在 main 上的提交`);

// 反证：确认 chainstats（A4 打包版）与 chainstats-b 是两个不同任务，前者确无提交
console.log('\n=== 子串误判反证 ===');
const a4 = commits.filter((c) => /chainstats/.test(c.subject));
for (const c of a4.slice(0, 4)) console.log(`  ${c.sha}  ${c.subject.slice(0, 96)}`);
