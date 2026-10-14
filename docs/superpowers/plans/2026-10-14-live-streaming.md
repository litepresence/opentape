# Live Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the chart live at the selected symbol + interval via `ccxt.pro` watchOHLCV with a REST polling fallback.

**Architecture:** `mergeCandle` (pure, unit-tested) folds each candle into `rows`; a `watchCandles` loop in `js/data.js` owns transport with backoff; `js/ui.js` owns one-subscription lifecycle, a LIVE/DELAYED/OFFLINE dot, and render+conditional-refit per update.

**Tech Stack:** Vanilla JS, pinned `ccxt` browser bundle (`ccxt.pro` already probed present), Playwright audits, `node --test`.

## Global Constraints

- No new dependencies beyond the pinned `ccxt` CDN bundle.
- Public GET-only market data; no secrets, no trading execution.
- Live-only contract: failures keep last good rows + toast, never fake candles.
- All state mutations via ViewState then render; drawings/alerts/lock/hide/replay semantics unchanged.
- Canvas text stays `-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif`.

---

## File structure

- `js/data.js` — add `mergeCandle(rows, candle, cap)` + `watchCandles(opts)`. Data transport only, no DOM.
- `js/ui.js` — add `startStream`/`stopStream`, status dot in `#rangebar`, per-candle render path, `visibilitychange` pause/resume, `__tv` stream-status exposure.
- `tests/stream.test.mjs` — new: merge + watch-loop tests with stubbed exchanges (no network).
- `docs/superpowers/specs/2026-10-14-live-streaming-design.md` — spec (already written).

---

### Task 1: mergeCandle pure helper + unit tests

**Files:**
- Modify: `js/data.js` (append after `fetchOHLCV`)
- Create: `tests/stream.test.mjs`
- Test: `tests/stream.test.mjs`

**Interfaces:**
- Consumes: row shape `{t,o,h,l,c,v}` (numbers) from `normalizeOHLCV`.
- Produces: `mergeCandle(rows, candle, cap = 2000)` → new array. Same-`t` merges (`h=max, l=min, c, v` replaced); greater-`t` appends and drops oldest past `cap`; older-`t` returns input unchanged.

- [ ] **Step 1: Write the failing test**

```js
// tests/stream.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandle } from '../js/data.js';

test('mergeCandle updates the forming candle on same t', () => {
  const rows = [{ t: 1, o: 10, h: 11, l: 9, c: 10.5, v: 5 }];
  const out = mergeCandle(rows, { t: 1, o: 10, h: 12, l: 8, c: 11, v: 7 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { t: 1, o: 10, h: 12, l: 8, c: 11, v: 7 });
});

test('mergeCandle appends a new candle and caps length', () => {
  const rows = [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: 2, o: 2, h: 2, l: 2, c: 2, v: 2 }];
  const out = mergeCandle(rows, { t: 3, o: 3, h: 3, l: 3, c: 3, v: 3 }, 3);
  assert.equal(out.map((r) => r.t).join(','), '1,2,3');
  const capped = mergeCandle(out, { t: 4, o: 4, h: 4, l: 4, c: 4, v: 4 }, 3);
  assert.equal(capped.map((r) => r.t).join(','), '2,3,4');
});

test('mergeCandle ignores older candles and does not mutate input', () => {
  const rows = [{ t: 5, o: 1, h: 1, l: 1, c: 1, v: 1 }];
  const out = mergeCandle(rows, { t: 4, o: 9, h: 9, l: 9, c: 9, v: 9 });
  assert.equal(out, rows);
  assert.equal(rows[0].c, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/stream.test.mjs`
Expected: FAIL with "mergeCandle is not a function" (or SyntaxError on import).

- [ ] **Step 3: Write minimal implementation**

Append to `js/data.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/stream.test.mjs`
Expected: PASS, 3/3.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all green (adds 3 tests, breaks none).

- [ ] **Step 6: Commit**

```bash
git add js/data.js tests/stream.test.mjs
git commit -m "feat: mergeCandle helper for live candle updates"
```

### Task 2: watchCandles transport (WS primary, polling fallback)

**Files:**
- Modify: `js/data.js` (append after `mergeCandle`)
- Modify: `tests/stream.test.mjs` (append tests)
- Test: `tests/stream.test.mjs`

**Interfaces:**
- Consumes: `resolveMarket`, `whenCcxt` (same file); injected `createExchange` for tests.
- Produces: `watchCandles({ symbol, timeframe, onCandle, onStatus, createExchange, pollMs })` → `{ stop }`. `onCandle` receives `{t,o,h,l,c,v}` objects. `onStatus('live'|'polling'|'offline', detail?)` reports transport state.

- [ ] **Step 1: Write the failing tests**

