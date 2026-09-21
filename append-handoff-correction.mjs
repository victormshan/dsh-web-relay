// 更正交接说明 v2 中的「工作树」瞬时状态（写入时 OPS 编辑未提交；现已提交）
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const trace = String.raw`D:\dsh relay test\web-relay\traces\expr-2026-09-13_17-36-07.md`;
const REPO = 'D:\\dsh-web-relay';
const head = String(spawnSync('git', ['-C', REPO, 'log', '--oneline', '-1'], { encoding: 'utf8' }).stdout || '').trim();
const dirty = String(spawnSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }).stdout || '').trim();
const body = `
> 更正（${new Date().toISOString()}）：上条交接说明 v2 记录「工作树非干净」是写入那一刻的瞬时状态（OPS-CC-CHAIN 的 §7 编辑尚未提交）。
> 该编辑已提交为 ${head.split(' ')[0]}，当前工作树 ${dirty ? '仍非干净（' + dirty.split('\n').length + ' 处）' : '干净'}。
`;
fs.appendFileSync(trace, body, 'utf8');
console.log('  更正已写入，追加字节 =', Buffer.byteLength(body, 'utf8'), '| 当前 HEAD =', head.split(' ')[0], '| 工作树 =', dirty ? '脏' : '干净');
