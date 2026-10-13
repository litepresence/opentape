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

test('exchange param composes a qualified symbol', () => {
  assert.deepEqual(parseChartUrl('?exchange=coinbase&symbol=BTC/USD&interval=D'),
    { exchange: 'coinbase', symbol: 'coinbase:BTC/USD', interval: '1d', timeframe: '1D' });
});
test('an explicit symbol prefix wins over the exchange param', () => {
  const r = parseChartUrl('?exchange=binance&symbol=bitstamp:BTC/USD');
  assert.equal(r.symbol, 'bitstamp:BTC/USD');
});
test('formatChartUrl emits the exchange', () => {
  assert.equal(formatChartUrl({ symbol: 'BTC/USD', interval: '1d', exchange: 'binance' }),
    '?symbol=BTC%2FUSD&interval=1d&exchange=binance');
});
test('a bogus exchange param is ignored', () => {
  assert.equal(parseChartUrl('?exchange=..%2Fevil&symbol=BTC/USD').exchange, undefined);
});
