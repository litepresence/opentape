// tests/url.test.mjs — TV-compatible parameterized URL parsing/formatting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChartUrl, formatChartUrl, normalizeSymbol, normalizeInterval } from '../js/url.js';

test('parses TV-style symbol + interval', () => {
  assert.deepEqual(parseChartUrl('?symbol=BITSTAMP:BTCUSD&interval=D'), {
    symbol: 'bitstamp:BTC/USD', interval: '1d', timeframe: '1D',
  });
});
test('parses plain pair + numeric interval', () => {
  assert.deepEqual(parseChartUrl('?symbol=ETH/USD&interval=60'), {
    symbol: 'ETH/USD', interval: '1h', timeframe: '1H',
  });
});
test('ignores unknown params, empty input', () => {
  assert.deepEqual(parseChartUrl('?foo=bar'), {});
  assert.deepEqual(parseChartUrl(''), {});
  assert.deepEqual(parseChartUrl('?symbol=!!!'), {});
});
test('normalizeSymbol handles prefixes and quote splitting', () => {
  assert.equal(normalizeSymbol('coinbase:BTCUSD'), 'coinbase:BTC/USD');
  assert.equal(normalizeSymbol('BTCUSD'), 'BTC/USD');
  assert.equal(normalizeSymbol('ETH/USD'), 'ETH/USD');
  assert.equal(normalizeSymbol(''), null);
});
test('normalizeInterval maps TV codes and ccxt strings', () => {
  assert.equal(normalizeInterval('D'), '1d');
  assert.equal(normalizeInterval('W'), '1w');
  assert.equal(normalizeInterval('60'), '1h');
  assert.equal(normalizeInterval('1M'), '1M');
  assert.equal(normalizeInterval('bogus'), null);
});
test('formatChartUrl round-trips through parse', () => {
  const url = formatChartUrl({ symbol: 'bitstamp:BTC/USD', interval: '1d' });
  const back = parseChartUrl(url);
  assert.equal(back.symbol, 'bitstamp:BTC/USD');
  assert.equal(back.interval, '1d');
});
