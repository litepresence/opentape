# TradingView Desktop Clone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pixel-faithful, fully functional BTCUSD 1D TradingView desktop clone in vanilla HTML/JS/Canvas with Node+CCXT proxy.

**Architecture:** Two stacked canvases (base + overlay) driven by a single ViewState module; HTML/CSS chrome for topbar/rail/axes; Node http proxy using ccxt.bitstamp with 60s cache and embedded JSON fallback.

**Tech Stack:** Vanilla HTML/CSS/JS (no frameworks, no chart libs), Node 20 http, `ccxt` npm (server only), `playwright` + Chromium (dev tooling only, screenshots/diff).

## Global Constraints

- Vanilla only: no React/Vue/Tailwind, no chart libs. `ccxt` allowed only in `server/`.
- Canvas text font must be `-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif`.
- Candle colors: up `#089981`, down `#F23645`; wicks 1px; body 60% of time-step; volume 40% alpha bottom 15% pane.
- All state mutations go through ViewState then `requestRender()`. No direct canvas writes from UI handlers.
- Tooling scripts live in `tooling/` only. No inline scripts lost on crash.
- Reference ground truth: `Screenshot from 2026-10-12 18-38-59.png`. Target 1920px desktop, fluid responsive.
- Themes via `[data-theme]` CSS vars + canvas palette swap; no flash on toggle.

---

### Task 1: Headless browser harness + reference capture

**Files:**
- Create: `package.json`
- Create: `tooling/capture.js`
- Create: `tooling/shots/.gitkeep`
- Test: `tooling/capture.test.mjs`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `captureClone(url, outPath, viewport)` → saves PNG; used by Tasks 4,8 for visual verification.

- [ ] **Step 1: Write the failing test**

```js
// tooling/capture.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { captureClone } from './capture.js';

test('captureClone saves a PNG', async () => {
  const out = 'tooling/shots/smoke.png';
  await captureClone('about:blank', out, { width: 1280, height: 800 });
  assert.ok(existsSync(out), 'screenshot file should exist');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm init -y && npm i -D playwright && npx playwright install chromium && node --test tooling/capture.test.mjs`
Expected: FAIL with `Cannot find module './capture.js'` or `captureClone is not a function`.

- [ ] **Step 3: Write minimal implementation**

```json
// package.json (create via npm init -y, then ensure these keys)
{
  "name": "tv-clone",
  "type": "module",
  "scripts": {
    "proxy": "node server/proxy.js",
    "test": "node --test tooling/*.test.mjs tests/*.test.mjs"
  },
  "dependencies": {
    "ccxt": "^4.3.0"
  },
  "devDependencies": {
    "playwright": "^1.49.0"
  }
}
```

```js
// tooling/capture.js
import { chromium } from 'playwright';

export async function captureClone(url, outPath, viewport = { width: 1920, height: 1080 }) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => page.goto(url, { timeout: 30000 }));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: outPath, fullPage: false });
  await browser.close();
  return outPath;
}

// CLI: node tooling/capture.js <url> <out.png> [width] [height]
const [url, out, w, h] = process.argv.slice(2);
if (url && out) {
  await captureClone(url, out, { width: Number(w) || 1920, height: Number(h) || 1080 });
  console.log('saved', out);
}
```

```bash
touch tooling/shots/.gitkeep
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm i && npx playwright install chromium --with-deps 2>&1 | tail -5; node --test tooling/capture.test.mjs`
Expected: PASS (1 passing), `tooling/shots/smoke.png` exists. Also run: `node tooling/capture.js file:///workspace/index.html tooling/shots/clone-1920.png 1920 1080` after Task 3 (may 404 until index exists — that is OK for now; smoke test on about:blank must pass).

- [ ] **Step 5: Commit**

```bash
git add package.json tooling/capture.js tooling/capture.test.mjs tooling/shots/.gitkeep 2>/dev/null || true
git commit -m "chore: add playwright capture harness" 2>/dev/null || echo "no git repo, skip commit"
```

---

### Task 2: Data layer — proxy + fallback JSON

**Files:**
- Create: `server/proxy.js`
- Create: `data/btcusd-1d.json`
- Create: `js/data.js`
- Test: `tests/data.test.mjs`

**Interfaces:**
- Consumes: `captureClone` (for later visual checks only)
- Produces: `GET /api/ohlcv?symbol=BTC/USD&timeframe=1d&limit=300` → `[{t,o,h,l,c,v}]`; `fetchOHLCV(symbol,timeframe)` in `js/data.js` → same shape with fallback.

- [ ] **Step 1: Write the failing test**

