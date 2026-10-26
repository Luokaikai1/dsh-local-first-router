import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPeakBeijing, beijingDate } from '../lib/peak.js';
import { decide, gateCheck, isForcedLocal, normalizeConfig } from '../lib/policy.js';

const bj = (iso) => Date.parse(`${iso}+08:00`);

test('peak window: weekday 09:00-12:00 and 14:00-18:00 Beijing', () => {
  assert.equal(isPeakBeijing(bj('2026-10-26T08:59:00')), false);
  assert.equal(isPeakBeijing(bj('2026-10-26T09:00:00')), true);
  assert.equal(isPeakBeijing(bj('2026-10-26T11:59:00')), true);
  assert.equal(isPeakBeijing(bj('2026-10-26T12:00:00')), false);
  assert.equal(isPeakBeijing(bj('2026-10-26T13:59:00')), false);
  assert.equal(isPeakBeijing(bj('2026-10-26T14:00:00')), true);
  assert.equal(isPeakBeijing(bj('2026-10-26T17:59:00')), true);
  assert.equal(isPeakBeijing(bj('2026-10-26T18:00:00')), false);
});

test('peak window: weekends and statutory holidays are off-peak all day', () => {
  assert.equal(isPeakBeijing(bj('2026-10-24T10:00:00')), false); // Saturday
  assert.equal(isPeakBeijing(bj('2026-10-25T10:00:00')), false); // Sunday
  assert.equal(isPeakBeijing(bj('2026-10-05T10:00:00')), false); // National Day holiday
  assert.equal(beijingDate(bj('2026-10-26T23:30:00')), '2026-10-26');
});

test('gate: off-peak required, balance floor, unknown balance fails closed', () => {
  const cfg = normalizeConfig({ minBalanceCny: 5, requireOffPeak: true });
  assert.deepEqual(gateCheck(cfg, { peak: true, balance: 100 }), { ok: false, reason: 'peak-hours' });
  assert.deepEqual(gateCheck(cfg, { peak: false, balance: undefined }), { ok: false, reason: 'balance-unknown' });
  assert.deepEqual(gateCheck(cfg, { peak: false, balance: null }), { ok: false, reason: 'balance-unavailable' });
  assert.deepEqual(gateCheck(cfg, { peak: false, balance: 4.99 }), { ok: false, reason: 'balance-low(4.99)' });
  assert.deepEqual(gateCheck(cfg, { peak: false, balance: 5 }), { ok: true, reason: 'ok' });
});

test('gate: onBalanceUnavailable=allow lets cloud through', () => {
  const cfg = normalizeConfig({ minBalanceCny: 5, onBalanceUnavailable: 'allow' });
  assert.deepEqual(gateCheck(cfg, { peak: false, balance: null }), { ok: true, reason: 'balance-unavailable-allowed' });
});

test('decide: local by default, escalate on trigger only when the gate passes', () => {
  const cfg = normalizeConfig({ escalateToolErrors: 2, escalateAfterStep: 6 });
  const state = { toolErrors: 0, repeatedCalls: 0, localErrors: 0, cloud: false, cloudReason: '' };
  assert.deepEqual(decide(cfg, state, 1, { ok: true }), { action: 'local', reason: 'local-first' });

  state.toolErrors = 1;
  assert.deepEqual(decide(cfg, state, 2, { ok: true }), { action: 'local', reason: 'local-first' });

  state.toolErrors = 2;
  assert.deepEqual(decide(cfg, state, 2, { ok: false, reason: 'peak-hours' }), { action: 'local', reason: 'blocked:peak-hours<-tool-errors' });
  assert.deepEqual(decide(cfg, state, 2, { ok: true }), { action: 'cloud', reason: 'tool-errors' });
});

test('decide: sticky escalation survives later steps in the same turn', () => {
  const cfg = normalizeConfig({});
  const state = { toolErrors: 3, repeatedCalls: 0, localErrors: 0, cloud: true, cloudReason: 'tool-errors' };
  assert.deepEqual(decide(cfg, state, 9, { ok: false }), { action: 'cloud', reason: 'tool-errors+sticky' });
});

test('decide: long turn triggers escalation', () => {
  const cfg = normalizeConfig({ escalateAfterStep: 3 });
  const state = { toolErrors: 0, repeatedCalls: 0, localErrors: 0, cloud: false, cloudReason: '' };
  assert.deepEqual(decide(cfg, state, 3, { ok: true }), { action: 'cloud', reason: 'long-turn' });
});

test('forced local: global switch and workspace path matching', () => {
  const byPath = normalizeConfig({ forceLocalPaths: ['C:\\Users\\x\\workspace-qq'] });
  assert.equal(isForcedLocal(byPath, 'C:\\Users\\x\\workspace-qq'), true);
  assert.equal(isForcedLocal(byPath, 'C:/Users/X/workspace-qq/'), true);
  assert.equal(isForcedLocal(byPath, 'C:\\Users\\x\\profiles\\qqchat'), false);
  assert.equal(isForcedLocal(normalizeConfig({ forceLocal: true }), 'C:\\anything'), true);
  assert.equal(isForcedLocal(normalizeConfig({}), 'C:\\anything'), false);
});
