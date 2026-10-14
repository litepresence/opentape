import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandle } from '../js/data.js';

test('mergeCandle updates the forming candle on same t', () => {
  const rows = [{ t: 1, o: 10, h: 11, l: 9, c: 10.5, v: 5 }];
  const out = mergeCandle(rows, { t: 1, o: 10, h: 12, l: 8, c: 11, v: 7 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { t: 1, o: 10, h: 12, l: 8, c: 11, v: 7 });
});

test('mergeCandle appends a new candle and caps length', () => {
  const rows = [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: 2, o: 2, h: 2, l: 2, c: 2, v: 2 }];
  const out = mergeCandle(rows, { t: 3, o: 3, h: 3, l: 3, c: 3, v: 3 }, 3);
  assert.equal(out.map((r) => r.t).join(','), '1,2,3');
  const capped = mergeCandle(out, { t: 4, o: 4, h: 4, l: 4, c: 4, v: 4 }, 3);
  assert.equal(capped.map((r) => r.t).join(','), '2,3,4');
});

test('mergeCandle ignores older candles and does not mutate input', () => {
  const rows = [{ t: 5, o: 1, h: 1, l: 1, c: 1, v: 1 }];
  const out = mergeCandle(rows, { t: 4, o: 9, h: 9, l: 9, c: 9, v: 9 });
  assert.equal(out, rows);
  assert.equal(rows[0].c, 1);
});