```js
// tests/data.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOHLCV } from '../js/data.js';
import fallback from '../data/btcusd-1d.json' with { type: 'json' };

test('normalize validates and sorts', () => {
  const rows = normalizeOHLCV([[3,1,2,0.5,1.5,10],[1,1,2,0.5,1.5,9],[2,5,4,3,2,8]]);
  assert.equal(rows[0].t, 1);
  assert.equal(rows.length, 3);
});

test('fallback JSON has 120+ rows with h>=l', async () => {
  assert.ok(fallback.length >= 120, `fallback has ${fallback.length} rows`);
  for (const r of fallback.slice(0, 5)) {
    assert.ok(r.h >= r.l && r.h >= r.o && r.h >= r.c);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/data.test.mjs`
Expected: FAIL — `Cannot find module '../js/data.js'`, missing JSON.

- [ ] **Step 3: Write minimal implementation**

```js
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
```

```js
// js/data.js
export function normalizeOHLCV(raw) {
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
    console.warn('Live data unavailable — showing cached', e.message);
    return normalizeOHLCV(fb);
  }
}
```

`data/btcusd-1d.json`: created by `tooling/gen-fallback.mjs` below (160 daily rows from 2026-05-01, tracing screenshot: May ~80k chop, Jun 5 volume spike + drop to 64k, Jul 1 low 57.5k, Jul-Aug 62-66k range, Aug 20 breakout 63.6k→86k, Sep 86k top, Oct close 82473).

```js
// tooling/gen-fallback.mjs — run once: node tooling/gen-fallback.mjs
import { writeFileSync } from 'node:fs';
const day = 86400000; let t = Date.UTC(2026, 4, 1); let p = 75500;
const rows = [];
for (let i = 0; i < 160; i++) {
  let drift = 0, vol = 0.6 + Math.random() * 0.8;
  if (i < 25) drift = 200 + Math.random() * 400;                    // May climb to ~82k
  else if (i < 32) { drift = -300; vol = 1.5; }                     // late-May fade
  else if (i < 38) { drift = -2500 - Math.random() * 2000; vol = 3 + Math.random() * 3; } // Jun crash to ~64k
  else if (i < 55) drift = (Math.random() - 0.45) * 900;            // Jun chop 60-66k
  else if (i === 60) { drift = -2500; vol = 2.5; }                  // Jul 1 low
  else if (i < 95) drift = (Math.random() - 0.42) * 700;            // 62-66k range
  else if (i < 105) { drift = 1800 + Math.random() * 1200; vol = 2 + Math.random() * 2; } // Aug 20 breakout
  else if (i < 135) drift = (Math.random() - 0.48) * 900;           // 76-86k high chop
  else drift = (82473 - p) / (160 - i) + (Math.random() - 0.5) * 500; // glide to 82473
  const o = p, c = Math.max(50000, o + drift);
  const h = Math.max(o, c) + Math.random() * 350, l = Math.min(o, c) - Math.random() * 350;
  if (i === 159) { const k = 82473 / c; rows.push({ t, o: o * k, h: h * k, l: l * k, c: 82473, v: 1.32 }); break; }
  rows.push({ t, o: +o.toFixed(0), h: +h.toFixed(0), l: +l.toFixed(0), c: +c.toFixed(0), v: +vol.toFixed(2) });
  p = c; t += day;
}
writeFileSync('data/btcusd-1d.json', JSON.stringify(rows));
console.log('wrote', rows.length, 'rows last=', rows.at(-1));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/data.test.mjs; node server/proxy.js & sleep 2; curl -s "http://localhost:8787/api/ohlcv?symbol=BTC/USD&timeframe=1d&limit=5" | head -c 300; kill %1`
Expected: 2 passing tests; curl returns JSON array (or 502 with error if offline — STALE/HIT path still JSON). Fallback file exists.

- [ ] **Step 5: Commit**

```bash
git add server/proxy.js js/data.js data/btcusd-1d.json tests/data.test.mjs package.json
git commit -m "feat: add ccxt proxy and OHLCV fallback data"
```

---

### Task 3: Shell + themes + static chrome (topbar / rail / footer)

**Files:**
- Create: `index.html`
- Create: `styles.css`
- Create: `js/viewstate.js`
- Create: `js/ui.js`
- Test: `tests/viewstate.test.mjs`

**Interfaces:**
- Consumes: `normalizeOHLCV` (data shape)
- Produces: `ViewState` singleton `{symbol,timeframe,theme,visible,price,drawings,alerts}` + `requestRender(fn)`; `initUI(view)` wires toolbar clicks. Later tasks consume `ViewState.get()/set()`.

- [ ] **Step 1: Write the failing test**

