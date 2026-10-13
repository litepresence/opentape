// tests/ccxt-data.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMarket, normalizeOHLCV, whenCcxt } from '../js/data.js';

test('resolveMarket defaults BTC/USD to binance spot', () => {
  assert.deepEqual(resolveMarket('BTC/USD'), { exchange: 'binance', ccxtSymbol: 'BTC/USDT' });
});
test('resolveMarket keeps explicit exchange prefix', () => {
  assert.deepEqual(resolveMarket('coinbase:BTC/USD'), { exchange: 'coinbase', ccxtSymbol: 'BTC/USD' });
});
test('normalizeOHLCV still accepts ccxt array rows', () => {
  const rows = normalizeOHLCV([[1700000000000, 1, 2, 0.5, 1.5, 10]]);
  assert.equal(rows[0].c, 1.5);
});
test('no /api or server references remain in js/', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const hits = [];
  for (const f of readdirSync('js')) {
    const src = readFileSync('js/' + f, 'utf8');
    if (src.includes('/api/ohlcv') || src.includes('server/proxy')) hits.push(f);
  }
  assert.deepEqual(hits, []);
});
test('fetchOHLCV liveOnly:true rejects fast without fallback when ccxt unavailable', { timeout: 3000 }, async () => {
  const { fetchOHLCV } = await import('../js/data.js');
  const g = globalThis;
  const hadCcxt = 'ccxt' in g;
  const origCcxt = g.ccxt;
  const hadDoc = 'document' in g;
  const origDoc = g.document;
  const hadFetch = 'fetch' in g;
  const origFetch = g.fetch;
  delete g.ccxt;
  delete g.document;
  let fetchCalls = 0;
  g.fetch = async () => { fetchCalls++; throw new Error('fallback must not be fetched'); };
  const t0 = Date.now();
  try {
    let threw = false;
    try {
      await fetchOHLCV({ symbol: 'ETH/USD', timeframe: '1d', limit: 2, liveOnly: true });
    } catch { threw = true; }
    assert.equal(threw, true, 'liveOnly should reject when ccxt unavailable');
    assert.equal(fetchCalls, 0, 'liveOnly must skip embedded fallback fetch');
    assert.ok(Date.now() - t0 < 2000, 'liveOnly fails fast without fallback');
  } finally {
    if (hadCcxt) g.ccxt = origCcxt; else delete g.ccxt;
    if (hadDoc) g.document = origDoc; else delete g.document;
    if (hadFetch) g.fetch = origFetch; else delete g.fetch;
  }
});
test('whenCcxt resolves (not hangs) when CDN blocked', { timeout: 3000 }, async () => {
  const g = globalThis;
  const hadDoc = 'document' in g;
  const origDoc = g.document;
  g.document = { addEventListener() {} };
  try {
    const r = await whenCcxt(50);
    assert.equal(r, undefined);
  } finally {
    if (hadDoc) g.document = origDoc; else delete g.document;
  }
});
