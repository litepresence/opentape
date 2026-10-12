// tests/indicators.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi } from '../js/indicators.js';
test('sma averages', () => {
  const rows = [{ c: 1 }, { c: 2 }, { c: 3 }];
  assert.deepEqual(sma(rows, 2), [null, 1.5, 2.5]);
});
test('rsi bounds 0-100', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ c: 100 + i }));
  assert.ok(rsi(rows, 14).at(-1) > 90);
});