```js
// tests/viewstate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewState } from '../js/viewstate.js';

test('set merges and notifies once', () => {
  const v = ViewState({ symbol: 'BTC/USD' });
  let n = 0; v.subscribe(() => n++);
  v.set({ theme: 'dark' });
  assert.equal(v.get().theme, 'dark');
  assert.equal(n, 1);
});
test('toggleTheme flips light/dark', () => {
  const v = ViewState({ theme: 'light' });
  v.toggleTheme(); assert.equal(v.get().theme, 'dark');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/viewstate.test.mjs`
Expected: FAIL — missing `js/viewstate.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// js/viewstate.js
export function ViewState(initial = {}) {
  let s = { symbol: 'BTC/USD', timeframe: '1D', theme: 'light', visible: null, price: null, drawings: [], alerts: [], replayIndex: null, ...initial };
  const subs = new Set();
  let queued = false; let fn = null;
  return {
    get: () => ({ ...s }),
    set(patch) { s = { ...s, ...patch }; subs.forEach(cb => cb(this.get())); if (fn && !queued) { queued = true; requestAnimationFrame(() => { queued = false; fn(this.get()); }); } },
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    onRender(f) { fn = f; },
    toggleTheme() { this.set({ theme: s.theme === 'light' ? 'dark' : 'light' }); document.documentElement.dataset.theme = s.theme === 'light' ? 'dark' : 'light'; try { localStorage.setItem('tv-theme', s.theme === 'light' ? 'dark' : 'light'); } catch {} },
  };
}
export const view = ViewState({ theme: (typeof localStorage !== 'undefined' && localStorage.getItem('tv-theme')) || 'light' });
```

```html
<!-- index.html — complete minimal shell (chrome only; canvases wired in Task 4/5) -->
<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BTCUSD · TradingView Clone</title><link rel="stylesheet" href="styles.css">
<script>try{document.documentElement.dataset.theme=localStorage.getItem('tv-theme')||'light'}catch(e){}</script>
</head><body>
<header id="topbar"><button id="menu">☰</button><button id="sym">BTCUSD</button><button>💎</button><button>+</button><button>D</button><button id="ctype">🕯</button><button id="ind-btn">Indicators</button><button id="alert-btn">Alert</button><button id="replay-btn">Replay</button><button>↩</button><button>↪</button><span style="flex:1"></span><button id="theme-btn">🌙</button><button>Save ▾</button></header>
<div id="main"><nav id="rail"><button data-tool="cross" class="active">✛</button><button data-tool="trend">╱</button><button data-tool="fib">F</button><button data-tool="brush">🖌</button><button data-tool="shape">▭</button><button data-tool="text">T</button><button data-tool="emoji">🙂</button><button data-tool="ruler">📏</button><button data-tool="zoom">⊕</button><button data-tool="magnet">🧲</button><button data-tool="lock">🔒</button><button data-tool="hide">👁</button><button data-tool="del">🗑</button><button data-tool="measure">📐</button><button data-tool="extra">⋯</button></nav>
<section id="chart-wrap"><div id="ohlc-head"><span>₿ Bitcoin / U.S. Dollar · 1D · Bitstamp</span> <span id="ohlc"></span><span id="sell">82474 SELL</span><span id="buy">82474 BUY</span></div>
<div id="mid"><div id="canvas-stack"><canvas id="base" width="1600" height="800"></canvas><canvas id="overlay" width="1600" height="800"></canvas></div><div id="price-axis"></div></div>
<div id="time-axis"></div>
<footer id="rangebar"><span>1D 5D 1M 3M 6M YTD 1Y 5Y All</span><span style="flex:1"></span><span id="clock">--:--:--</span><span>UTC ⚙</span></footer></section></div>
<script type="module">import {view} from './js/viewstate.js';import {initUI} from './js/ui.js';initUI(view);</script>
</body></html>
```

```css
/* styles.css — must define: :root + [data-theme=dark] vars --bg:#fff/ #131722, --grid:#e0e3eb/#2a2e39, --text:#131722/#d1d4dc, --up:#089981, --down:#F23645; 48px topbar, 48px rail, right axis 72px, bottom axis 28px, footer 32px */
```

```js
// js/ui.js
export function initUI(v) {
  document.documentElement.dataset.theme = v.get().theme;
  document.querySelector('#theme-btn')?.addEventListener('click', () => v.toggleTheme());
  document.querySelectorAll('#rail button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#rail button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); v.set({ tool: b.dataset.tool });
  }));
  setInterval(() => { const el = document.querySelector('#clock'); if (el) el.textContent = new Date().toISOString().slice(11, 19); }, 1000);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/viewstate.test.mjs; node tooling/capture.js file:///workspace/index.html tooling/shots/shell.png 1920 1080 && ls -la tooling/shots/shell.png`
Expected: tests PASS; shell screenshot exists showing topbar + rail boxes (canvases blank until Task 4 — OK).

