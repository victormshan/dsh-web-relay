// Capture /health-check AFTER the host restart (survives the restart because it runs as a scheduled task,
// not as a child of the agent session). Idempotent: exits immediately once a result file exists.
// Purpose: the restart kills every child process of this session, so post-restart evidence must be
// collected by something outside the session.
import fs from 'node:fs';
import path from 'node:path';

const WORK = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '));
const OUT = path.join(WORK, '_postrestart-health.json');
const LOG = path.join(WORK, '_postrestart-health.log');
const EXPECTED = process.argv[2] || '';
const URL_ = 'http://127.0.0.1:3080/dsh-web-relay/health-check';

if (fs.existsSync(OUT)) process.exit(0); // already captured

const stamp = () => new Date().toISOString();
try {
  const r = await fetch(URL_, { signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* not json */ }
  if (!j) {
    fs.appendFileSync(LOG, `${stamp()} HTTP ${r.status} 非 JSON（宿主可能正在重启）\n`, 'utf8');
    process.exit(0);
  }
  const libHash = j.loadedLibHash || (j.selfCheck && j.selfCheck.loadedLibHash) || null;
  const loadedFrom = j.loadedFrom || (j.selfCheck && j.selfCheck.loadedFrom) || null;
  if (!libHash) {
    fs.appendFileSync(LOG, `${stamp()} HTTP ${r.status} bootId=${j.bootId || '?'} 但 loadedLibHash 仍缺失（宿主还没加载新代码？）\n`, 'utf8');
    process.exit(0);
  }
  const verdict = !EXPECTED ? 'no-expected-given' : libHash === EXPECTED ? 'EXACT-MATCH' : 'MISMATCH';
  const rec = {
    at: stamp(), httpStatus: r.status, bootId: j.bootId || null,
    loadedLibHash: libHash, loadedFrom,
    expectedRepoLibHash: EXPECTED || null, verdict,
    hasCcChainStats: !!(j.ccChainStats || (j.selfCheck && j.selfCheck.ccChainStats) || j.heavy?.ccChainStats),
    selfCheck: j.selfCheck ? { contract: j.selfCheck.contract, drift: j.selfCheck.drift } : null,
  };
  fs.writeFileSync(OUT, JSON.stringify(rec, null, 2), 'utf8');
  fs.appendFileSync(LOG, `${stamp()} ${verdict} bootId=${rec.bootId} loadedLibHash=${libHash} loadedFrom=${loadedFrom}\n`, 'utf8');
} catch (e) {
  fs.appendFileSync(LOG, `${stamp()} 抓取失败：${e.message}（下次再试）\n`, 'utf8');
}
