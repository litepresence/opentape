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

// Fold one live candle into rows (pure — returns a new array, or the input
// reference when the candle is older than everything held).
export function mergeCandle(rows, candle, cap = 2000) {
  const list = Array.isArray(rows) ? rows : [];
  if (!candle || !Number.isFinite(candle.t)) return list;
  const last = list[list.length - 1];
  if (last && candle.t === last.t) {
    const next = list.slice();
    next[next.length - 1] = {
      ...last,
      h: Math.max(last.h, candle.h),
      l: Math.min(last.l, candle.l),
      c: candle.c,
      v: candle.v,
    };
    return next;
  }
  if (last && candle.t < last.t) return list;
  const next = [...list, { ...candle }];
  while (next.length > cap) next.shift();
  return next;
}

const TF_MS = { '1m': 6e4, '2m': 12e4, '3m': 18e4, '5m': 3e5, '10m': 6e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '12h': 432e5, '1d': 864e5, '5d': 432e6, '24h': 864e5, '1w': 6048e5, '1wk': 6048e5, '1mo': 2592e6, '3mo': 7776e6, '1M': 2592e6 };
export const timeframeMs = (tf) => TF_MS[String(tf)] || 864e5;

// Live candle subscription. WS (ccxt.pro watchOHLCV) when the exchange
// supports it, else REST polling. Never throws out — transport problems are
// reported via onStatus and retried with backoff.
export function watchCandles({ symbol = 'BTC/USD', timeframe = '1d', onCandle, onStatus, createExchange, pollOnce, pollMs } = {}) {
  let stopped = false;
  let exchange = null;
  const status = (s, d) => { try { onStatus && onStatus(s, d); } catch {} };
  const emit = (raw) => {
    const row = Array.isArray(raw)
      ? normalizeOHLCV([raw])[0]
      : raw;
    if (row && Number.isFinite(row.t)) { try { onCandle && onCandle(row); } catch {} }
  };
  const defaultExchange = async () => {
    const { exchange: exId, ccxtSymbol } = resolveMarket(symbol);
    const cc = typeof globalThis.ccxt !== 'undefined' ? globalThis.ccxt : await whenCcxt();
    if (!cc || typeof cc[exId] !== 'function') throw new Error('Market data library unavailable');
    return { instance: new cc[exId]({ enableRateLimit: true }), ccxtSymbol, exId };
  };
  const wsLoop = async (inst, ccxtSymbol) => {
    let backoff = 1000;
    while (!stopped) {
      try {
        const candles = await inst.watchOHLCV(ccxtSymbol, timeframe);
        backoff = 1000;
        if (stopped) break;
        const lastCandle = Array.isArray(candles) ? candles[candles.length - 1] : null;
        if (lastCandle) emit(lastCandle);
        status('live');
      } catch (e) {
        if (stopped) break;
        status('offline', e?.message ?? String(e));
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  };
  const pollLoop = async (fetchLast) => {
    const interval = Number.isFinite(+pollMs) && +pollMs > 0
      ? +pollMs
      : Math.min(120000, Math.max(10000, Math.round(timeframeMs(timeframe) / 6)));
    status('polling');
    while (!stopped) {
      try {
        const lastRows = await fetchLast();
        if (stopped) break;
        if (Array.isArray(lastRows) && lastRows.length) emit(lastRows[lastRows.length - 1]);
      } catch (e) {
        if (!stopped) status('offline', e?.message ?? String(e));
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  };
  (async () => {
    try {
      const made = createExchange
        ? { instance: await createExchange(), ccxtSymbol: symbol }
        : await defaultExchange();
      if (stopped) return;
      exchange = made.instance;
      const supportsWs = !!(exchange && exchange.has && exchange.has.watchOHLCV);
      if (supportsWs && typeof exchange.watchOHLCV === 'function') {
        status('live');
        wsLoop(exchange, made.ccxtSymbol);
      } else if (pollOnce) {
        pollLoop(pollOnce);
      } else {
        pollLoop(async () => fetchOHLCV({ symbol, timeframe, limit: 2, liveOnly: true }));
      }
    } catch (e) {
      if (!stopped) status('offline', e?.message ?? String(e));
    }
  })();
  return {
    stop() {
      stopped = true;
      try { exchange && exchange.close && exchange.close(); } catch {}
    },
  };
}