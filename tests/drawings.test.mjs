// tests/drawings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapPrice, serialize } from '../js/drawings.js';
test('magnet snaps to nearest OHL within tolerance', () => {
  const rows = [{ o: 100, h: 110, l: 90, c: 105 }];
  assert.equal(snapPrice(109, rows, 2), 110);
  assert.equal(snapPrice(50, rows, 2), 50);
});
test('serialize round-trips', () => {
  const d = [{ id: 'a', type: 'trend', p1: { t: 1, p: 2 } }];
  assert.deepEqual(JSON.parse(serialize(d)), d);
});
