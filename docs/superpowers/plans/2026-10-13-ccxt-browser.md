# CCXT-in-Browser Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the Node CCXT proxy; fetch all crypto market data live in the browser via the prebuilt CCXT bundle, Binance default.

**Architecture:** Pinned-`@4`-tracking `<script async src="https://cdn.jsdelivr.net/npm/ccxt@4/dist/ccxt.browser.js">` exposes global `ccxt`; `js/data.js` routes symbols to exchanges and returns the existing `{t,o,h,l,c,v}` shape; boot paints embedded fallback instantly, live data swaps in when the bundle is ready. GET-only public endpoints; no secrets, no trading.

**Tech Stack:** Vanilla ESM + CCXT browser UMD global (loaded async), no npm `ccxt` dep, no server.

## Global Constraints

- Vanilla only: no React/Vue/Tailwind, no chart libs. No new npm dependencies.
- `js/data.js` keeps its exact exports: `normalizeOHLCV(raw)`, `fetchOHLCV({symbol,timeframe,limit})`. All callers untouched by signature.
- First paint must never wait for the 14.8MB bundle: embedded fallback renders immediately, live upgrades in.
- GET-only public market data. No API keys, no secrets, no order/trading paths anywhere.
- Tooling scripts live in `tooling/` only.

---

### Task 1: CCXT-browser data layer + routing + loader

**Files:**
- Modify: `js/data.js` (CCXT-powered fetch + exchange routing, same exports)
- Modify: `index.html` (async CCXT script tag before module script)
- Test: `tests/ccxt-data.test.mjs`

**Interfaces:**
- Consumes: global `ccxt` (may be absent until bundle loads), `data/btcusd-1d.json` fallback
- Produces: `fetchOHLCV({symbol,timeframe,limit})` → normalized rows (unchanged contract); `resolveMarket(symbol)` → `{exchange, ccxtSymbol}` exported for ui.js reuse.

- [ ] **Step 1: Write the failing test**

```js
// tests/ccxt-data.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMarket, normalizeOHLCV } from '../js/data.js';

test('resolveMarket defaults BTC/USD to binance spot', () => {
  assert.deepEqual(resolveMarket('BTC/USD'), { exchange: 'binance', ccxtSymbol: 'BTC/USDT' });
});
test('resolveMarket keeps explicit exchange prefix', () => {
  assert.deepEqual(resolveMarket('coinbase:BTC/USD'), { exchange: 'coinbase', ccxtSymbol: 'BTC/USD' });
});
test('normalizeOHLCV still accepts ccxt array rows', () => {
  const rows = normalizeOHLCV([[1700000000000, 1, 2, 0.5, 1.5, 10]]);
  assert.equal(rows[0].c, 1.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ccxt-data.test.mjs`
Expected: FAIL — no `resolveMarket` export.

- [ ] **Step 3: Write minimal implementation**

```js
// js/data.js — keep normalizeOHLCV verbatim. Add:
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
export function whenCcxt() {
  if (typeof globalThis.ccxt !== 'undefined') return Promise.resolve(globalThis.ccxt);
  if (!ccxtReady) {
    ccxtReady = new Promise((resolve) => {
      if (typeof document !== 'undefined') document.addEventListener('ccxt-ready', () => resolve(globalThis.ccxt), { once: true });
      else resolve(undefined);
    });
  }
  return ccxtReady;
}

export async function fetchOHLCV({ symbol = 'BTC/USD', timeframe = '1d', limit = 300 } = {}) {
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
    const fb = await fetch('./data/btcusd-1d.json').then(x => x.json());
    console.warn('Live data unavailable — showing cached', e?.message ?? e);
    return normalizeOHLCV(fb);
  }
}
```

```html
<!-- index.html: insert BEFORE the indicators scripts / module script -->
<script src="https://cdn.jsdelivr.net/npm/ccxt@4/dist/ccxt.browser.js" async onload="document.dispatchEvent(new Event('ccxt-ready'))"></script>
```