- [ ] **Step 5: Commit**

```bash
git add index.html styles.css js/viewstate.js js/ui.js tests/viewstate.test.mjs
git commit -m "feat: add shell chrome and theme state"
```

---

### Task 4: Canvas engine — grid, candles, volume, axes

**Files:**
- Create: `js/chart.js`
- Create: `js/axes.js`
- Modify: `js/ui.js` (wire fetch + render)
- Test: `tests/chart.test.mjs`

**Interfaces:**
- Consumes: `ViewState.get()/onRender()`, `fetchOHLCV()`
- Produces: `renderBase(ctx, state, rows, geom)` + `xForTime(t) / yForPrice(p)` helpers used by overlay/drawings.

- [ ] **Step 1: Write the failing test**

```js
// tests/chart.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { xForTime, yForPrice, niceTicks } from '../js/chart.js';
test('x maps time linearly', () => {
  assert.equal(xForTime(50, { from: 0, to: 100 }, 0, 200), 100);
});
test('y inverts price', () => {
  assert.ok(yForPrice(75, { min: 50, max: 100 }, 0, 200) < yForPrice(60, { min: 50, max: 100 }, 0, 200));
});
test('niceTicks returns 5-8 round levels', () => {
  const t = niceTicks(56000, 90000);
  assert.ok(t.length >= 5 && t[0] % 2000 === 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/chart.test.mjs`
Expected: FAIL — no `js/chart.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// js/chart.js
export const PAL = { light: { bg: '#ffffff', grid: '#e0e3eb', text: '#787b86', up: '#089981', down: '#F23645' }, dark: { bg: '#131722', grid: '#2a2e39', text: '#d1d4dc', up: '#089981', down: '#F23645' } };
export function xForTime(t, vis, left, width) { return left + ((t - vis.from) / (vis.to - vis.from)) * width; }
export function yForPrice(p, pr, top, height) { return top + (1 - (p - pr.min) / (pr.max - pr.min)) * height; }
export function niceTicks(min, max, n = 7) { const step0 = (max - min) / n; const mag = 10 ** Math.floor(Math.log10(step0)); const norm = step0 / mag; const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag; const out = []; for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v); return out; }
export function renderBase(ctx, state, rows, geom) {
  const pal = PAL[state.theme] || PAL.light;
  const { left, top, width, height } = geom;
  ctx.fillStyle = pal.bg; ctx.fillRect(left, top, width, height);
  ctx.strokeStyle = pal.grid; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
  for (const p of niceTicks(state.price.min, state.price.max)) { const y = Math.round(yForPrice(p, state.price, top, height)) + .5; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke(); }
  const step = width / Math.max(1, rows.length);
  const bw = Math.max(2, step * 0.6);
  const vh = height * 0.15;
  rows.forEach((r, i) => {
    const x = left + i * step + step / 2;
    const col = r.c >= r.o ? pal.up : pal.down;
    ctx.strokeStyle = col; ctx.setLineDash([]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, yForPrice(r.h, state.price, top, height)); ctx.lineTo(Math.round(x) + .5, yForPrice(r.l, state.price, top, height)); ctx.stroke();
    ctx.fillStyle = col;
    const yO = yForPrice(r.o, state.price, top, height), yC = yForPrice(r.c, state.price, top, height);
    ctx.fillRect(Math.round(x - bw / 2), Math.round(Math.min(yO, yC)), Math.round(bw), Math.max(1, Math.round(Math.abs(yC - yO))));
    ctx.globalAlpha = 0.4;
    const vmax = Math.max(...rows.map(q => q.v));
    const bh = (r.v / vmax) * vh;
    ctx.fillRect(Math.round(x - bw / 2), Math.round(top + height - bh), Math.round(bw), Math.round(bh));
    ctx.globalAlpha = 1;
  });
  // last-price dotted line
  const last = rows[rows.length - 1];
  if (last) { const y = yForPrice(last.c, state.price, top, height); ctx.strokeStyle = pal.down; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke(); ctx.setLineDash([]); }
}
```

`js/axes.js` renders right price labels into `#price-axis` div + bottom month labels into `#time-axis` using `niceTicks` + month boundaries; bold style for values %10000===0.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/chart.test.mjs && node tooling/capture.js file:///workspace/index.html tooling/shots/chart.png 1920 1080`
Expected: 3 PASS; screenshot shows candles + volume (compare eyeball to reference PNG).

- [ ] **Step 5: Commit**

```bash
git add js/chart.js js/axes.js js/ui.js tests/chart.test.mjs
git commit -m "feat: render grid candles volume axes"
```

---

### Task 5: Pan/zoom, crosshair, footer ranges, clock

