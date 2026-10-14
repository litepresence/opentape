import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandle, watchCandles } from '../js/data.js';

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

test('watchCandles streams WS candles and stops', async () => {
  const seen = [];
  const statuses = [];
  const fake = {
    has: { watchOHLCV: true },
    watchOHLCV: async () => { await new Promise((r) => setTimeout(r, 5)); return [[7, 1, 2, 0.5, 1.5, 10]]; },
    close: async () => {},
  };
  const sub = watchCandles({
    symbol: 'BTC/USD', timeframe: '1d',
    createExchange: async () => fake,
    onCandle: (c) => seen.push(c),
    onStatus: (s) => statuses.push(s),
  });
  await new Promise((r) => setTimeout(r, 30));
  sub.stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(seen.length >= 1);
  assert.deepEqual(seen[0], { t: 7, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
  assert.ok(statuses.includes('live'));
});

test('watchCandles falls back to polling when WS is unsupported', async () => {
  let polls = 0;
  const fake = { has: {}, close: async () => {} };
  const sub = watchCandles({
    symbol: 'BTC/USD', timeframe: '1d', pollMs: 10,
    createExchange: async () => fake,
    pollOnce: async () => { polls += 1; return [{ t: 9, o: 1, h: 1, l: 1, c: 1, v: 1 }]; },
    onCandle: () => {},
    onStatus: () => {},
  });
  await new Promise((r) => setTimeout(r, 45));
  sub.stop();
  assert.ok(polls >= 2);
});
