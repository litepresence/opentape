// server/proxy.js — Node http + ccxt.bitstamp, 60s cache + static for DoD flow
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ccxt from 'ccxt';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const PORT = process.env.PORT || 8787;
const cache = new Map(); // key -> { ts, data }
const exchange = new ccxt.bitstamp({ enableRateLimit: true });

function send(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extra });
  res.end(body);
}

// Static allowlist: exactly /, /index.html, /styles.css, /js/*, /data/*,
// /indicators/*. Dot-segments (/(^|/)\./) are denied with 404.
export function staticDecision(pathname) {
  if (/(^|\/)\./.test(pathname)) return 404;
  if (pathname === '/' || pathname === '/index.html' || pathname === '/styles.css') return 200;
  if (pathname.startsWith('/js/') || pathname.startsWith('/data/') || pathname.startsWith('/indicators/')) return 200;
  return 404;
}

export const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/ohlcv') {
    const symbol = u.searchParams.get('symbol') || 'BTC/USD';
    const timeframe = u.searchParams.get('timeframe') || '1d';
    const limit = Math.max(1, Math.min(Number(u.searchParams.get('limit')) || 300, 1000));
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
      return send(res, 502, { error: String(e?.message ?? e) });
    }
  }
  if (u.pathname === '/health') {
    return send(res, 200, { ok: true });
  }
  // Minimal static serving so `node server/proxy.js` + http://localhost:8787/ works
  // (ES modules are blocked on file://). Directory-traversal-safe + allowlisted.
  if (req.method === 'GET') {
    if (staticDecision(u.pathname) !== 200) {
      res.writeHead(404); res.end('not found'); return;
    }
    try {
      const rel = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
      const fsPath = path.normalize(path.join(ROOT, rel));
      if (fsPath !== ROOT && !fsPath.startsWith(ROOT + path.sep)) {
        res.writeHead(403); res.end('forbidden'); return;
      }
      const body = await readFile(fsPath);
      const ext = path.extname(fsPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(body); return;
    } catch {
      res.writeHead(404); res.end('not found'); return;
    }
  }
  res.writeHead(404); res.end('not found');
});

// Only listen when run directly (`node server/proxy.js`), not when imported
// by tests (node --test imports this module for staticDecision).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(PORT, () => console.log(`proxy on http://localhost:${PORT}`));
}
