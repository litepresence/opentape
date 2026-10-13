// js/url.js — parameterized chart URLs, TradingView-compatible.
// Reads TV-style (?symbol=BITSTAMP:BTCUSD&interval=D) and our canonical form
// (?symbol=BTC/USD&interval=1d); writes canonical form for shareable links.
// Pure module: no DOM, fully unit-testable.
const TV_INTERVAL_TO_CCXT = {
  '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
  '60': '1h', '120': '2h', '240': '4h', 'D': '1d', 'W': '1w', 'M': '1M',
};
const CCXT_TO_LABEL = { '1d': '1D', '1w': '1W', '1h': '1H' };

export function normalizeSymbol(input) {
  let s = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  // TV-style exchange prefix first (BITSTAMP:BTCUSD, coinbase:ETH/USD).
  let prefix = '';
  const ci = s.indexOf(':');
  if (ci > 0 && /^[A-Z0-9_]+$/.test(s.slice(0, ci))) {
    prefix = s.slice(0, ci).toLowerCase() + ':';
    s = s.slice(ci + 1);
  }
  if (!s || !/^[A-Z0-9./-]+$/.test(s)) return null;
  let body = s;
  if (!s.includes('/')) {
    for (const q of ['USDT', 'USD', 'EUR', 'BTC']) {
      if (s.length > q.length && s.endsWith(q)) { body = s.slice(0, -q.length) + '/' + q; break; }
    }
  }
  return prefix + body;
}

export function normalizeInterval(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (TV_INTERVAL_TO_CCXT[s]) return TV_INTERVAL_TO_CCXT[s];
  const low = s.toLowerCase();
  const known = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1M'];
  if (known.includes(low) || known.includes(s)) return known.includes(s) ? s : low;
  const m = low.match(/^(\d+)(m|h|d|w)$/);
  if (m) return m[1] + (m[2] === 'd' ? 'd' : m[2] === 'w' ? 'w' : m[2] === 'h' ? 'h' : 'm');
  return null;
}

export function parseChartUrl(search) {
  const out = {};
  let q = String(search || '');
  if (q.startsWith('?')) q = q.slice(1);
  const params = new URLSearchParams(q);
  const ex = String(params.get('exchange') || '').trim().toLowerCase();
  if (/^[a-z][a-z0-9_]*$/.test(ex)) out.exchange = ex;
  let sym = normalizeSymbol(params.get('symbol'));
  // ?exchange=coinbase&symbol=BTC/USD composes the qualified form the router uses
  if (sym && ex && !sym.includes(':')) sym = `${ex}:${sym}`;
  if (sym) out.symbol = sym;
  const tf = normalizeInterval(params.get('interval') || params.get('timeframe'));
  if (tf) {
    out.interval = tf;
    if (CCXT_TO_LABEL[tf]) out.timeframe = CCXT_TO_LABEL[tf];
  }
  return out;
}

export function formatChartUrl({ symbol, interval, exchange }) {
  const p = new URLSearchParams();
  if (symbol) p.set('symbol', symbol);
  if (interval) p.set('interval', interval);
  if (exchange) p.set('exchange', exchange);
  const s = p.toString();
  return s ? '?' + s : '';
}
