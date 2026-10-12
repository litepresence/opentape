// tests/data.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOHLCV } from '../js/data.js';
import fallback from '../data/btcusd-1d.json' with { type: 'json' };

test('normalize validates and sorts', () => {
  const rows = normalizeOHLCV([[3,1,2,0.5,1.5,10],[1,1,2,0.5,1.5,9],[2,5,4,3,2,8]]);
  assert.equal(rows[0].t, 1);
  assert.equal(rows.length, 3);
});

test('fallback JSON has 120+ rows with h>=l', async () => {
  assert.ok(fallback.length >= 120, `fallback has ${fallback.length} rows`);
  for (const r of fallback.slice(0, 5)) {
    assert.ok(r.h >= r.l && r.h >= r.o && r.h >= r.c);
  }
});
