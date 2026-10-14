# Opentape Suite — master execution plan (2026-10-14)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan workstream-by-workstream. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `python opentape.py` boots the static terminal (8787) plus a local
proxy suite (8788) serving every keyless market; the market selector becomes
exchange-grade (three tiers, recents, base/quote split, char-by-char
autofill, deep pulldowns, network-plot view).

**Architecture:** Nine parallel build workstreams (A–I), each creating NEW
files only — no two agents touch the same file. The integrator (main session)
wires imports/routing, then audits. Data contracts below are verbatim in
every build prompt; drift from them is a defect.

**Tech Stack:** Python 3 stdlib `http.server` (+ opt-in pip: `yfinance`,
`websocket-client`, `akshare`, `baostock` — degraded gracefully when absent);
vanilla JS page; Playwright audits.

## Global Constraints

- Localhost only: bind `127.0.0.1`, never `0.0.0.0`. No hosted backend.
- No secrets in repo or code; keyless sources only (BYOK config file later).
- Live-only honesty: errors carry reasons, stale wears a badge, never substitute data.
- Browser bundle rule unchanged: page calls only companion-localhost + CORS-clean hosts.
- GPL code (nsepython) never imported into this tree — HTTP boundary only.

---

## Canonical contracts (verbatim for all builders)

### Companion source module (`tooling/companion/sources/<name>.py`)

```python
SOURCE = 'yahoo'             # stable id in ?source=
LABEL = 'Stocks & Indices'   # tier-1 display
INTERVALS = ['1m', '5m', '15m', '30m', '1h', '1d', '1wk', '1mo']
STREAM = {'mode': 'poll', 'cadence': 60, 'note': 'polls ~60s; intraday ≤60d'}
# mode: 'live' (push/WS) | 'poll' (seconds) | 'snapshot' (EOD/manual)

def venues():      # -> [{'id': 'US', 'label': 'US Stocks'}, ...]
def candles(venue, symbol, interval, limit=300):
    # -> [{'t': ms int, 'o':f, 'h':f, 'l':f, 'c':f, 'v':f}] ascending.
    # Raise Exception(detail-message) on any failure.
def search(venue, query):   # -> [{'symbol': 'RELIANCE.NS', 'name': 'Reliance Industries'}]
```

Optional: `def quote(venue, symbol)` / `def depth(venue, symbol, limit)` —
server returns `404 {error}` when absent. Stdlib-only unless the workstream
says otherwise; missing optional pip deps must degrade (source reports
`ok:false` with install hint), never crash the server.

### Companion HTTP surface (`tooling/companion/server.py`)

- `GET /health` → `{ok, sources: {id: {ok, reason?}}, time}`
- `GET /api/sources` → `[{id, label, intervals, stream, venues: [...]}]`
- `GET /api/candles?source=&venue=&symbol=&interval=&limit=` →
  `{candles: [...], meta: {source, venue, cached_at, ttl, stale, fallback: []}}`
- `GET /api/search?source=&venue=&q=`, `GET /api/quote?…`, `GET /api/depth?…`
- Validation: source from registry; symbol `^[A-Za-z0-9.\-=^:/]{1,64}$`
  (per-source tighten allowed); `limit` clamp 1..1000; interval must be in
  the source's INTERVALS (else 400 + supported list).
- Cache: in-memory TTL + single-flight per key (source TTLs per plan);
  negative-cache errors 10s with reason. On-disk cache for OHLCV only.
- Errors: always JSON `{error, reason, source}`; 400 validation, 404 unknown,
  502 upstream. ACAO `*`, localhost-only, one-line structured logs.

### Page routing + modal (`js/`)

- `resolveMarket` gains `source:` routing: first segment matching a known
  companion source id (cached `/api/sources`, static fallback) routes to the
  companion fetch; everything else keeps the current ccxt path byte-identical.
