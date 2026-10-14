# Epic Data Pipeline — master plan (2026-10-14)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every market worth charting — CEX crypto, on-chain DEX pools, US + foreign stocks (incl. India NSE/BSE), indices — flowing into the one canvas through a uniform `{t,o,h,l,c,v}` pipe, with live updates where each source allows them.

**Architecture:** Browser keeps today's direct CCXT path untouched; a **local Python companion** (`127.0.0.1`-only, CORS-open, stdlib-first) fetches everything the browser cannot (CORS-blocked or Python-lib) keyless sources and serves normalized JSON. The page routes by source, never mislabels, and degrades to honest error states.

**Tech Stack:** Vanilla JS page; Python 3 stdlib `http.server` companion + `yfinance`, `requests`, `websocket-client` (pip, localhost only); Playwright audits; `node --test`.

## Global Constraints

- No hosted backend, no secrets, keyless sources only (optional local BYOK later, never committed).
- Live-only honesty: failures keep last good data + reason, stale data wears a badge, never another market's bars.
- GET-only public data; no trading desk, no execution.
- No new browser dependencies beyond the pinned `ccxt` bundle.
- Canvas text stays `-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif`.

---

## 1. Source matrix (researched 2026-10-14, six threads)

| # | Source | Via | Gives | Limits |
|---|---|---|---|---|
| S1 | CCXT CEX (Binance + 100) | Browser bundle (today) | klines all TFs, orderbook REST, WS klines/ticker (`watchOHLCV` proven) | Only CORS-clean hosts reliable |
| S2 | yfinance / Yahoo | Companion | All world stocks/ETF/indices/FX, intraday ≤60d, daily decades, splits/divs, symbol search | 429s if hammered; intraday ceiling 60d; unofficial |
| S3 | NSE/BSE direct | Companion supplement | F&O, option chain, pre-open, bhavcopy, BSE-only names | Daily-only, cookie-gated, fragile, ≤3rps; never critical path |
| S4 | Nasdaq api | Companion cross-check | 10y split-adj daily, live quote, today-only 1m tape, US-wide | Unofficial; intraday history = today only |
| S5 | DexPaprika | Companion | 36-chain pool klines (366–1000/pg), pool search, batch prices, keyless SSE prices (35 showcase) | 15/min + 10k/30d keyless; keyless OHLC 1h+/24h; ≤60s delay |
| S6 | GeckoTerminal | Companion fallback | 200+ nets, 6-mo 1m/5m klines, trades tape, batch prices | ~10/min keyless |
| S7 | DexScreener | Companion enrich | Search, all-pools-for-token, snapshots (NO klines) | 300/min; never a chart source |
| S8 | BitShares WS nodes | Companion | klines (`get_market_history`), orderbook, ticker, witness feeds | Node churn; history plugin not universal; short history |
| S9 | CNBC quote | Browser-direct | Live-ish quotes only (`ACAO: *`) | No history — ticker supplement only |

Ruled out: Stooq (now CAPTCHA-key + JS-challenge), WSJ (DataDome 401), AlphaVantage/Finnhub/TwelveData/Marketstack (keyed), Euronext/HKEX/LSE-direct (keyed or none), Uniswap hosted subgraph (dead), Birdeye/Moralis/Alchemy (keyed).

## 1b. BitShares history: ElasticSearch + vanilla-ui (researched 2026-10-14)

Nodes lack depth — history comes from ES, everything else stays WS-native.
Ground truth: `litepresence/bitshares-vanilla-ui` (`vanilla/js/api/`) + QTradeX
`public/kibana*.py`, all live-probed.

- **Canonical ES host:** `POST https://es.bitshares.dev/bitshares-*/_search`
  (`es.bts.mobi` 301-redirects here; `kibana.bitshares.eu` dead). Keyless.
  Bodies required (POST — GET drops bodies). Cap: `size ≤ 10000` per page
  (20000 returns empty); page with `search_after`, ≤8×10k/60s deep walks.
- **Pool swaps (op-63):** `match operation_type 63` + `multi_match pool-id` +
  `block_data.block_time` range, desc sort; parse `operation_result.paid /
  received`, orient legs, `floor(unix/bucket)` bucketing. Deep walks add
  `gte` window + `search_after`.
- **Order-book fills (op-4):** same shape with `is_maker:false` filter +
  strict per-hit leg check; `get_fill_order_history` / `get_trade_history`
  cover the recent tape natively.
- **Native-first policy:** `history.get_liquidity_pool_history` (≤101 rows)
  and `get_market_history` (200-slot chunks) serve tails; ES only for
  anything deeper/older. Probe `get_market_history_buckets` per node —
  nodes without the `market_history` plugin are klines-degraded.
