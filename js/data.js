export function normalizeOHLCV(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const rows = (Array.isArray(raw[0]) ? raw.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })) : raw)
    .filter(r => r && Number.isFinite(r.t) && Number.isFinite(r.h) && Number.isFinite(r.l) && r.h >= r.l)
    .sort((a, b) => a.t - b.t);
  return rows;
}

export async function fetchOHLCV({ symbol = 'BTC/USD', timeframe = '1d', limit = 300 } = {}) {
  try {
    const r = await fetch(`/api/ohlcv?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}`);
    if (!r.ok) throw new Error('proxy ' + r.status);
    return normalizeOHLCV(await r.json());
  } catch (e) {
    const fb = await fetch('./data/btcusd-1d.json').then(x => x.json());
    console.warn('Live data unavailable — showing cached', e?.message ?? e);
    return normalizeOHLCV(fb);
  }
}
