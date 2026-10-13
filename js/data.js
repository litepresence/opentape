export function normalizeOHLCV(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const num = (v) => (typeof v === 'number' ? v : Number(v));
  return (Array.isArray(raw[0]) ? raw.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })) : raw)
    .map((r) => r && { t: num(r.t), o: num(r.o), h: num(r.h), l: num(r.l), c: num(r.c), v: num(r.v) })
    // Every price field must be finite and h must span l/o/c: a NaN open or
    // close would otherwise render as a phantom bar and skew the volume scale.
    .filter((r) => r
      && Number.isFinite(r.t) && Number.isFinite(r.o) && Number.isFinite(r.h)
      && Number.isFinite(r.l) && Number.isFinite(r.c)
      && r.h >= r.l && r.h >= r.o && r.h >= r.c && r.l <= r.o && r.l <= r.c)
    .map((r) => ({ ...r, v: Number.isFinite(r.v) ? r.v : 0 }))
    .sort((a, b) => a.t - b.t);
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
let ccxtSettled = false;
export function whenCcxt(timeoutMs = 15000) {
  if (ccxtSettled) return Promise.resolve(globalThis.ccxt);
  if (typeof globalThis.ccxt !== 'undefined') { ccxtSettled = true; return Promise.resolve(globalThis.ccxt); }
  if (!ccxtReady) {
    ccxtReady = new Promise((resolve) => {
      if (typeof document !== 'undefined') {
        let done = false;
        const settle = (v) => { if (!done) { done = true; ccxtSettled = true; resolve(v); } };
        document.addEventListener('ccxt-ready', () => settle(globalThis.ccxt), { once: true });
        setTimeout(() => settle(undefined), timeoutMs);
      }
      else { ccxtSettled = true; resolve(undefined); }
    });
  }
  return ccxtReady;
}

/**
 * Fetch OHLCV via browser CCXT. Live public data only — there is no embedded
 * or cached dataset, so a failure must surface as an error rather than
 * silently painting another market's bars under the current header.
 * @param {object} opts
 * @throws when the bundle is unavailable, the venue rejects the request, or
 *   the response normalizes to zero rows.
 */
export async function fetchOHLCV({ symbol = 'BTC/USD', timeframe = '1d', limit = 300, timeoutMs = 15000 } = {}) {
  const { exchange, ccxtSymbol } = resolveMarket(symbol);
  const cc = typeof globalThis.ccxt !== 'undefined' ? globalThis.ccxt : await whenCcxt(timeoutMs);
  if (!cc || typeof cc[exchange] !== 'function') throw new Error('Market data library unavailable');
  const ex = new cc[exchange]({ enableRateLimit: true });
  let raw;
  try {
    raw = await ex.fetchOHLCV(ccxtSymbol, timeframe, undefined, Math.min(limit, 1000));
  } catch (e) {
    throw new Error(`${exchange}: ${e?.message ?? e}`);
  }
  const rows = normalizeOHLCV(raw);
  if (!rows.length) throw new Error(`${exchange} returned no data for ${ccxtSymbol}`);
  return rows;
}