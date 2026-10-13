// tests/data.test.mjs — normalization contract + no embedded dataset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { normalizeOHLCV } from '../js/data.js';

test('normalize validates and sorts', () => {
  const rows = normalizeOHLCV([[3,1,2,0.5,1.5,10],[1,1,2,0.5,1.5,9],[2,1,2.2,0.5,2,8]]);
  assert.equal(rows[0].t, 1);
  assert.equal(rows.length, 3);
});

test('normalize drops malformed rows (no fake bars)', () => {
  const rows = normalizeOHLCV([[1,1,2,5,1.5,1], [2,1,2,0.5,1.5,1], [3,NaN,2,0.5,1.5,1]]);
  assert.equal(rows.length, 1, 'h<l and non-finite rows are discarded');
});

test('no embedded candle dataset is referenced or shipped', () => {
  const hits = [];
  for (const f of readdirSync('js')) {
    if (readFileSync('js/' + f, 'utf8').includes('btcusd-1d')) hits.push(f);
  }
  if (readFileSync('index.html', 'utf8').includes('btcusd-1d')) hits.push('index.html');
  assert.deepEqual(hits, [], 'embedded fallback must stay deleted — it would mislabel other markets');
});