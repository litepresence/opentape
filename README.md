# Opentape — an open chart terminal

Opentape is a clean-room crypto chart terminal in vanilla
HTML/JS/CSS — dependency-free in the browser. No frameworks, no chart
libraries, no hosted backend, no build step:
one static page with a pure-canvas chart engine, live public market data,
drawings, 85 technical studies, replay mode, and a watchlist.

![Opentape dark terminal](tooling/shots/readme/readme-dark.png)

## Run it

```bash
python opentape.py        # from the repo root: static terminal :8787 + data proxy :8788, opens browser
# open http://localhost:8787/
```

That's the whole thing — Python only. Live Binance candles load automatically from
the browser; if the data can't load you get an explicit error and a retry rather
than a stale or mislabeled chart. `npm install` exists solely for
the optional Playwright verify/audit harness (`npm run verify`); the 69 unit
tests are stdlib-only (`npm test`, or bare `node --test tests/*.test.mjs`).

## Installation

Python 3.8+ only — no install step, no build, no other dependencies:

```bash
python opentape.py                 # terminal + proxy, opens your browser
python opentape.py --no-browser    # serve only
python opentape.py --port 8787 --companion-port 8788
```

`opentape.py` boots two localhost servers: the static terminal (`:8787`)
and the data proxy (`:8788`), which fetches every source the browser cannot
reach directly (CORS-blocked APIs) and serves it back as JSON. Without the
proxy, the CCXT/browser-direct markets keep working and every proxied picker
tier shows disabled *with its reason* (each links back here).

Optional pip packages unlock more proxy sources. They are never
auto-installed — a source whose library is missing simply reports why:

| Package | Unlocks |
|---|---|
| `yfinance` | Stocks & indices history (already covered stdlib-only; the lib adds search robustness) |
| `websocket-client` | BitShares live reads |
| `akshare` | China spot data |
| `baostock` | China history |

```bash
pip install yfinance websocket-client akshare baostock   # any subset; restart opentape.py after
```

## What it does

- **Chart**: pan (drag, either axis follows TradingView conventions), wheel
  zoom per axis, auto price scale with manual override, crosshair + OHLC
  tooltip, last-price and volume tags that follow candle direction.
- **Drawings**: the original's full 12-group sidebar — Cursors, Trend tools,
  Gann and Fibonacci tools, Patterns, Forecasting and measurement tools,
  Geometric shapes, Annotation tools, Icons — every group opens a menu with the
  same sections, shortcuts and switches, and every tool places real geometry
  (87 anchored tools, unlimited instances each).
- **Rail modes**: measure, zoom, magnets (weak/strong, snap to indicators),
  stay-in-drawing-mode, lock options, hide options, remove options.
- **Studies**: 85 indicators with fully parameterized, multi-instance plots —
  build an SMA mesh, tune every period, color and toggle each instance.
- **Terminal extras**: replay mode, symbol/timeframe switching with real
  exchange intervals, multi-layout save, PNG export, watchlist, light/dark.

## Indicator showcase

All plots below are rendered by the app itself (BTCUSD daily, dark theme).

**SMA mesh** — three instances (10/20/50), distinct colors, one study:

![SMA mesh](tooling/shots/readme/readme-mesh.png)

**Bollinger Bands** — band fill between upper/lower:

![Bollinger Bands](tooling/shots/readme/readme-bbands.png)

**MACD + RSI** — shared oscillator pane, union-scaled:

![MACD + RSI](tooling/shots/readme/readme-macd-rsi.png)

**Ichimoku** — five-line overlay:

![Ichimoku](tooling/shots/readme/readme-ichimoku.png)

**Heikin-Ashi** — transform studies replace the candle source:

![Heikin-Ashi](tooling/shots/readme/readme-heikin.png)

**Study modal** — every parameter editable, every study multi-instanceable:

![Study modal](tooling/shots/readme/readme-modal.png)

**Light theme** — one click, no flash, persisted:

![Light theme](tooling/shots/readme/readme-light.png)

## Architecture (30 seconds)

- `index.html` — shell (topbar, rail, chart, axes, footer, watchlist).
- `js/viewstate.js` — single source of truth; every mutation flows through it.
- `js/chart.js` + `js/axes.js` + `js/overlay.js` — stacked canvases: market
  data, crosshair/drawings, axes.
- `js/data.js` — CCXT browser bundle (Binance default), live public data only;
  GET-only, no keys, no trading desk, no embedded dataset.
- `js/studies.js` + `indicators/` — 85-study registry (overlay/bands/pane/
  multiline/transform) over vendored pure-math functions.
- `tooling/` — Playwright harness: verify, control audits, screenshot recipes.

## Status

Working terminal, actively refined against the live reference. See
`AGENTS.md` for the mission, conventions, and evidence notes. Beyond spot
crypto, stocks/indices/DEX pools/BitShares flow through the optional local
proxy (`python opentape.py`) — see Installation.
