// 按 dsh-web-relay/package.json 的 files 清单补齐「运行时副本」（宿主实际加载的那份）。
// 策略：缺失项 → 复制；已存在项 → 只比对 sha256 并报告（不覆盖，避免动到宿主侧改动）。
// 用法：node sync-install-carrier.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = 'D:/dsh-web-relay';
const RUNTIME = 'C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-web-relay';
const apply = process.argv.includes('--apply');

const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).files;
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);

// 目录展开成文件清单（lib 这类）
const expand = (rel) => {
  const abs = path.join(REPO, rel.split('/').join(path.sep));
  if (!fs.existsSync(abs)) return [{ rel, missingInRepo: true }];
  if (!fs.statSync(abs).isDirectory()) return [{ rel }];
  const out = [];
  const walk = (dir, base) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const r = `${base}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else out.push({ rel: r });
    }
  };
  walk(abs, rel);
  return out;
};

const entries = manifest.flatMap(expand);
const copied = [];
const present = [];
const differ = [];
const missingInRepo = [];

for (const { rel, missingInRepo: mir } of entries) {
  if (mir) {
    missingInRepo.push(rel);
    continue;
  }
  const src = path.join(REPO, rel.split('/').join(path.sep));
  const dst = path.join(RUNTIME, rel.split('/').join(path.sep));
  if (!fs.existsSync(dst)) {
    if (apply) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    copied.push(rel);
  } else if (sha(src) === sha(dst)) {
    present.push(rel);
  } else {
    differ.push({ rel, repo: sha(src), runtime: sha(dst) });
  }
}

console.log(`清单条目 ${manifest.length} → 展开文件 ${entries.length}`);
console.log(`  缺失已${apply ? '补齐' : '待补'} : ${copied.length}`);
console.log(`  已存在且一致      : ${present.length}`);
console.log(`  已存在但内容不同  : ${differ.length}`);
console.log(`  仓库侧缺失        : ${missingInRepo.length}`);
if (copied.length) {
  console.log('\n--- 补齐清单 ---');
  for (const c of copied) console.log('  + ' + c);
}
if (differ.length) {
  console.log('\n--- 内容不同（未覆盖，请人工确认）---');
  for (const d of differ) console.log(`  ! ${d.rel}  repo=${d.repo} runtime=${d.runtime}`);
}
if (missingInRepo.length) {
  console.log('\n--- 仓库侧缺失（清单写错或缺文件）---');
  for (const m of missingInRepo) console.log('  ? ' + m);
}

// 装配清单 6 项终检
const ASSEMBLY = [
  'docs/main-agent-runbook-v0.1.md',
  'docs/capabilities/registry.yaml',
  'skills/auto-iteration-modeling/SKILL.md',
  'skills/agent-tool-troubleshooting/SKILL.md',
  'skills/dsh-web-relay-main-agent/SKILL.md',
  'docs/main-agent-lessons.json',
];
console.log('\n--- 主 agent 装配清单（运行时副本解析）---');
let ok = 0;
for (const a of ASSEMBLY) {
  const p = path.join(RUNTIME, a.split('/').join(path.sep));
  const e = fs.existsSync(p);
  if (e) ok++;
  console.log(`  ${e ? '✅' : '❌'} ${a}`);
}
console.log(`  装配可解析 ${ok}/${ASSEMBLY.length}`);
if (!apply) console.log('\nDRY-RUN：未写入（加 --apply 生效）');
