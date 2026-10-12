# AGENTS.md — TradingView Desktop Clone Mission

## Mission
Reverse-engineer a pixel-by-pixel identical copy of the provided TradingView desktop screenshot (BTCUSD 1D, Bitstamp) in vanilla HTML/JS/CSS, then evolve it into a fully functional, polished terminal that exceeds the original.

Reference: `Screenshot from 2026-10-12 18-38-59.png` in this directory. That image is ground truth for V1 visual fidelity.

## Objectives
1. **Pixel fidelity:** Top bar, left drawing rail (15 icons), OHLC header + SELL/BUY pills, candle chart (May–Oct), volume, right price axis (56k–90k), bottom time axis + range footer (1D–All), UTC clock, gear, TradingView watermark — match fonts, spacing, colors, dotted grid.
2. **Pure canvas engine:** Two stacked `<canvas>` (base: grid/candles/volume, overlay: crosshair/drawings). No chart libs, no frameworks. Vanilla JS modules only.
3. **Full functional (gold cup, no quirks):** Pan/zoom, crosshair + tooltip, price/time alerts, drawings (trend/horizontal/fib/text) with magnet snap + undo/redo, indicators (SMA/EMA/RSI), replay mode, symbol/timeframe/chart-type switching, layout save to localStorage.
4. **Data via CCXT:** `server/proxy.js` (Node + `ccxt` npm) fetches Bitstamp BTC/USD 1D OHLCV, caches 60s, serves `/api/ohlcv`. Frontend falls back to embedded `data/btcusd-1d.json` (traced from screenshot) for offline pixel-identical first paint.
5. **Themes + extras:** Light (default, matches screenshot) + dark toggle via CSS vars + canvas palette swap. Extras beyond original: multi-layout save, PNG export.
6. **Responsive desktop:** Fluid layout matching ~1980px reference, reflows to smaller desktop windows. Mobile deferred.

## Scope / Non-Goals V1
- In: chart core, axes, drawings, indicators dialog, alert lines, replay, themes, proxy.
- Out: real brokerage execution, social/community, Pine Script editor, mobile layout.

## Architecture (Approved Option A)
- `index.html` — shell: topbar / left-rail / chart-area / axes / footer.
- `styles.css` — CSS vars `--bg`, `--grid`, `--up:#089981`, `--down:#F23645`, light/dark via `[data-theme]`.
- `js/viewstate.js` — single truth: visible range, price scale, theme, drawings, alerts.
- `js/chart.js` — base canvas render; `js/axes.js` — price/time axes; `js/overlay.js` — crosshair/drawings; `js/data.js` — fetch/cached/fallback; `js/drawings.js`, `js/indicators.js`, `js/ui.js` — toolbar wiring.
- `server/proxy.js` — Node http + ccxt.bitstamp, `GET /api/ohlcv?symbol=BTC/USD&timeframe=1d&limit=300`.
- `data/btcusd-1d.json` — embedded fallback.

## Conventions
- Vanilla only: no React/Vue/Tailwind, no chart libs. `ccxt` allowed only in `server/`.
- Canvas text: `-apple-system, Segoe UI, Roboto` to match TradingView; 1px wicks, 60% candle body spacing.
- All state mutations go through ViewState then `requestRender()`. No direct canvas writes from UI handlers.
- Tooling scripts (if any) live in `tooling/` per global rules — no inline scripts.

## Verification (Definition of Done)
- Side-by-side with reference PNG at 1920px: layout drift <2px, colors ΔE <3.
- `node server/proxy.js` + open `index.html`: candles load from API, fallback works offline.
- Pan/zoom at 60fps, crosshair + OHLC correct, drawings persist after reload, light/dark toggle without flash.
- No console errors.

## Working Agreement
- Brainstorm → spec → plan → implement in phases: 1) core chart, 2) drawings, 3) indicators/alerts/replay, 4) themes/polish.
- Ask before adding deps beyond `ccxt`. Keep vanilla promise.
