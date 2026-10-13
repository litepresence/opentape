export function normalizeOHLCV(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const rows = (Array.isArray(raw[0]) ? raw.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })) : raw)
    .filter(r => r && Number.isFinite(r.t) && Number.isFinite(r.h) && Number.isFinite(r.l) && r.h >= r.l)
    .sort((a, b) => a.t - b.t);
  return rows;
}

export const DEFAULT_EXCHANGE = 'binance';
export function resolveMarket(symbol) {
  const s = String(symbol || 'BTC/USD');
  const m = s.match(/^([a-z0-9_]+):(.+)$/i);
  if (m) return { exchange: m[1].toLowerCase(), ccxtSymbol: m[2] };
  if (s === 'BTC/USD') return { exchange: 'binance', ccxtSymbol: 'BTC/USDT' };
  if (s === 'ETH/USD') return { exchange: 'binance', ccxtSymbol: 'ETH/USDT' };
  return { exchange: DEFAULT_EXCHANGE, ccxtSymbol: s };
}

let ccxtReady = null;
export function whenCcxt(timeoutMs = 15000) {
  if (typeof globalThis.ccxt !== 'undefined') return Promise.resolve(globalThis.ccxt);
  if (!ccxtReady) {
    ccxtReady = new Promise((resolve) => {
      if (typeof document !== 'undefined') {
        let done = false;
        const settle = (v) => { if (!done) { done = true; resolve(v); } };
        document.addEventListener('ccxt-ready', () => settle(globalThis.ccxt), { once: true });
        setTimeout(() => settle(undefined), timeoutMs);
      }
      else resolve(undefined);
    });
  }
  return ccxtReady;
}

/**
 * Fetch OHLCV via browser CCXT, falling back to embedded BTC-daily JSON.
 * @param {object} opts
 * @param {boolean} [opts.liveOnly=false] - when true, skip the embedded
 *   fallback and rethrow on failure (choice: throw, so callers can
 *   distinguish offline from cached data; e.g. watchlist renders em-dash).
 */
export async function fetchOHLCV({ symbol = 'BTC/USD', timeframe = '1d', limit = 300, liveOnly = false } = {}) {
  const { exchange, ccxtSymbol } = resolveMarket(symbol);
  try {
    const cc = typeof globalThis.ccxt !== 'undefined' ? globalThis.ccxt : await whenCcxt();
    if (!cc || typeof cc[exchange] !== 'function') throw new Error('ccxt unavailable');
    const ex = new cc[exchange]({ enableRateLimit: true });
    const raw = await ex.fetchOHLCV(ccxtSymbol, timeframe, undefined, Math.min(limit, 1000));
    const rows = normalizeOHLCV(raw);
    if (!rows.length) throw new Error('empty');
    return rows;
  } catch (e) {
    if (liveOnly) throw e;
    const fb = await fetch('./data/btcusd-1d.json').then(x => x.json());
    console.warn('Live data unavailable — showing cached', e?.message ?? e);
    return normalizeOHLCV(fb);
  }
}
