// tests/ccxt-fallback.test.mjs — regression for review findings 1+2:
// first paint must never wait on whenCcxt; fetchOHLCV must track provenance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { whenCcxt, fetchOHLCV, wasLive } from '../js/data.js';

test('sticky settle: second whenCcxt() with default timeout resolves fast after CDN-blocked settle', { timeout: 3000 }, async () => {
  const g = globalThis;
  const hadCcxt = 'ccxt' in g;
  const origCcxt = g.ccxt;
  const hadDoc = 'document' in g;
  const origDoc = g.document;
  delete g.ccxt;
  // CDN blocked: document exists but never fires ccxt-ready.
  g.document = { addEventListener() {} };
  try {
    const t0 = Date.now();
    const first = await whenCcxt(50);
    assert.equal(first, undefined);
    const dt1 = Date.now() - t0;
    assert.ok(dt1 < 2000, `first settle fast, took ${dt1}ms`);
    // Missed pre-attach event must never hang boot: default-timeout call
    // checks the sticky flag first and resolves immediately.
    const t1 = Date.now();
    const second = await whenCcxt();
    const dt2 = Date.now() - t1;
    assert.equal(second, undefined);
    assert.ok(dt2 < 2000, `sticky second call fast, took ${dt2}ms`);
  } finally {
    if (hadCcxt) g.ccxt = origCcxt; else delete g.ccxt;
    if (hadDoc) g.document = origDoc; else delete g.document;
  }
});

test('fallback paint path resolves <2s with CDN blocked and wasLive() is false', { timeout: 3000 }, async () => {
  const g = globalThis;
  const hadCcxt = 'ccxt' in g;
  const origCcxt = g.ccxt;
  const hadDoc = 'document' in g;
  const origDoc = g.document;
  const hadFetch = 'fetch' in g;
  const origFetch = g.fetch;
  delete g.ccxt;
  g.document = { addEventListener() {} };
  const fakeRows = [[1700000000000, 100, 110, 90, 105, 10], [1700086400000, 105, 115, 95, 110, 12]];
  g.fetch = async () => ({ json: async () => fakeRows });
  try {
    const t0 = Date.now();
    // Use the timeout param so the suite stays fast even on cold module state.
    const rows = await fetchOHLCV({ symbol: 'BADSYM/USD', timeframe: '1d', limit: 2, timeoutMs: 50 });
    const dt = Date.now() - t0;
    assert.ok(Array.isArray(rows) && rows.length === 2, 'fallback rows returned');
    assert.ok(dt < 2000, `fallback paint path fast, took ${dt}ms`);
    assert.equal(wasLive(), false, 'fallback substitution must not be marked live');
  } finally {
    if (hadCcxt) g.ccxt = origCcxt; else delete g.ccxt;
    if (hadDoc) g.document = origDoc; else delete g.document;
    if (hadFetch) g.fetch = origFetch; else delete g.fetch;
  }
});

test('live success sets wasLive() true and keeps rows shape (array)', { timeout: 3000 }, async () => {
  const g = globalThis;
  const hadCcxt = 'ccxt' in g;
  const origCcxt = g.ccxt;
  const liveRaw = [[1700000000000, 1, 2, 0.5, 1.5, 10], [1700086400000, 1.5, 2.5, 1, 2, 11]];
  g.ccxt = { binance: class { constructor() {} async fetchOHLCV() { return liveRaw; } } };
  try {
    const rows = await fetchOHLCV({ symbol: 'BTC/USD', timeframe: '1d', limit: 2, timeoutMs: 50 });
    assert.ok(Array.isArray(rows), 'default return shape unchanged (rows array)');
    assert.equal(rows.length, 2);
    assert.equal(wasLive(), true, 'live success must be marked live');
  } finally {
    if (hadCcxt) g.ccxt = origCcxt; else delete g.ccxt;
  }
});
