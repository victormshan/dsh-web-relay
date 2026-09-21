// A6 补丁生成器：给 runner.sh 增加「任务执行期间保持心跳新鲜」的后台打点
// 不直接改 runner.sh（此刻可能正在执行 A4）——只生成 runner.sh.a6 供空闲时一次性替换。
// 用法：node gen-a6-runner-patch.mjs
import fs from 'node:fs';

const SRC = 'D:\\cc-tasks\\runner.sh';
const DST = 'D:\\cc-tasks\\runner.sh.a6';

const orig = fs.readFileSync(SRC, 'utf8');
if (orig.includes('A6-HEARTBEAT-PINGER')) {
  console.log('  已包含 A6 补丁（幂等），无需重复生成');
  process.exit(0);
}

const BLOCK = [
  '# ── A6-HEARTBEAT-PINGER（2026-09-16）────────────────────────────────────────────',
  '# 任务执行期间保持心跳新鲜。背景：cc-watchdog.sh 是**前台**串行调用 runner.sh，任务期间其轮询',
  '# 循环阻塞 → watchdog.heartbeat 冻结数百秒（单任务 200-900s，实测中位约 8 分钟）→ relay 的',
  '# ccWatchdogAlive（阈值 120s）在任务执行期间**必然**判 stale：',
  '#   · 非 strict：reason=alive-unverified:<age> → /health-check 出现误导性 ccWatchdogWarning；',
  '#   · strict=1  ：ok=false → **直接阻断派发**（审核链被迫降级）。',
  '# 故「心跳」的语义应是「守护在工作」而非仅「守护在轮询」；此处后台打点让它在整个任务期间保持新鲜。',
  '# 不改变串行语义（仍一次只跑一个任务），仅新增一个 15s 周期 touch 的后台子进程，退出时 trap 清理。',
  'HB_FILE=/mnt/d/cc-tasks/watchdog.heartbeat',
  'touch "$HB_FILE" 2>/dev/null || true',
  '( while :; do sleep 15; touch "$HB_FILE" 2>/dev/null; done ) &',
  'HB_PID=$!',
  'trap \'kill "$HB_PID" 2>/dev/null || true\' EXIT',
  '# ────────────────────────────────────────────────────────────────────────────────',
  '',
].join('\n');

// 插入点：`echo "[runner] start ..."` 之后（该行已在「already done」提前返回之后，故不会白起子进程）
const anchor = /(echo "\[runner\] start \$START task=\$T \(dir=\$TD\)"\n)/;
if (!anchor.test(orig)) { console.error('  ❌ 未找到插入锚点，脚本可能已变更，请人工确认'); process.exit(2); }
const patched = orig.replace(anchor, `$1${BLOCK}`);

fs.writeFileSync(DST, patched, 'utf8');
console.log('  已生成 ' + DST);
console.log('  原始 ' + Buffer.byteLength(orig, 'utf8') + ' 字节 → 补丁版 ' + Buffer.byteLength(patched, 'utf8') + ' 字节');
console.log('  新增行数 = ' + (patched.split('\n').length - orig.split('\n').length));
