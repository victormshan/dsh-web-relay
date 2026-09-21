// 离线复现 lib/index.js 的契约自检（不改动任何文件），确认两半各错在哪
import fs from 'node:fs';
import { extractRoutes } from 'file:///D:/dsh-web-relay/scripts/sync-engine-docs.mjs';

const src = fs.readFileSync('D:/dsh-web-relay/lib/index.js', 'utf8');

// ---- 路由半 ----
const REQUIRED_ROUTES = [
  '/dsh-web-relay/health-check', '/dsh-web-relay/ask', '/dsh-web-relay/steps',
  '/dsh-web-relay/steps/update', '/dsh-web-relay/steps/auto-review', '/dsh-web-relay/trace',
];
const routes = extractRoutes(src);
const routeMissing = REQUIRED_ROUTES.filter((r) => !routes.includes(r));
console.log('=== 路由半 ===');
console.log('  extractRoutes 提取到 ' + routes.length + ' 条；样例: ' + JSON.stringify(routes.slice(0, 4)));
console.log('  必需路由缺失 = ' + (routeMissing.length ? JSON.stringify(routeMissing) : '无 ✅'));

// ---- 字段半：现状（cc 的写法）vs 修正后 ----
const FIELDS = ['ok', 'version', 'bootId', 'resumed', 'heartbeat', 'preparing', 'bridge', 'restartStats',
  'channelStats', 'dialogFallbackRate', 'ccStats', 'ccWatchdogWarning', 'healthCache', 'selfCheck'];
const check = (slice, label) => {
  const missing = FIELDS.filter((f) => !slice.includes(f + ':') && !slice.includes(f + ','));
  console.log(`  ${label}: 切片长度=${slice.length} 缺失字段=${missing.length ? missing.length + ' 个 ' + JSON.stringify(missing.slice(0, 4)) : '0 ✅'}`);
  return missing.length;
};
const startBad = src.indexOf('const healthCheckHandler = async');           // cc 现状
const sliceBad = src.slice(startBad, startBad + 8000);
const startGood = src.lastIndexOf('const healthCheckHandler = async');      // 修正候选：取最后一处（真实定义）
const endGood = src.indexOf('const askHandler = async', startGood);
const sliceGood = src.slice(startGood, endGood === -1 ? startGood + 8000 : endGood);
console.log('=== 字段半 ===');
console.log('  起点(cc 现状)=索引 ' + startBad + ' | 起点(修正)=索引 ' + startGood + ' | askHandler 终点=' + endGood);
const badN = check(sliceBad, 'cc 现状');
const goodN = check(sliceGood, '修正候选');
console.log('\n=== 结论 ===');
console.log('  cc 现状会不会每次 boot 假报契约失败 → ' + ((badN > 0 || routeMissing.length > 0) ? '会 ❌（必然假唤醒）' : '不会'));
console.log('  修正候选是否通过 → ' + ((goodN === 0 && routeMissing.length === 0) ? '通过 ✅' : '仍不通过 ❌'));