- **Stays WS-native (no ES):** orderbook, ticker
  (`database.get_order_book` / `get_ticker`), pool objects
  (`get_liquidity_pools_by_*`), witness feeds
  (`database.get_objects` on bitasset data + op-19 publisher walks).
- **XBTS REST** (`market-api-v2.xbts.io/v2/history|trades|orderbook`) is a
  keyless fallback for order-book markets (daily history, no pool swaps).

## 1c. India depth (all live-probed 2026-10-14)

- **NSE MCP (`mcp.nseindia.in`, no-auth streamable-HTTP): genuinely usable.**
  Session-header handshake, 21 bhavcopy tools; `get_stock_history` (3-mo
  pages, 5-yr depth verified), `get_index_history` (12-mo pages + P/E/P/B),
  `get_corporate_actions` (with split/bonus factors), breadth/movers/snapshot
  tools. Daily-only, EOD T+1. Primary India EOD source.
- **Archives fallback:** `nsearchives.../ind_close_all_DDMMYYYY.csv`
  (~11-yr index depth), equity bhavcopy ZIPs (T+1); `historicalOR` ≤1-yr
  windows; several old `/api/*` paths now 404 — never hard-code them.
- **MCX (gold/silver/crude/natgas FUT+OPT, OI/expiry): medium-low** —
  `GetDateWiseBhavCopy` with session cookies + XSRF token, Akamai 403s;
  no static CSV route; continuous-series logic built companion-side.
- **AMFI NAV + `api.mfapi.in/mf/<code>`** (history to 2008): new line-chart
  asset class, ~1 day's work. **NCDEX: no usable keyless surface — defer.**
- **Holidays/CAs machine-readable:** `holiday-master?type=trading`,
  `corporates-corporateActions`, `event-calendar` (all keyless JSON).
- **USDINR + indices via Yahoo** (`USDINR=X` 5969 dailies verified);
  GIFT Nifty indicative only (NSE marketStatus scrape, display-only).

## 1d. Commodities / FX / rates / crypto-derivatives (all live-probed)

- **Yahoo futures/FX/yields/VIX** (`GC/SI/HG/CL/BZ/NG/ZC/ZS/ZW/KC/CC/SB/CT=F`,
  `EURUSD=X` + crosses, `^TNX/^FVX/^IRX`, `^VIX`): full interval set,
  front-month continuous **not back-adjusted** (roll gaps stay — label it).
- **Binance derivatives (keyless REST):** `fapi/v1/fundingRate` +
  `futures/data/openInterestHist` (+ L/S ratios, premium index) — new
  derivatives panel data, trivial REST.
- **ECB SDMX (keyless, stable):** `EXR` daily FX reference + `YC` daily euro
  curves (`SR_1Y…30Y`) + `IRS` country 10Y — unique euro-rates fill.
- **Dukascopy tick data: deferred** (binary LZMA pipeline, only if >60d
  intraday FX needed). **Swissquote BBO:** live-quote garnish only.
- **AMFI NAV:** cheap daily lines (see §1c).
- Ruled out: FRED/EIA/CoinGlass (keyed), LBMA official (licence),
  Pink Sheet (monthly XLSX churn), VIX term-structure scrape (fragile).

## 1e. Foreign-market gaps + calendars (researched 2026-10-14)

- **Suffix corrections (ship immediately):** Tadawul `.SR`→`.SAU`,
  Madrid `.ES`→`.MC`; Egypt `.CA` is index-only; HNX/Beijing-BSE unsupported.
- **China: Yahoo insufficient** (empty 1m, smallcap gaps) → primary
  **baostock** (keyless, own server, daily 1990→ + 5–60m, adjusted) +
  **akshare** secondary (broad, scrape-fragile, needs upgrades);
  Yahoo `.SS/.SZ` last-resort fallback. Never mislabel.
- **Delisted honesty:** dead tickers return empty — surface "history
  unavailable", never silently drop (survivorship!).
- **`exchange_calendars` pip package** covers all needed MICs except
  XNSE (proxy XBOM + NSE holiday JSON shim), XSHE (proxy XSHG), XQAT/XKFE/
  XCAI/XSTC (weekend-only stubs; Gulf Fri–Sat already encoded).

## 1f. Aggregator ranking (maintenance-weighted, 2026-10-14)

