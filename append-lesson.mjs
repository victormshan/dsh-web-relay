// 给 dsh-web-relay/docs/main-agent-lessons.json 追加一条 lesson
// 保持既有格式：2 空格缩进 JSON + LF + 无 BOM。
// 用法：node append-lesson.mjs [--apply]      （不加 --apply 为 dry-run，只报格式漂移）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/dsh-web-relay';
const target = path.join(ROOT, 'docs', 'main-agent-lessons.json');
const apply = process.argv.includes('--apply');

const lesson = {
  id: 'L-2026-0913-057',
  title:
    '宿主换线/换版后浏览器白屏≠网络故障：SPA 外壳无 cache-control 被启发式缓存，旧外壳指向新线不存在的资源寻址（手机尤其明显，清站点数据即恢复）',
  category: 'tooling-trap',
  layer: 'L2',
  trigger:
    '切换 dsh 版本线/端口/authority 后某个浏览器打开 GUI 一片空白（手机尤甚），而 curl 探针、token 303、静态资源都正常时',
  decision:
    '① 先用「隐私标签 或 清该站点数据」做 30 秒判别——本次即以此定位；② 排查顺序固定为：传输与鉴权（303 Location:/ + dsh-auth cookie authority=目标域名）→ 带 cookie 首页 200 → 静态资源经 ts.net 与本机字节数一致 → 无 serviceWorker → 最后才怀疑缓存；③ 根因在 harness：dsh-host-frontend-static/lib/index.js L73 服务 SPA 外壳只写 content-type（无 cache-control/etag/last-modified），而 dsh-client-modules/lib/index.js L122/L866 给插件包带 `?rev=` + `public, max-age=31536000, immutable`——「外壳可被启发式缓存 + 资源按 rev 寻址」组合，换版后旧外壳的引用必然失配 → 白屏；④ 换线/换版后的验收清单里加一条「清目标浏览器站点数据」；长期修法是给 HTML 加 no-store（上游 issue）。',
  rationale:
    '白屏的第一直觉是网络/端口/鉴权，但本次三者都已实测排除：tailscale 直连 7ms 且 tx 17.9MB（11.27MB 插件包确实下完）、serve 映射 443→3080 正确、宿主带 --trusted-host。同 origin 此前跑的是 rc.7 宿主，其产物布局与新线（/plugins/??…&rev=）不同，缓存旧外壳是唯一与「电脑正常、手机白屏」相符的解释，且清站点数据一次即验证。',
  evidence:
    '2026-09-13：手机 https://win10-dt.taile618c2.ts.net/?token=… 白屏；实测 303 Location:/ + set-cookie dsh-auth-…(authority=win10-dt.taile618c2.ts.net)、带 cookie 首页 200/28,218B、插件包 11,268,207B 与 modules 包 18,683B 经 ts.net 与本机字节数完全一致、HTML 内 serviceWorker/127.0.0.1 计数为 0；清站点数据后恢复（用户确认）。服务端落点：dsh-host-frontend-static/lib/index.js L73（仅 content-type）、dsh-client-modules/lib/index.js L122/L866（immutable + rev）。',
  confidence: 'high',
  status: 'proposed',
  suggested: 'proposed',
  crossRef: ['L-2026-0911-049'],
  recordedAt: new Date().toISOString(),
};

const before = fs.readFileSync(target, 'utf8');
const doc = JSON.parse(before);
if (!Array.isArray(doc.lessons)) throw new Error('lessons 字段不是数组');
if (doc.lessons.some((l) => l.id === lesson.id)) throw new Error('已存在同 id lesson：' + lesson.id);

doc.lessons.push(lesson);
doc.meta = { ...doc.meta, updatedAt: lesson.recordedAt };
const after = JSON.stringify(doc, null, 2) + '\n';

const a = before.split('\n');
const b = after.split('\n');
let firstDiff = -1;
for (let i = 0; i < Math.min(a.length, b.length); i++) {
  if (a[i] !== b[i]) {
    firstDiff = i;
    break;
  }
}
console.log(`before=${a.length} 行  after=${b.length} 行  新增 ${b.length - a.length} 行`);
console.log(`首个差异行 = ${firstDiff === -1 ? '(无)' : firstDiff + 1}（应落在文件尾部插入点附近；若靠前即为存量格式漂移）`);
if (firstDiff !== -1) {
  console.log('  before: ' + a[firstDiff].slice(0, 120));
  console.log('  after : ' + b[firstDiff].slice(0, 120));
}
if (!apply) {
  console.log('DRY-RUN：未写入（加 --apply 生效）');
  process.exit(0);
}
fs.writeFileSync(target, after, 'utf8');
console.log('written: ' + target);
