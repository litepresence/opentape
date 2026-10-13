// tests/ccxt-load.test.mjs — live-only load contract: no substitution, and
// failures surface as errors the UI can show (never as another market's bars).
import test from 'node:test';
import assert from 'node:assert/strict';
import { whenCcxt, fetchOHLCV } from '../js/data.js';

const withGlobals = async (patch, fn) => {
  const g = globalThis;
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = { had: k in g, val: g[k] };
  for (const [k, val] of Object.entries(patch)) {
    if (val === undefined) delete g[k]; else g[k] = val;
  }
  try { return await fn(g); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k].had) g[k] = saved[k].val; else delete g[k];
    }
  }
};

test('sticky settle: a missed ccxt-ready never hangs later callers', { timeout: 3000 }, async () => {
  await withGlobals({ ccxt: undefined, document: { addEventListener() {} } }, async () => {
    const t0 = Date.now();
    assert.equal(await whenCcxt(50), undefined, 'blocked bundle settles as undefined');
    assert.ok(Date.now() - t0 < 2000, 'first settle is prompt');
    const t1 = Date.now();
    assert.equal(await whenCcxt(), undefined, 'sticky flag short-circuits the default timeout');
    assert.ok(Date.now() - t1 < 2000, 'second call is prompt');
  });
});

test('unavailable bundle rejects instead of substituting rows', { timeout: 3000 }, async () => {
  await withGlobals({ ccxt: undefined, document: { addEventListener() {} } }, async () => {
    await assert.rejects(
      () => fetchOHLCV({ symbol: 'BTC/USD', timeframe: '1d', limit: 2, timeoutMs: 50 }),
      /unavailable/i);
  });
});

test('venue errors surface with the venue named', { timeout: 3000 }, async () => {
  await withGlobals({
    ccxt: { binance: class { constructor() {} async fetchOHLCV() { throw new Error('bad symbol'); } } },
  }, async () => {
    await assert.rejects(
      () => fetchOHLCV({ symbol: 'BTC/USD', timeframe: '1d', limit: 2 }),
      /binance: bad symbol/);
  });
});

test('empty venue response rejects rather than painting nothing silently', { timeout: 3000 }, async () => {
  await withGlobals({ ccxt: { binance: class { constructor() {} async fetchOHLCV() { return []; } } } }, async () => {
    await assert.rejects(() => fetchOHLCV({ symbol: 'BTC/USD', timeframe: '1d', limit: 2 }), /no data/i);
  });
});

test('live success returns normalized rows', { timeout: 3000 }, async () => {
  const raw = [[1700000000000, 1, 2, 0.5, 1.5, 10], [1700086400000, 1.5, 2.5, 1, 2, 11]];
  await withGlobals({ ccxt: { binance: class { constructor() {} async fetchOHLCV() { return raw; } } } }, async () => {
    const rows = await fetchOHLCV({ symbol: 'BTC/USD', timeframe: '1d', limit: 2 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].c, 1.5);
  });
});