- Companion load path reuses `resetScale/fitCanvases/saveLayout/
  updateSymbolHead` and the `onStreamCandle` stream flow (poll via companion
  at the source cadence; WS later).
- Modal rewrite (same `#sym-dialog` id): tier tabs SDK→venue→instrument,
  recents row (`opentape-recents`, max 8, click applies, updated on success),
  base/quote split view (pick base → all its quotes), 120ms-debounced
  char-by-char autofill with match highlight + Enter-applies-first, full
  scrollable lists with counts + sticky headers, per-source interval select,
  streaming-tip badges from `/api/sources`, and a network-plot tab (canvas
  venue/asset graph, click node = filter).
- URL gains `source` + `venue` params; layout persists source/venue/symbol.

---

## Workstreams (parallel, new files only)

### A. Launcher — create `/workspace/opentape.py`
Stdlib only (`subprocess`, `webbrowser`, `urllib`). Starts static server
(8787, repo root) + companion (`tooling/companion/server.py`, 8788, if
present else warn-and-continue browser-direct). Flags: `--no-browser`,
`--port/--companion-port`, `--open` default on. Probes `/health` before
opening the page; prints dep hints for missing optional pip packages
(`yfinance`, `websocket-client`, `akshare`, `baostock`); Ctrl-C stops both
cleanly. Acceptance: cold run prints both URLs + source table; missing
companion still serves the terminal; Ctrl-C exits 0, ports freed.

### B. Companion core — create `tooling/companion/server.py` (+ `tests/test_core.py`)
Implements the HTTP surface + registry (defensive import of `sources/*.py`,
per-source `ok:false` on failure) + cache/validation/logging per contracts.
`tests/test_core.py`: stdlib `unittest`, stub source module, offline
(`python3 -m unittest discover -s tooling/companion/tests`). Acceptance:
all contract routes respond; bad input → 400 JSON; unknown source → 404;
`python3 tooling/companion/server.py` serves.

### C. Equities source — create `tooling/companion/sources/yahoo.py` (+ test)
Raw `urllib` Yahoo `v8/chart` (no crumb handling needed for chart route;
stdlib-only, no yfinance import): suffix map (US none, NSE `.NS`, BSE `.BO`,
LSE `.L`, TSE `.T`, TSX `.TO`, ASX `.AX`, B3 `.SA`, HKEX numeric `.HK`,
Euronext `.PA/.AS/.BR/.LS`, **Tadawul `.SAU`**, **Madrid `.MC`**),
`.NS`→`.BO` fallback, `adjclose` adjustment, interval allowlist, futures
(`=F`), FX (`=X`), yields/VIX (`^`), indices. STREAM poll/60. Venues: US,
NSE, BSE, LSE, TSE, TSX, ASX, B3, HKEX, Euronext, FX, Commodities, Rates,
Indices. Acceptance: offline fixture tests (record parsing, suffix map,
fallback selection); live spot-checks documented.

### D. India source — create `tooling/companion/sources/india.py` (+ test)
Stdlib-only NSE MCP client (2-step session-header handshake, SSE parse):
`get_stock_history` (3-mo pages chained via `next_end_date`),
`get_index_history`, `get_corporate_actions`, holiday-master; archives
fallback (`ind_close_all_*.csv`, bhavcopy ZIP); AMFI NAV + `mfapi.in`
history; MCX behind 403-tolerant session (degraded, never fatal); NCDEX
explicitly unsupported state. Venues: NSE, BSE, MCX, MF-NAV. STREAM
snapshot (+ intraday note where live). Acceptance: fixture tests for MCP
parsing/chaining/CSV/NAV; live probes documented.

### E. DEX source — create `tooling/companion/sources/dex.py` (+ test)
Stdlib `urllib`: DexPaprika klines (366 clamp, cursor pagination, dedupe,
`network:address` pools, pool search with filters, batch prices, credit
accounting → honest 402/429 states); GeckoTerminal fallback
(`before_timestamp` backfill, 200+ nets); DexScreener search/enrich only
(no klines — never chart from it). Venues: dynamic network list (static
36-id fallback). STREAM poll/60 (+ SSE-showcase note). Acceptance: fixture
tests (pagination merge, interval map, pool parse); live probes documented.

