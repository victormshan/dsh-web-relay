// 三副本交付：把仓库（D:\dsh-web-relay）中 package.json files 清单内的文件**逐个哈希比对并覆盖**到运行时副本。
//
// 为什么需要它：sync-install-carrier.mjs 只「补齐缺失文件、对已存在但内容不同的文件只报告不覆盖」
// （见其 L46-56）——因此它**能加新文件、却永远送不出对既有文件的修改**。实测 2026-09-15：
// 运行时副本已包含 V3-1 新增脚本（缺失→被补齐），但 lib/index.js / lib/swarm-prompts.js 等
// **被修改的既有文件一直是旧的**。宿主按 profile 的 cordis.patch.yml 以 name=dsh-web-relay 挂载插件，
// 加载的正是 profiles\web\node_modules\dsh-web-relay 这份代码，故不覆盖 = 交付不生效。
//
// 用法:
//   node deliver-three-copies.mjs            # DRY-RUN：只报告每个目标将更新哪些文件
//   node deliver-three-copies.mjs --apply    # 实际覆盖（覆盖前把旧文件备份到 <目标>\.dsh-relay-backup-<ts>\）
import fs from 'node:fs';
import { assertWriteRight } from './agent-write-lock.mjs'
import { guardGate } from './optimistic-guard.mjs'

import path from 'node:path';
import crypto from 'node:crypto';

const REPO = 'D:\\dsh-web-relay';
const TARGETS = [
  { label: '运行时副本（宿主实际加载）', root: 'C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-web-relay' },
  { label: 'DSH 侧副本', root: 'D:\\DSH\\dsh-web-relay' },
  { label: 'standalone 副本', root: 'D:\\dsh-web-relay-standalone' },
];
const apply = process.argv.includes('--apply');
if (apply) assertWriteRight({ what: '交付三副本（覆盖运行副本）' })
// ccfeat-20260920-guardgate: `--guard <name>` → **在任何落盘之前**做乐观检测（工作树是否已不是我记录的样子）。
// 无记录→4（未验证，不当成"没变"）；已变动→1（拒绝交付，先重读）。dry-run 也照样检查（提前告警）。
{
  const gi = process.argv.indexOf('--guard');
  const guardName = gi >= 0 && process.argv[gi + 1] ? process.argv[gi + 1] : null;
  if (guardName) {
    const g = guardGate(guardName);
    console.log(g.message);
    if (!g.ok) process.exit(g.exit);   // ← 拒绝发生在 backups/写入循环之前（探针会断言没有"汇总"行）
  }
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const expand = (rel) => {
  const abs = path.join(REPO, rel.split('/').join(path.sep));
  if (!fs.existsSync(abs)) return [];
  if (!fs.statSync(abs).isDirectory()) return [rel];
  const out = [];
  const walk = (dir, base) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = `${base}/${e.name}`;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  walk(abs, rel);
  return out;
};

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
// files 清单 + package.json 自身（清单不含自身，但运行时副本的 version/files 也必须同步）
const manifest = [...new Set([...(pkg.files || []), 'package.json'])];
const rels = manifest.flatMap(expand);
console.log(`[deliver] 源仓库 ${REPO}`);
console.log(`[deliver] 清单条目 ${manifest.length} → 展开文件 ${rels.length} 个${apply ? '（APPLY）' : '（DRY-RUN）'}\n`);

let grandUpdated = 0;
let grandSame = 0;
const failures = [];

for (const t of TARGETS) {
  if (!fs.existsSync(t.root)) {
    console.log(`── ${t.label}\n   目标不存在，跳过：${t.root}\n`);
    continue;
  }
  const backupDir = path.join(t.root, `.dsh-relay-backup-${stamp}`);
  const toUpdate = [];
  let same = 0;
  let missing = 0;

  for (const rel of rels) {
    const src = path.join(REPO, rel.split('/').join(path.sep));
    const dst = path.join(t.root, rel.split('/').join(path.sep));
    if (!fs.existsSync(dst)) { missing++; toUpdate.push(rel); continue; }
    if (sha(src) === sha(dst)) { same++; continue; }
    toUpdate.push(rel);
  }

  console.log(`── ${t.label}`);
  console.log(`   ${t.root}`);
  console.log(`   一致 ${same} | 待更新 ${toUpdate.length}（其中目标缺失 ${missing}）`);

  if (apply && toUpdate.length) {
    for (const rel of toUpdate) {
      const src = path.join(REPO, rel.split('/').join(path.sep));
      const dst = path.join(t.root, rel.split('/').join(path.sep));
      if (fs.existsSync(dst)) {
        const b = path.join(backupDir, rel.split('/').join(path.sep));
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(dst, b);
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    // 回读校验：逐字节哈希必须与源一致
    const bad = toUpdate.filter((rel) => sha(path.join(REPO, rel.split('/').join(path.sep))) !== sha(path.join(t.root, rel.split('/').join(path.sep))));
    if (bad.length) failures.push({ target: t.label, files: bad });
    console.log(`   已更新 ${toUpdate.length} 个${fs.existsSync(backupDir) ? `（备份于 ${path.basename(backupDir)}）` : ''} | 回读校验${bad.length ? `失败 ${bad.length}` : '通过'}`);
  } else if (!apply && toUpdate.length) {
    for (const rel of toUpdate.slice(0, 12)) console.log(`     ! ${rel}`);
    if (toUpdate.length > 12) console.log(`     … 另有 ${toUpdate.length - 12} 个`);
  }
  console.log('');
  grandUpdated += toUpdate.length;
  grandSame += same;
}

console.log(`[deliver] 汇总：一致 ${grandSame} | 需更新 ${grandUpdated}${apply ? '（已更新）' : ''}`);
if (failures.length) {
  console.error('[deliver] 回读校验失败：' + JSON.stringify(failures, null, 2));
  process.exit(1);
}
if (!apply) console.log('[deliver] DRY-RUN：未写入（加 --apply 生效）');
else console.log('[deliver] 完成。宿主加载的是运行时副本，lib/ 改动需 request-restart 后才生效。');
