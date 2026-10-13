// tests/ccxt-data.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMarket, normalizeOHLCV } from '../js/data.js';

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
