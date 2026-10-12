// server/proxy.js — Node http + ccxt.bitstamp, 60s cache
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import ccxt from 'ccxt';

const PORT = process.env.PORT || 8787;
const cache = new Map(); // key -> { ts, data }
const exchange = new ccxt.bitstamp({ enableRateLimit: true });

function send(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extra });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/ohlcv') {
    const symbol = u.searchParams.get('symbol') || 'BTC/USD';
    const timeframe = u.searchParams.get('timeframe') || '1d';
    const limit = Math.min(Number(u.searchParams.get('limit')) || 300, 1000);
    const key = `${symbol}|${timeframe}|${limit}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < 60000) {
      return send(res, 200, hit.data, { 'X-Cache': 'HIT' });
    }
    try {
      const raw = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      const data = raw.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
      cache.set(key, { ts: Date.now(), data });
      return send(res, 200, data, { 'X-Cache': 'MISS' });
    } catch (e) {
      if (hit) return send(res, 200, hit.data, { 'X-Cache': 'STALE' });
      return send(res, 502, { error: String(e.message || e) });
    }
  }
  if (u.pathname === '/' || u.pathname === '/health') {
    return send(res, 200, { ok: true });
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`proxy on http://localhost:${PORT}`));
