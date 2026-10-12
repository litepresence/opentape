// tests/chart.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { xForTime, yForPrice, niceTicks } from '../js/chart.js';
test('x maps time linearly', () => {
  assert.equal(xForTime(50, { from: 0, to: 100 }, 0, 200), 100);
});
test('y inverts price', () => {
  assert.ok(yForPrice(75, { min: 50, max: 100 }, 0, 200) < yForPrice(60, { min: 50, max: 100 }, 0, 200));
});
test('niceTicks returns 5-8 round levels', () => {
  const t = niceTicks(56000, 90000);
  assert.ok(t.length >= 5 && t[0] % 2000 === 0);
});