1. **CCXT** (daily releases, 103 venues, MIT) — crypto core, ports 1:1.
2. **akshare** (hyper-maintained, MIT) — China/HK/US/futures/macro breadth.
3. **yfinance** (21-day cadence, 25k★) — primary Western source; bus-factor-1 risk noted.
4. **baostock** (own-server, stable) — A-share insurance next to akshare.
5. **nsepython behind HTTP** (only working NSE client, Oct-2026 Akamai fix; **GPL-3.0 → isolate behind the companion HTTP boundary, never import into MIT tree**).
6. **Stooq raw CSV** (zero-dep fallback for indices/commodities; throttled).
7. **pandas-datareader: World Bank slice only** (Yahoo/Stooq readers dead).
8. **yahooquery** (fundamentals supplement; thinner health).
9. **Raw `websocket-client` → BitShares nodes** (lightest reads; no signing deps).
10. **python-bitshares** (only if wallet/account ops ever needed).
11. **tvdatafeed quarantined** (fragile TV scraper; single-symbol gap-filler max).
12. **bsedata** (BSE niche; iff needed).
OUT: investpy, nsetools, nsepy, IEX, tushare, all keyed vendors.

## 2. Three-tier market picker (SDK → venue → instrument)

The symbol modal becomes three cascading tiers; each tier shows capability flags. Nothing is ever pickable that cannot load.

- **Tier 1 — SDK (the pipeline):** `CCXT Live` (browser) · `Stocks & Indices` (companion) · `DEX Pools` (companion) · `BitShares` (companion). Disabled with reason when its transport is down (no bundle / no companion).
- **Tier 2 — venue:** CCXT → exchange (existing 103, ✓ verified first); Stocks → market (`US` `NSE` `BSE` `LSE` `TSE` `TSX` `ASX` `B3` `HKEX` `Euronext` → Yahoo suffix map); DEX → network (36 DexPaprika ids, search-filtered); BitShares → venue fixed (node auto-selected, shown read-only).
- **Tier 3 — instrument:** pair automplete (today); symbol search (Yahoo search + suffix hint, e.g. `RELIANCE.NS`); pool search (token/network + volume/liquidity filters → `network:address`); BitShares `BASE:QUOTE`.
- **Candle sizes:** interval options filtered per source from the matrix in §3; picking across sources keeps the closest supported size and says so. Unsupported size for a source is unselectable, never silently reaggregated.
- **Streaming tip:** every tier-1/venue row carries a live badge — `● LIVE` (CCXT WS, DexPaprika SSE showcase), `~Xs poll` (companion cadence label per source), `snapshot` (EOD/daily-only). Same vocabulary as the chart's status dot.
- URL scheme stays TV-compatible and gains `source` + `venue` params; layout persists source/venue/instrument/interval.

## 3. Candle-size matrix (all sizes where possible)

| Source | Sizes |
|---|---|
| CCXT | per-exchange timeframes (existing map; extend to 3m/4h where offered) |
| Yahoo/yfinance | 1m 2m 5m 15m 30m 60m 90m 1h 1d 5d 1wk 1mo 3mo (intraday ≤60d) |
| DexPaprika | 1m 5m 10m 15m 30m 1h 6h 12h 24h |
| GeckoTerminal | 1m 5m 15m 1h 4h 12h 1d (skip sub-minute) |
| BitShares | 60 300 900 1800 3600 14400 86400s (validate via `get_market_history_buckets`) |
| NSE/BSE direct, Nasdaq daily | 1d only (+ today-1m tape for Nasdaq) |

Range→interval map generalizes per source (e.g. DEX: All→24h/1d; stocks intraday capped by 60d depth).

## 4. Companion API (localhost only)

`GET /api/candles?source=&venue=&id=&interval=&from=&to=` → `{t,o,h,l,c,v}[]` + `{source, cached_at, ttl, stale, fallback[]}`. `GET /api/search|quote|depth|networks|pools` likewise. Rules: bind `127.0.0.1` only; `Access-Control-Allow-Origin: *`; strict input validation (`^[A-Z0-9.\-=^:/]{1,64}$`-class per field); in-memory TTL + single-flight per key (Binance 5–10s, DexPaprika 60s, Yahoo 60–300s, BitShares 10–30s); on-disk cache for OHLCV history + metadata only (**never depth**); error passthrough with reasons; optional local `config.json` BYOK later (file, never repo).

## 5. Page integration

- `js/data.js`: `resolveMarket` gains `source:` routing (`ccxt:` default preserves every existing URL); companion fetch + normalize per source; `mergeCandle` unchanged (streaming just works); watchlist stays CCXT snapshot in V1.
- Symbols: `source:venue:instrument` internally (`dexpaprika:ethereum:0x…`, `yahoo:NSE:RELIANCE.NS`, `bitshares::BTS:USD`); header shows human venue + pair; SELL/BUY pills follow last close everywhere.
- Orderbook UI (minimum, phased): spread readout in header → compact depth ladder (15/side, click-to-price) → chart-margin walls toggle. BitShares orientation (base:quote by asset-id) normalized once, in the companion.

