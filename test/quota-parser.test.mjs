/**
 * quota-parser.test.mjs
 * “配额判断”唯一收敛模块的自测：node:test + assert/strict，纯函数，无 IO。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMIT_WORDING,
  parseResetsAt,
  isQuotaFailureText,
  classifyQuotaProbe,
  shortcutCapMs,
} from '../lib/quota-parser.mjs';

const REAL_WEEKLY = "You've hit your weekly limit · resets 2am (Asia/Shanghai)";

// --- isQuotaFailureText（分类语义：只认措辞，不看有无 OK） ---

test('isQuotaFailureText：本机真实 weekly 文案命中', () => {
  assert.equal(isQuotaFailureText(REAL_WEEKLY), true);
});

test('isQuotaFailureText：session/rate/usage/quota 各类措辞均命中', () => {
  assert.equal(isQuotaFailureText("You've hit your session limit · resets 7am (Asia/Shanghai)"), true);
  assert.equal(isQuotaFailureText('429 rate limit hit, please retry later'), true);
  assert.equal(isQuotaFailureText('Claude AI usage limit reached'), true);
  assert.equal(isQuotaFailureText('API error: quota exceeded'), true);
});

test('isQuotaFailureText：普通失败文本（不含限额措辞）不命中', () => {
  assert.equal(isQuotaFailureText('Error: cannot find module "./missing.js"'), false);
  assert.equal(isQuotaFailureText('claude exit=1; done.flag=missing'), false);
  assert.equal(isQuotaFailureText(''), false);
  assert.equal(isQuotaFailureText(undefined), false);
});

test('isQuotaFailureText：不含 OK 的普通日志不得因“探针语义”混用而被误判为配额失败', () => {
  // 回归本任务修复的核心风险：分类语义只认措辞，不因为文本里没有 "OK" 就判定为配额耗尽。
  const plainLog = 'TypeError: cannot read property of undefined\n  at foo.js:12';
  assert.equal(isQuotaFailureText(plainLog), false);
  assert.equal(/\bOK\b/.test(plainLog), false); // 佐证：这段文本确实不含 OK
});

// --- classifyQuotaProbe（探针语义：可用时打印 OK，没 OK 也算不可用） ---

test('classifyQuotaProbe：探针输出含独立 OK → available', () => {
  assert.equal(classifyQuotaProbe('probe: OK'), 'available');
  assert.equal(classifyQuotaProbe('OK'), 'available');
});

test('classifyQuotaProbe：探针输出不含 OK → exhausted（即使不含任何限额措辞，如崩溃/空输出）', () => {
  assert.equal(classifyQuotaProbe(''), 'exhausted');
  assert.equal(classifyQuotaProbe('Error: probe process crashed'), 'exhausted');
  assert.equal(classifyQuotaProbe(REAL_WEEKLY), 'exhausted');
});

test('两种语义的区别：同一段“不含 OK 也不含限额措辞”的文本，分类语义判“非配额失败”而探针语义判“不可用”', () => {
  const noisyOutput = 'connection reset by peer';
  assert.equal(isQuotaFailureText(noisyOutput), false, '分类语义：没有限额措辞，不应判为配额失败');
  assert.equal(classifyQuotaProbe(noisyOutput), 'exhausted', '探针语义：没有 OK，仍应判为不可用');
});

// --- LIMIT_WORDING ---

test('LIMIT_WORDING：是单一正则常量，且能独立完成措辞匹配', () => {
  assert.ok(LIMIT_WORDING instanceof RegExp);
  assert.equal(LIMIT_WORDING.test(REAL_WEEKLY), true);
  assert.equal(LIMIT_WORDING.test('nothing special here'), false);
});

// --- parseResetsAt ---

test('parseResetsAt：weekly 真实文案（仅小时，无分钟）解析出未来时刻', () => {
  const now = Date.parse('2026-09-19T10:00:00Z');
  const iso = parseResetsAt(REAL_WEEKLY, { now });
  assert.equal(typeof iso, 'string');
  assert.ok(Date.parse(iso) > now);
});

test('parseResetsAt：解析不出时返回 null，不抛错', () => {
  assert.equal(parseResetsAt('no resets info here'), null);
  assert.equal(parseResetsAt(''), null);
  assert.equal(parseResetsAt(undefined), null);
});

// --- shortcutCapMs ---

test('shortcutCapMs：weekly → 24 小时；其余（session/rate/usage/未知）→ 6 小时', () => {
  assert.equal(shortcutCapMs('weekly'), 24 * 60 * 60 * 1000);
  assert.equal(shortcutCapMs('session'), 6 * 60 * 60 * 1000);
  assert.equal(shortcutCapMs('rate'), 6 * 60 * 60 * 1000);
  assert.equal(shortcutCapMs('unknown-kind'), 6 * 60 * 60 * 1000);
  assert.equal(shortcutCapMs(undefined), 6 * 60 * 60 * 1000);
});