**Files:**
- Create: `js/overlay.js`
- Modify: `js/ui.js`, `js/viewstate.js` (visible/price init)
- Test: `tests/overlay.test.mjs`

**Interfaces:**
- Consumes: `xForTime/yForPrice`, `ViewState`
- Produces: overlay crosshair + tooltip data `hitTest(mx, rows, geom)` → row index.

- [ ] **Step 1: Write the failing test**

```js
// tests/overlay.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { hitTest } from '../js/overlay.js';
test('hitTest picks nearest candle', () => {
  const rows = [{ t: 0 }, { t: 10 }, { t: 20 }];
  assert.equal(hitTest(105, { from: 0, to: 20 }, 0, 200, rows), 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/overlay.test.mjs`
Expected: FAIL — missing module.

- [ ] **Step 3: Write minimal implementation**

```js
// js/overlay.js
import { xForTime, yForPrice } from './chart.js';
export function hitTest(mx, vis, left, width, rows) {
  const step = width / Math.max(1, rows.length);
  let best = 0, bd = 1e18;
  rows.forEach((r, i) => { const x = left + i * step + step / 2; const d = Math.abs(x - mx); if (d < bd) { bd = d; best = i; } });
  return best;
}
export function drawCrosshair(ctx, mx, my, geom, pal) {
  ctx.save(); ctx.strokeStyle = pal.text; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(mx, geom.top); ctx.lineTo(mx, geom.top + geom.height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(geom.left, my); ctx.lineTo(geom.left + geom.width, my); ctx.stroke(); ctx.restore();
}
```

`ui.js` additions: drag to pan (dx → shift `visible.from/to`), wheel to zoom (factor 0.9/1.1 around cursor, shift+wheel zooms price), dblclick reset, mousemove → crosshair + `#ohlc` text update `O.. H.. L.. C..`, range footer buttons set visible window (1D=last 2 bars … All=full), clock interval already in Task 3.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/overlay.test.mjs`
Expected: PASS. Manual: open index.html, drag pans, wheel zooms, crosshair shows.

- [ ] **Step 5: Commit**

```bash
git add js/overlay.js js/ui.js js/viewstate.js tests/overlay.test.mjs
git commit -m "feat: pan zoom crosshair ranges"
```

---

### Task 6: Drawings + alerts + persistence

**Files:**
- Create: `js/drawings.js`
- Modify: `js/overlay.js`, `js/ui.js`
- Test: `tests/drawings.test.mjs`

**Interfaces:**
- Consumes: `ViewState.drawings/alerts`, `xForTime/yForPrice`
- Produces: `addDrawing(d)`, `snapPrice(p, rows)` (magnet within 8px → OHLC value).

- [ ] **Step 1: Write the failing test**

```js
// tests/drawings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapPrice, serialize } from '../js/drawings.js';
test('magnet snaps to nearest OHL within tolerance', () => {
  const rows = [{ o: 100, h: 110, l: 90, c: 105 }];
  assert.equal(snapPrice(109, rows, 2), 110);
  assert.equal(snapPrice(50, rows, 2), 50);
});
test('serialize round-trips', () => {
  const d = [{ id: 'a', type: 'trend', p1: { t: 1, p: 2 } }];
  assert.deepEqual(JSON.parse(serialize(d)), d);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/drawings.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```js
// js/drawings.js
export function snapPrice(p, rows, tol = 2) {
  let best = null, bd = tol;
  for (const r of rows) for (const v of [r.o, r.h, r.l, r.c]) { const d = Math.abs(v - p); if (d <= bd) { bd = d; best = v; } }
  return best ?? p;
}
export function serialize(drawings) { return JSON.stringify(drawings); }
export function deserialize(s) { try { return JSON.parse(s) || []; } catch { return []; } }
export function addDrawing(view, d) {
  const cur = view.get().drawings; view.set({ drawings: [...cur, { id: 'd' + Date.now(), ...d }] });
  try { localStorage.setItem('tv-clone-layout-v1', serialize(view.get().drawings)); } catch {}
}
```

Overlay draws trend lines (2 clicks), horizontal (price click), fib (high-low retracement levels 0/0.236/0.382/0.5/0.618/1), text (prompt). Undo/redo stacks in ui.js (Ctrl+Z/Y), Delete removes selected, magnet toggle button. Alerts: click price axis adds `{price}` red line draggable; persisted same key.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/drawings.test.mjs`
Expected: PASS; manual: draw trend persists after reload.

- [ ] **Step 5: Commit**

```bash
git add js/drawings.js js/overlay.js js/ui.js tests/drawings.test.mjs
git commit -m "feat: drawings alerts persistence"
```

---

### Task 7: Indicators + replay + symbol/timeframe switching

**Files:**
- Create: `js/indicators.js`
- Modify: `js/chart.js`, `js/ui.js`
- Test: `tests/indicators.test.mjs`

**Interfaces:**
- Consumes: rows, `ViewState.replayIndex`
- Produces: `sma(rows,n)`, `ema(rows,n)`, `rsi(rows,n)` arrays aligned to rows.

- [ ] **Step 1: Write the failing test**

```js
// tests/indicators.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi } from '../js/indicators.js';
test('sma averages', () => {
  const rows = [{ c: 1 }, { c: 2 }, { c: 3 }];
  assert.deepEqual(sma(rows, 2), [null, 1.5, 2.5]);
});
test('rsi bounds 0-100', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ c: 100 + i }));
  assert.ok(rsi(rows, 14).at(-1) > 90);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/indicators.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```js
// js/indicators.js
export function sma(rows, n) { return rows.map((_, i) => i + 1 < n ? null : rows.slice(i + 1 - n, i + 1).reduce((a, r) => a + r.c, 0) / n); }
export function ema(rows, n) { const k = 2 / (n + 1); let e = rows[0]?.c ?? 0; return rows.map((r, i) => { e = i === 0 ? r.c : r.c * k + e * (1 - k); return i + 1 < n ? null : e; }); }
export function rsi(rows, n = 14) {
  let g = 0, l = 0; return rows.map((r, i) => {
    if (i === 0) return null;
    const ch = r.c - rows[i - 1].c; g = (g * (n - 1) + Math.max(0, ch)) / n; l = (l * (n - 1) + Math.max(0, -ch)) / n;
    return i < n ? null : 100 - 100 / (1 + (l === 0 ? 100 : g / l));
  });
}
```