## 6. Phases

### Phase 0: companion skeleton + probe
- [ ] `tooling/companion/` stdlib server: `/health`, `/api/candles` echo with fixtures, strict validation, ACAO `*`, localhost-only bind.
- [ ] Page: probe companion at boot, status in symbol modal tier-1 (companion tiers disabled with reason when absent).
- [ ] Suffix corrections: `.SR`→`.SAU`, `.ES`→`.MC`; Egypt-`.CA`-index-only + HNX/Beijing unsupported states.
- [ ] Verify: boot with/without companion; modal states; `npm test`; no console errors.
- [ ] Commit.

### Phase 1: equities (yfinance) + three-tier picker + interval matrix
- [ ] Companion: yfinance import, `/api/candles` (auto_adjust, suffix map, `.NS`→`.BO` fallback), `/api/search`, TTL cache, 429 backoff, error reasons.
- [ ] Page: three-tier modal (SDK/venue/instrument), per-source interval filter, streaming-tip badges, URL + layout persistence.
- [ ] China route: baostock history + akshare spot behind `sh./sz./bj.` mapping (T+1 banner); Yahoo `.SS/.SZ` fallback only.
- [ ] India calendar shim: NSE holiday JSON over XBOM proxy; delisted-ticker honesty state.
- [ ] Verify: US + NSE + LSE + index symbols paint with correct suffixes; China A-share paints via baostock; bad/dead symbol → honest error; harnesses green.
- [ ] Commit.

### Phase 2: DEX pools (DexPaprika primary, GeckoTerminal fallback)
- [ ] Companion: klines pagination (366 clamp), `/api/pools/search`, batch prices, credit/rate budgeting, GeckoTerminal `before_timestamp` backfill.
- [ ] Page: DEX tier (network → pool search), `network:address` symbols, 24h-window honesty + backfill note.
- [ ] Verify: Uniswap + Solana pools paint; pagination (600+ bars, no dupes); exhausted budget → honest stale state.
- [ ] Commit.

### Phase 3: BitShares (klines + orderbook + ticker + feeds) + depth UI minimum
- [ ] Companion: seed nodes + latency sort + history-plugin probing, `get_market_history` chunking, `get_order_book`, `get_ticker`+`get_bitasset_data` join, feed age; **ES (`es.bitshares.dev`, op-63/op-4 + `search_after`) for pool-swap history beyond the native 101-row window**; XBTS REST fallback for order-book daily.
- [ ] Page: BitShares tier, spread readout in header, depth ladder; expired-feed surfacing.
- [ ] Verify: BTS:USD paints; book + ticker + feed join correct; pool history deep via ES; dead-node failover by killing first seed.
- [ ] Commit.

### Phase 3b: commodities / FX / rates / derivatives + India depth
- [ ] Companion: Yahoo futures/FX/yields/VIX route (front-month-no-adjust label); Binance funding + OI history; ECB EXR/YC/IRS; NSE MCP bhavcopy + holidays/CAs + archives fallback; AMFI NAV lines; MCX (403-tolerant, P2); USDINR via Yahoo.
- [ ] Page: asset-class sections in tier-2/3, futures roll-gap footnote, derivatives panel (funding + OI), MF line rendering.
- [ ] Verify: GC=F + EURUSD=X + ^TNX + funding/OI paint; RELIANCE history + CA factors; MF NAV line; NCDEX correctly absent.
- [ ] Commit.

### Phase 4: live everywhere + polish
- [ ] CCXT WS where supported (+`watchOrderBook` probe first, native WS fallback); DexPaprika SSE showcase; per-source poll TTLs; stale badges; Nasdaq cross-check; on-disk OHLCV cache (never depth); Dukascopy only if >60d intraday FX demanded.
- [ ] Verify: tick/append per source; kill-switch → fallback + toast; full harness suite green.
- [ ] Commit.

## Self-Review

- **Coverage:** every researched source appears in §1→phases; picker tiers/interval/streaming-tip requirements → §2/§3; companion direction → §4; integration → §5. No gaps.
- **Placeholders:** none — endpoints, intervals, limits, file paths, and verification gates are concrete.
- **Consistency:** `network:address` pool form, `{t,o,h,l,c,v}` pipe, TTL numbers, and venue naming match across sections.