```js
import { watchCandles } from '../js/data.js';

test('watchCandles streams WS candles and stops', async () => {
  const seen = [];
  constStatuses = [];
  const fake = {
    has: { watchOHLCV: true },
    watchOHLCV: async () => { await new Promise((r) => setTimeout(r, 5)); return [[7, 1, 2, 0.5, 1.5, 10]]; },
    close: async () => {},
  };
  const sub = watchCandles({
    symbol: 'BTC/USD', timeframe: '1d',
    createExchange: async () => fake,
    onCandle: (c) => seen.push(c),
    onStatus: (s) => constStatuses.push(s),
  });
  await new Promise((r) => setTimeout(r, 30));
  sub.stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(seen.length >= 1);
  assert.deepEqual(seen[0], { t: 7, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
  assert.ok(constStatuses.includes('live'));
});

test('watchCandles falls back to polling when WS is unsupported', async () => {
  let polls = 0;
  const fake = { has: {}, close: async () => {} };
  const sub = watchCandles({
    symbol: 'BTC/USD', timeframe: '1d', pollMs: 10,
    createExchange: async () => fake,
    pollOnce: async () => { polls += 1; return [{ t: 9, o: 1, h: 1, l: 1, c: 1, v: 1 }]; },
    onCandle: () => {},
    onStatus: () => {},
  });
  await new Promise((r) => setTimeout(r, 45));
  sub.stop();
  assert.ok(polls >= 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/stream.test.mjs`
Expected: FAIL with "watchCandles is not a function".

- [ ] **Step 3: Write minimal implementation**

Append to `js/data.js`:

```js
const TF_MS = { '1m': 6e4, '3m': 18e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '1d': 864e5, '1w': 6048e5, '1M': 2592e6 };
export const timeframeMs = (tf) => TF_MS[String(tf)] || 864e5;

// Live candle subscription. WS (ccxt.pro watchOHLCV) when the exchange
// supports it, else REST polling. Never throws out — transport problems are
// reported via onStatus and retried with backoff.
export function watchCandles({ symbol = 'BTC/USD', timeframe = '1d', onCandle, onStatus, createExchange, pollOnce, pollMs } = {}) {
  let stopped = false;
  let timer = null;
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
      if (timer) clearTimeout(timer);
      try { exchange && exchange.close && exchange.close(); } catch {}
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/stream.test.mjs`
Expected: PASS, 5/5. (`timer` is reserved for future use; `stop()` is idempotent; loops exit on `stopped`.)

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add js/data.js tests/stream.test.mjs
git commit -m "feat: watchCandles transport with polling fallback"
```

### Task 3: ui.js lifecycle, status dot, per-candle render

**Files:**
- Modify: `js/ui.js` near `loadData` (`~line 600`), `reload` (`~line 1304`), `#rangebar` footer, `__tv` hook (`~line 2396`)
- Test: headless browser checks (no new unit file; DOM + timers)

**Interfaces:**
- Consumes: `watchCandles`, `mergeCandle`, `timeframeMs` from `./data.js`; existing `rows`, `renderAll`, `refitPriceToVisible`, `scaleFor`, `loadData`, `reload`.
- Produces: one active stream; `#live-dot` LIVE/DELAYED/OFFLINE; `window.__tv.stream()` debug status.

- [ ] **Step 1: Wire start/stop into load and reload paths**

In `js/ui.js`:
1. Extend the `import { fetchOHLCV, resolveMarket } from './data.js';` (line 2) with `watchCandles, mergeCandle, timeframeMs`.
2. Add closure state next to `rows`/`fullVisible` declarations (`~line 471`): `let stream = null; let streamState = 'off'; let lastStreamTs = 0;`.
3. Add before `loadData` (`~line 600`):
```js
const setStreamState = (s) => {
  streamState = s;
  const el = document.querySelector('#live-dot');
  if (el) {
    el.dataset.state = s;
    el.textContent = s === 'live' ? '● LIVE' : s === 'delayed' ? '● DELAYED' : s === 'off' ? '' : '● OFFLINE';
    el.title = s === 'live' ? 'Streaming live candles' : s === 'delayed' ? 'No candle updates recently' : s === 'off' ? '' : 'Stream offline — showing last data';
  }
};
const onStreamCandle = (row) => {
  if (!row || !rows.length) return;
  rows = mergeCandle(rows, row);
  lastStreamTs = Date.now();
  if (streamState !== 'live') setStreamState('live');
  const st = v.get();
  if (st.replayIndex == null || !Number.isFinite(st.replayIndex)) {
    refitPriceToVisible();
    const last = rows[rows.length - 1];
    if (last && fullVisible) fullVisible = { ...fullVisible, to: last.t };
  }
  renderAll(v.get());
};
const startStream = () => {
  stopStream();
  const s = v.get();
  const symbol = s.symbol || 'BTC/USD';
  const tf = s.interval || '1d';
  lastStreamTs = Date.now();
  stream = watchCandles({
    symbol,
    timeframe: tf,
    onCandle: onStreamCandle,
    onStatus: (st, detail) => {
      if (st === 'live') { lastStreamTs = Date.now(); setStreamState('live'); }
      else if (st === 'polling') setStreamState('live');
      else { setStreamState('offline'); if (detail) console.warn('Stream offline', detail); }
    },
  });
};
function stopStream() {
  try { stream && stream.stop(); } catch {}
  stream = null;
}
```
4. In `loadData` success path (after `setDataStatus('ok')`): add `startStream();`. In the catch path: add `stopStream(); setStreamState('off');`.
5. In `reload` success path (after `updateSymbolHead();`, before `return true;`): add `startStream();`. In the catch path: add `stopStream();` (keep existing toast; do not change the keep-old-data contract).
6. Add the dot element: in `initUI`, after the clock interval setup (`~line 463`), insert:
```js
const rangeClock = document.querySelector('#clock');
if (rangeClock && !document.querySelector('#live-dot')) {
  const dot = document.createElement('span');
  dot.id = 'live-dot';
  dot.dataset.state = 'off';
  dot.style.cssText = 'font-size:11px;margin-left:8px;color:#787b86';
  rangeClock.after(dot);
}
```
7. Staleness timer next to the clock interval: every 5s, if a stream exists and `Date.now() - lastStreamTs > Math.max(60000, 2 * timeframeMs(v.get().interval || '1d'))`, call `setStreamState('delayed')`.
8. Pause on hidden tab: `document.addEventListener('visibilitychange', () => { if (document.hidden) stopStream(); else if (rows.length) startStream(); });`
9. Extend the `__tv` hook (`~line 2396`): add `stream: () => ({ state: streamState, active: !!stream })`.