UI: Indicators button opens `<dialog>` with checkboxes SMA20/SMA50/EMA20/RSI → drawn on base canvas (colored lines) / RSI mini-pane. Replay button hides bars after `replayIndex`, step buttons `<-`/`->`. Symbol search input re-calls `fetchOHLCV` + resets visible. Timeframe D/1W/1H maps to ccxt `1d/1w/1h`. Chart-type toggles candles/bars/line in `renderBase`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/indicators.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/indicators.js js/chart.js js/ui.js tests/indicators.test.mjs
git commit -m "feat: indicators replay symbol switching"
```

---

### Task 8: Polish — dark theme, export, verification

**Files:**
- Modify: `styles.css`, `js/chart.js`, `js/ui.js`
- Create: `tooling/verify.mjs`
- Test: `node --test` full suite + screenshots

**Interfaces:**
- Consumes: all prior tasks
- Produces: `verify` script that captures 1920px PNG + checks no console errors.

- [ ] **Step 1: Write the failing test**

```js
// tooling/verify.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = []; page.on('pageerror', e => errors.push(String(e)));
await page.goto(process.argv[2] || 'file:///workspace/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: 'tooling/shots/final-1920.png' });
if (errors.length) { console.error('PAGE ERRORS', errors); process.exit(1); }
console.log('verify ok, no page errors');
await browser.close();
```

Run: `node tooling/verify.mjs file:///workspace/index.html`
Expected: FAIL (console errors or blank canvas) before polish.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tooling/verify.mjs file:///workspace/index.html; echo exit:$?`
Expected: non-zero or missing candles (until Tasks 4-7 done — run this task last).

- [ ] **Step 3: Write minimal implementation**

Polish: `[data-theme=dark]` overrides in styles.css; canvas `PAL.dark` used when `state.theme==='dark'`; PNG export button composites base+overlay via `toDataURL` download; multi-layout Save dropdown (localStorage `tv-layouts`); keyboard shortcuts (`c`=cross, `t`=trend, `f`=fib, `Del`=remove); responsive: rail collapses under 1100px, price-axis 56px under 1400px.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/*.test.mjs tooling/*.test.mjs && node tooling/verify.mjs file:///workspace/index.html && ls -lh tooling/shots/final-1920.png`
Expected: all PASS, final PNG exists, side-by-side vs reference drift eyeballed <2px chrome, no console errors.

- [ ] **Step 5: Commit**

```bash
git add styles.css js/chart.js js/ui.js tooling/verify.mjs tooling/shots/final-1920.png
git commit -m "feat: themes export polish verify"
```

---

## File Map (create order)

`package.json` → `tooling/capture.js` → `server/proxy.js` → `data/btcusd-1d.json` → `js/data.js` → `index.html` → `styles.css` → `js/viewstate.js` → `js/ui.js` → `js/chart.js` → `js/axes.js` → `js/overlay.js` → `js/drawings.js` → `js/indicators.js` → `tooling/verify.mjs` → `js/lib.js` → `js/studies.js`

---

### Task 9: Vendor indicators/ library — wire all 85 studies

**Files:**
- Keep verbatim (already in repo, untracked): `indicators/indicators.js` (base, 14 studies), `indicators/indicators-osc.js` (11), `indicators/indicators-tulip.js` (11), `indicators/indicators-tmom.js` (17), `indicators/indicators-tvol.js` (15), `indicators/indicators-qx.js` (17). Do NOT edit these files.
- Create: `js/lib.js` (ESM bridge to the global)
- Create: `js/studies.js` (registry of all 85 + compute helper)
- Modify: `index.html` (classic `<script>` tags in load order), `js/chart.js` (study rendering), `js/ui.js` (dialog lists all 85 grouped + search filter)
- Test: `tests/studies.test.mjs`

**Interfaces:**
- Consumes: `globalThis.Indicators` (classic scripts), row arrays from `fetchOHLCV`, existing pane/overlay render helpers, Task-7 dialog + `state.indicators`
- Produces: `STUDIES` (85 entries `{id,label,group,inputs,kind,lines}`), `computeStudy(id, rows, opts)` → `{id, series: {key: (number|null)[]}}`. Later tasks use `STUDIES` for dialog + render.

**Study inventory (85 — every id below must be registered; group = source file):**
- base `indicators/indicators.js` (14): sma, ema, macd, bbands, stddev, psar, vwap, zlema, trima, hma, renko, heikinashi, ichimoku, frama
- osc `indicators/indicators-osc.js` (11): rsi, stoch, aroonosc, adx, atr, fisher, mfi, uo, fosc, dmi, msw
- tulip `indicators/indicators-tulip.js` (11): dema, tema, wma, wilders, vidya, vwma, linreg, tsf, linregslope, kama, md
- tmom `indicators/indicators-tmom.js` (17): stochrsi, adxr, aroon, cci, cmo, dx, di, mom, roc, rocr, trix, ultosc, willr, apo, ppo, bop, qstick
- tvol `indicators/indicators-tvol.js` (15): obv, emv, vosc, nvi, pvi, wad, ad, cvi, natr, mass, kvo, adosc, dpo, vhf, volatility
- qx `indicators/indicators-qx.js` (17): vortex, kst, zigzag, ravi, aema, tsi, smi, eri, awesome, supertrend, arsi, keltner, donchian, ulcer, earsi, holtwinters, kagi

Calling convention (verified uniform): `fn(closes, opts)` for close-only, `fn(high, low, close, opts)` for HLC, `fn(high, low, close, volume, opts)` for HLCV. `opts` always an object with documented defaults (read each fn's `_per(...)` calls). Returns same-length single array or object of same-length arrays; warmup bars are `null`; `null/NaN` in a window yields `null`.

Kind rules (assign per study by reading its doc comment; explicit overrides below, else defaults):
- `overlay`: single price-scale series → line on price pane (default for single-output close-averages: sma/ema/wma/dema/tema/trima/zlema/hma/kama/frama/vidya/vwma/wilders/linreg/tsf/aema/holtwinters, plus psar dots, supertrend line, zigzag line, vwap line).
- `bands`: `{upper,lower[,middle]}` → lines + fill (bbands, keltner, donchian).
- `multiline`: object of price-scale series → N lines on price pane (ichimoku 5 lines).
- `pane`: oscillators → lines in the shared oscillator pane, scaled to union min/max of active pane studies (rsi, stoch, stochrsi, adx, adxr, dx, di, dmi, aroon, aroonosc, cci, cmo, mom, roc, rocr, trix, ultosc, willr, apo, ppo, bop, qstick, atr, natr, fisher, mfi, uo, fosc, msw, macd, stddev, md, linregslope, obv, emv, vosc, nvi, pvi, wad, ad, cvi, mass, kvo, adosc, dpo, vhf, volatility, vortex, kst, ravi, tsi, smi, eri, awesome, arsi, earsi, ulcer).
- `transform`: replaces candle source, radio behavior — exactly one active at a time (heikinashi, renko, kagi).

- [ ] **Step 1: Write the failing test**

```js
// tests/studies.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load the classic library exactly as index.html will (base first).
const ORDER = ['indicators/indicators.js', 'indicators/indicators-osc.js', 'indicators/indicators-tulip.js', 'indicators/indicators-tmom.js', 'indicators/indicators-tvol.js', 'indicators/indicators-qx.js'];
const ctx = vm.createContext({ console, Math, Number, Array, Object, Error, globalThis: {} });
ctx.globalThis = ctx;
for (const f of ORDER) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
const Lib = ctx.Indicators;
const { STUDIES } = await import('../js/studies.js');

test('library exposes all 85 studies', () => {
  assert.equal(Object.keys(Lib).length, 85);
});
test('registry covers all 85 with no orphans either direction', () => {
  const ids = STUDIES.map(s => s.id).sort();
  assert.equal(ids.length, 85);
  assert.deepEqual(ids, Object.keys(Lib).sort());
});
test('every study computes same-length output with null warmup', () => {
  const N = 60;
  const closes = Array.from({ length: N }, (_, i) => 60000 + i * 100 + (i % 5) * 50);
  const high = closes.map(c => c + 120), low = closes.map(c => c - 120), vol = closes.map(() => 1.5);
  for (const s of STUDIES) {
    const fn = Lib[s.id];
    const args = s.inputs === 'close' ? [closes] : s.inputs === 'hlc' ? [high, low, closes] : [high, low, closes, vol];
    const out = fn(...args, {});
    const series = Array.isArray(out) ? { line: out } : out;
    for (const arr of Object.values(series)) {
      assert.equal(arr.length, N, `${s.id} length`);
      assert.equal(arr[0], null, `${s.id} warmup`);
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/studies.test.mjs`
Expected: FAIL — `Cannot find module '../js/studies.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// js/lib.js — ESM bridge to the classic-script global. index.html loads
// indicators/*.js before any module, so globalThis.Indicators must exist.
export function getLib() {
  const Lib = globalThis.Indicators;
  if (!Lib) throw new Error('indicators library not loaded — check <script> order in index.html');
  return Lib;
}
```

```html
<!-- index.html: insert BEFORE the module script, exact order (base first) -->
<script src="indicators/indicators.js"></script>
<script src="indicators/indicators-osc.js"></script>
<script src="indicators/indicators-tulip.js"></script>
<script src="indicators/indicators-tmom.js"></script>
<script src="indicators/indicators-tvol.js"></script>
<script src="indicators/indicators-qx.js"></script>
```

```js
// js/studies.js — registry + compute. Pattern per entry (85 total, ids per
// inventory above; inputs: 'close'|'hlc'|'hlcv'; opts: fn defaults from source):
import { getLib } from './lib.js';
export const STUDIES = [
  { id: 'sma', label: 'SMA', group: 'Trend', inputs: 'close', kind: 'overlay', lines: ['line'], opts: { period: 20 } },
  { id: 'macd', label: 'MACD', group: 'Trend', inputs: 'close', kind: 'pane', lines: ['macd', 'signal', 'hist'], opts: { short: 12, long: 26, signal: 9 } },
  { id: 'bbands', label: 'Bollinger Bands', group: 'Trend', inputs: 'close', kind: 'bands', lines: ['upper', 'middle', 'lower'], fill: ['upper', 'lower'], opts: { period: 20, stddev: 2 } },
  // ... one entry per inventory id (85). Read each fn's doc comment + _per
  // defaults for exact opts keys; multi-output fns list every returned key.
];
export function computeStudy(id, rows, opts = {}) {
  const Lib = getLib();
  const meta = STUDIES.find(s => s.id === id);
  if (!meta || typeof Lib[id] !== 'function') throw new Error('unknown study ' + id);
  const closes = rows.map(r => r.c), high = rows.map(r => r.h), low = rows.map(r => r.l), vol = rows.map(r => r.v);
  const args = meta.inputs === 'close' ? [closes] : meta.inputs === 'hlc' ? [high, low, closes] : [high, low, closes, vol];
  const out = Lib[id](...args, { ...meta.opts, ...opts });
  return { id, series: Array.isArray(out) ? { line: out } : out };
}
```

`js/chart.js`: after existing indicator overlays, loop `state.studies` (array of active ids): `overlay`/`multiline` kinds → colored lines on price pane (color by registry index); `bands` → lines + 12% alpha fill between `fill` pair; `pane` kinds → shared oscillator pane scaled to union min/max of active pane series (existing RSI pane generalizes); `transform` (heikinashi/renko/kagi) → replaces candle source rows before render, radio (selecting one deselects others). `js/ui.js`: Indicators dialog groups the 85 by `group` with per-group All/None + text filter input; checkbox toggles update `state.studies` via `v.set`; transform entries render as radio. Task-7 ESM sma/ema/rsi checkboxes keep working unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/studies.test.mjs && node --test tests/ && node tooling/verify.mjs http://localhost:8787/ && ls -lh tooling/shots/final-1920.png`
Expected: studies tests PASS (85/85 callable); full suite PASS; verify ok with studies dialog open showing grouped 85 + several studies rendered, no console errors.

- [ ] **Step 5: Commit**

```bash
git add indicators/ js/lib.js js/studies.js index.html js/chart.js js/ui.js tests/studies.test.mjs tooling/shots/final-1920.png
git commit -m "feat: wire all 85 vendored studies with dialog and rendering"
```
