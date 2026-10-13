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