- [ ] **Step 2: Headless verify**

Run: `python3 -m http.server 8787` (repo root), then a Playwright snippet: open `?debug=1`, wait for rows, assert `#live-dot` shows LIVE within 60s, stub check `window.__tv.stream().active === true`, switch symbol via watchlist and assert stream restarts (state flips then LIVE), hide tab via `page.evaluate(() => Object.defineProperty(document, 'hidden', ...))` is unreliable — instead call the visibility path manually is out of scope; assert no console errors.
Expected: dot LIVE, stream active, no errors. (If sandbox WS egress is down, polling path must still flip the dot — either outcome documented.)

- [ ] **Step 3: Run full suite + audits**

Run: `npm test` (green), `node tooling/audit_rail_browser.mjs` (footer dot must not break layout assertions — rail audit only counts rail items, unaffected).

- [ ] **Step 4: Commit**

```bash
git add js/ui.js
git commit -m "feat: live candle streaming lifecycle and status dot"
```

### Task 4: Live verification, polish, final commit

**Files:**
- Modify: none unless verification finds gaps
- Test: `tooling/compare_tv_local.mjs`, `tooling/audit_drawing_kinds.mjs`

- [ ] **Step 1: Live stream observation**

With network available: open the app, wait 2× the 1m interval on a 1m chart (or stub `watchOHLCV` via `page.evaluate` to emit scripted candles), assert the forming candle's `c`/`h`/`l` move, a new `t` appends a row, header + pills update, price refits when auto-scale is on and holds when off, drawings persist, replay (if active) is undisturbed.

- [ ] **Step 2: Polish**

Only small, in-scope fixes found by Step 1 (e.g. dot contrast in light theme, toast wording on fallback). No new features.

- [ ] **Step 3: Final verification**

Run: `npm test`, `node tooling/audit_drawing_kinds.mjs`, `node tooling/compare_tv_local.mjs`. Expected: all green, zero console errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: live OHLCV streaming with polling fallback"  # only if Step 2 changed files; use git add on touched files first
```

## Self-Review

- **Spec coverage:** goal → Tasks 2+3; WS primary + polling fallback → Task 2 (`watchOHLCV` capability branch, `pollOnce`/`fetchOHLCV` fallback); lifecycle/subscribe rules → Task 3 (`startStream`/`stopStream` in load+reload); merge/append/cap → Task 1; render+conditional refit → Task 3 (`refitPriceToVisible` respects `priceAuto`, replay guard skips refit); header/pills → Task 3 (`renderAll` already updates them from the last bar); replay → Task 3 (guard); status dot + stale threshold → Task 3; contracts (keep-last-data, no new deps, drawing semantics) → Tasks 2+3 constraints; verification → Tasks 1+2 unit, Tasks 3+4 headless+harness. No gaps.
- **Placeholder scan:** no TBD/TODO; every code step shows exact code; commands have expected outputs; no "similar to Task N" (Task 2 repeats the `stop()`/loop-exit detail inline).
- **Type consistency:** `mergeCandle(rows, candle, cap)` object rows everywhere; `watchCandles` options `{symbol, timeframe, onCandle, onStatus, createExchange, pollOnce, pollMs}` match Task 2 tests; candle objects `{t,o,h,l,c,v}` match `normalizeOHLCV` output; `timeframeMs` shared by Task 2 implementation and Task 3 staleness timer. Fixed inline during writing (polling `status('polling')` maps to LIVE dot — documented in Task 3 step).