### F. BitShares source — create `tooling/companion/sources/bitshares.py` (+ test)
Needs `websocket-client` (pip, degrade if absent). Seed nodes + latency
sort + history-plugin probing; `get_market_history` chunking (≤200),
`get_order_book`, `get_ticker`+`get_bitasset_data` join with feed age;
**ES (`es.bitshares.dev`, op-63/op-4 + `search_after`, ≤8×10k)** for pool
history beyond native 101 rows (via `urllib` POST); XBTS REST fallback for
order-book daily. Venues: BitShares (single). STREAM poll/15. Acceptance:
fixture tests (bucketing, book normalize incl. satoshi/precision + pair
orientation, feed-age math); live probes documented.

### G. Macro/rates source — create `tooling/companion/sources/macro.py` (+ test)
Stdlib: ECB SDMX (`EXR` daily FX, `YC` curves by maturity, `IRS`);
Binance funding + OI history (`fapi`, keyless); Stooq CSV fallback
(degraded, throttled); `exchange_calendars`-shaped holiday fallback note
(no pip dep — static weekend rules + NSE JSON via india.py). Venues:
ECB-FX, ECB-YC, Binance-Derivs, Stooq. Acceptance: fixture tests (SDMX
parse, funding rows, Stooq CSV parse).

### H. China source — create `tooling/companion/sources/china.py` (+ test)
`baostock` primary (history + intraday, adjusted) + `akshare` spot
secondary; both pip-optional with degrade; Yahoo `.SS/.SZ` fallback note
(not implemented here — C already maps suffixes). `sh./sz./bj.` code
routing. Venues: CN-A, HK. STREAM snapshot (T+1 banner data). Acceptance:
fixture tests (code routing, column mapping, adjust flags).

### I. Market selector UX — modify `js/ui.js` (modal block only) + `styles.css`
(same agent, both files; no other agent touches them). Rebuild `#sym-dialog`
per the modal contract: tiers, recents, base/quote split, debounced
autofill + Enter, full scrollable lists + counts, per-source intervals,
streaming tips, network-plot tab (canvas graph: venue/asset nodes sized by
counts, edges = markets, click = filter; vanilla-ui-inspired, own art),
companion-down disabled states, URL+layout persistence. Keep `#sym-dialog`
id and `#sym-apply` flow; reuse existing `reload` + new companion load path
for apply (add `loadCompanion()` reusing scale/layout/header helpers).
Acceptance (headless): every tier clickable, recents apply, autofill
filters per keystroke, base BTC lists all BTC quotes, plot node filters,
switch paints, no console errors.

## Integration (main session, after builds land)

- [ ] Wire `server.py` imports + page `resolveMarket`/companion fetch/`loadCompanion`.
- [ ] `python opentape.py` cold boot → both URLs → source table in modal.
- [ ] `npm test` + all Playwright harnesses + companion `unittest` suites.
- [ ] Live spot-probes per source (recorded in plan as evidence).

## Audit + polish + commit (main session)

- [ ] Side-by-side chart parity per new source; error/empty/offline states.
- [ ] Polish pass (selector feel, plot legibility, toasts, light theme).
- [ ] Commit per workstream (launcher / companion+source / selector).

## Self-Review

- **Coverage:** launcher (user ask) → A; proxy suite (user ask) → B–H per
  source matrix; selector tiers/recents/base-quote/autofill/depth/tips/plot
  (user ask + offers) → I; integration/audit/polish/commit (user ask) → gates.
- **Placeholders:** none — paths, params, limits, and acceptance gates exact.
- **Consistency:** module contract, HTTP surface, symbol forms, and TTL numbers
  identical across workstreams; no shared-file edits (I owns ui.js/styles.css).