Verify-during-build: Binance `fetchOHLCV('BTC/USDT','1M')` and `'1w'` resolve (if a timeframe is unsupported, map it to the nearest supported step in `resolveMarket`'s companion `normalizeTimeframe` — add only if the live check fails).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ccxt-data.test.mjs && node --test tests/`
Expected: new tests PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add js/data.js index.html tests/ccxt-data.test.mjs
git commit -m "feat: fetch live crypto via CCXT browser bundle, Binance default"
```

---

### Task 2: Migrate callers off /api, delete server/

**Files:**
- Modify: `js/ui.js` (reload + watchlist use fetchOHLCV; drop direct /api fetches)
- Delete: `server/proxy.js`, `server/` dir if empty
- Modify: `package.json` (drop `ccxt` dep + `proxy` script)
- Delete: `tests/proxy-allowlist.test.mjs` (tests deleted code)
- Modify: `tests/data.test.mjs` only if it references the proxy (keep fallback/normalize tests)

**Interfaces:**
- Consumes: `fetchOHLCV`, `resolveMarket` from Task 1
- Produces: zero references to `/api/ohlcv`, `server/`, or npm `ccxt` anywhere except docs/history.

- [ ] **Step 1: Write the failing test**

No new test file: extend `tests/ccxt-data.test.mjs` with a no-proxy-leak guard:

```js
test('no /api or server references remain in js/', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const hits = [];
  for (const f of readdirSync('js')) {
    const src = readFileSync('js/' + f, 'utf8');
    if (src.includes('/api/ohlcv') || src.includes('server/proxy')) hits.push(f);
  }
  assert.deepEqual(hits, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ccxt-data.test.mjs`
Expected: FAIL — `js/ui.js` still contains `/api/ohlcv` (reload + watchlist).

- [ ] **Step 3: Write minimal implementation**

`js/ui.js` reload becomes:

```js
const reload = async (symbol, ccxtTf, nextTf) => {
  try {
    const data = await fetchOHLCV({ symbol, timeframe: ccxtTf, limit: 300 });
    if (!Array.isArray(data) || !data.length) throw new Error('empty');
    rows = data;
    resetScale();
    fitCanvases();
    const patch = { symbol };
    if (nextTf) patch.timeframe = nextTf;
    v.set(patch);
    saveLayout();
    const symBtn = document.querySelector('#sym');
    if (symBtn) symBtn.textContent = String(symbol).replace('/', '');
    return true;
  } catch (e) {
    showToast(`Live data unavailable — keeping ${v.get().symbol || 'current chart'}`);
    return false;
  }
};
```

Watchlist fetch becomes `fetchOHLCV({ symbol: w.sym, timeframe: '1d', limit: 2 })` (drop the manual `/api` + `normalizeOHLCV` wrapper; keep the em-dash offline rendering). Delete `server/proxy.js` (and `server/` if empty). `package.json`: remove `"ccxt"` from dependencies and the `"proxy"` script (keep `test`). Delete `tests/proxy-allowlist.test.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ && grep -rn "/api/ohlcv\|server/proxy" js/ tests/ index.html package.json || echo "clean"`
Expected: suite green; grep prints `clean`.

- [ ] **Step 5: Commit**

```bash
git add -A js/ tests/ index.html package.json server/ && git commit -m "chore: retire Node proxy, all crypto via browser CCXT"
```

---

### Task 3: Docs, verify, audit, commit

**Files:**
- Modify: `AGENTS.md` (objectives §4, scope, architecture, conventions, verification, working agreement)
- Modify: `docs/superpowers/specs/2026-10-12-tradingview-clone-design.md` (§1 backend bullet, §3 load step, §5 proxy bullets → browser-CCXT equivalents)
- Test: `node --test` + `node tooling/verify.mjs --json` + studies verify + fresh screenshots

**Interfaces:**
- Consumes: finished Tasks 1–2
- Produces: merged main with passing suite, clean screenshots, accurate docs.

- [ ] **Step 1: Update AGENTS.md**

Replace proxy-centric lines with: data via CCXT browser bundle (`ccxt@4` jsDelivr, async, Binance default, exchange routing in `js/data.js`, embedded `data/btcusd-1d.json` first-paint fallback, live-upgrade when ready). Conventions: `ccxt` allowed only via the pinned CDN script tag (no npm dep, no server code). Verification: open `index.html` via any static server (or `github.io`) — candles upgrade from embedded to live with no console errors. Scope: remove `proxy` from In-list; add `server/` deletion note. Aims: crypto-only data terminal (GET-only public data; no trading desk, no secrets); stocks/forex deferred pending a CORS-open keyless or BYOK source.

- [ ] **Step 2: Update spec doc**

`§1 Architecture`: backend bullet → "No backend. `js/data.js` drives global `ccxt` (browser bundle); `resolveMarket` routing; embedded fallback." `§3 Data Flow` step 1 → "paint embedded instantly → upgrade to live when bundle ready → toast on fallback." `§5 Error Handling`: proxy bullets → "bundle blocked/offline → embedded + toast; exchange rejects symbol → keep last good + toast; rate-limit → ccxt enableRateLimit + retry on next interaction."

- [ ] **Step 3: Verify + audit**

Run: `npm test` (41+ new tests, 0 fail); `node tooling/verify.mjs --json` (verdict PASS, no errors); `node tooling/verify_studies.mjs`; fresh `final-1920.png` eyeball (live Binance candles, direction tags, watchlist live). Audit: `grep -rn "ccxt" package.json server/ 2>/dev/null` empty; no `fetch('/api` remains; no secrets/keys in tree (`grep -rni "apikey\|api_key\|secret" js/ index.html`); 14.8MB never blocks first paint (script tag has `async`; boot path tested with bundle blocked — document the evidence).

- [ ] **Step 4: Commit on main**

```bash
git add AGENTS.md docs/ tooling/shots/final-1920.png && git commit -m "docs: record CCXT-browser data terminal status and aims"
```

---

## File Map (create order)

`js/data.js` → `index.html` → `tests/ccxt-data.test.mjs` → `js/ui.js` → delete `server/proxy.js` → `package.json` → delete `tests/proxy-allowlist.test.mjs` → `AGENTS.md` → spec doc → verify + commit
