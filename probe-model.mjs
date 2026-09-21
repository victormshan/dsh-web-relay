// 探测本会话使用的模型/提供方（只读 projection cache，不打印密钥）
import fs from 'node:fs';

const p = 'C:/Users/Administrator/.dsh/storages/session_projcache/sessions/session-5ee8782e-998f-42d1-9461-840596aa2771.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('顶层键 =', Object.keys(j).join(', '));

const flat = JSON.stringify(j);
const keys = ['model', 'modelId', 'provider', 'agentDefaultModel', 'effort', 'reasoningEffort', 'title', 'cwd', 'updatedAt', 'createdAt'];
for (const k of keys) {
  const re = new RegExp('"' + k + '"\\s*:\\s*("[^"]{0,80}"|[^,}\\]]{0,40})');
  const m = flat.match(re);
  if (m) console.log(k, '=', m[1]);
}

const hits = [...flat.matchAll(/"[^"]{0,24}(deepseek|claude|gemini|gpt)[^"]{0,48}"/gi)].map((x) => x[0]);
console.log('模型相关字符串 =', [...new Set(hits)].slice(0, 12).join(' | ') || '(无)');

// 宿主 profile 配置里可能写着默认模型
for (const f of ['C:/Users/Administrator/.dsh/config.json', 'C:/Users/Administrator/.dsh/profiles/web/config.json', 'C:/Users/Administrator/.dsh/profiles/web/cordis.yml']) {
  try {
    const t = fs.readFileSync(f, 'utf8');
    const ms = [...t.matchAll(/"[^"]{0,16}(model|Model)[^"]{0,16}"\s*:\s*("[^"]{0,60}"|[^,}\n]{0,40})/g)].map((x) => x[0]);
    console.log(`\n[${f}] 命中 ${ms.length} 处：`);
    for (const m of [...new Set(ms)].slice(0, 12)) console.log('   ', m);
  } catch (e) {
    console.log(`\n[${f}] 不可读: ${e.code || e.message}`);
  }
}
