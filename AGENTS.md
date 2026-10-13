# AGENTS.md — Opentape Mission

## Mission
Build Opentape, an open chart terminal: a pixel-faithful, fully functional BTCUSD 1D desktop terminal in vanilla HTML/JS/CSS that exceeds the reference screenshot below. Clean-room implementation — no TradingView code, assets, logos, or fonts ship in this tree (reference captures under `tooling/` are measurement evidence only).

Reference: `Screenshot from 2026-10-12 18-38-59.png` in this directory. That image is ground truth for V1 visual fidelity.

## Run (Python only — no npm, no build, no server)
```bash
python3 -m http.server 8787   # from the repo root
# open http://localhost:8787/ — live Binance data; offline/blocked shows an error state (no fake candles)
```
`npm install` is needed only for the Playwright verify/audit harness (`npm run verify`); unit tests are stdlib-only (`npm test`, or bare `node --test tests/*.test.mjs` with no install at all).

## Objectives
1. **Pixel fidelity:** Top bar, left drawing rail (15 icons), OHLC header + SELL/BUY pills, candle chart (May–Oct), volume, right price axis (56k–90k), bottom time axis + range footer (1D–All), UTC clock, gear, TradingView watermark — match fonts, spacing, colors, dotted grid.
2. **Pure canvas engine:** Two stacked `<canvas>` (base: grid/candles/volume, overlay: crosshair/drawings). No chart libs, no frameworks. Vanilla JS modules only.
3. **Full functional (gold cup, no quirks):** Pan/zoom, crosshair + tooltip, price/time alerts, drawings (trend/horizontal/fib/text) with magnet snap + undo/redo, indicators (SMA/EMA/RSI), replay mode, symbol/timeframe/chart-type switching, layout save to localStorage.
4. **Data via CCXT browser bundle:** pinned `<script src="https://cdn.jsdelivr.net/npm/ccxt@4/dist/ccxt.browser.js" async>` exposes global `ccxt` (Binance default: `BTC/USD`→`BTC/USDT`). `js/data.js` (`resolveMarket` exchange routing, `whenCcxt` 15s wait on `ccxt-ready`, `fetchOHLCV` with `enableRateLimit`) fetches live public OHLCV. No embedded dataset — failures surface as a loading/error state with retry, never as another market's bars; reload-path failures keep last good data + toast.
5. **Themes + extras:** Dark default + light toggle via CSS vars + canvas palette swap (choice persisted). Extras beyond original: multi-layout save, PNG export.
6. **Live-only data:** no embedded/cached candles ship — a mislabeled market is worse than an empty chart.
6. **Responsive desktop:** Fluid layout matching ~1980px reference, reflows to smaller desktop windows. Mobile deferred.

## Scope / Non-Goals V1
- In: chart core, axes, drawings, indicators dialog, alert lines, replay, themes, browser-CCXT live data.
- Out: real brokerage execution, social/community, Pine Script editor, mobile layout.
- Aims: crypto-only data terminal (GET-only public data; no trading desk, no secrets). `server/` deleted — no backend, no npm `ccxt` dep. Stocks/forex deferred pending a CORS-open keyless or BYOK source.

## Architecture (Approved Option A)
- `index.html` — shell: topbar / left-rail / chart-area / axes / footer.
- `styles.css` — CSS vars `--bg`, `--grid`, `--up:#089981`, `--down:#F23645`, light/dark via `[data-theme]`.
- `js/viewstate.js` — single truth: visible range, price scale, theme, drawings, alerts.
- `js/chart.js` — base canvas render; `js/axes.js` — price/time axes; `js/overlay.js` — crosshair/drawings; `js/data.js` — browser-CCXT driver (global `ccxt` bundle, `resolveMarket` routing, `whenCcxt`/`fetchOHLCV`); `js/drawings.js`, `js/indicators.js`, `js/ui.js` — toolbar wiring.

## Conventions
- Vanilla only: no React/Vue/Tailwind, no chart libs. `ccxt` allowed only via the pinned CDN script tag (no npm dep, no server code).
- Canvas text: `-apple-system, Segoe UI, Roboto` to match TradingView; 1px wicks, 60% candle body spacing.
- All state mutations go through ViewState then `requestRender()`. No direct canvas writes from UI handlers.
- Tooling scripts (if any) live in `tooling/` per global rules — no inline scripts.

## Verification (Definition of Done)
- Side-by-side with reference PNG at 1920px: layout drift <2px, colors ΔE <3.
- Open `index.html` via any static server (or `github.io`): candles paint from live CCXT data once loaded; a blocked bundle/offline shows the error + retry state, with no console errors.
- Pan/zoom at 60fps, crosshair + OHLC correct, drawings persist after reload, light/dark toggle without flash.
- No console errors.

## REA Findings (2026-10-13, from live tradingview.com capture)
- Font: `-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif` (no Segoe UI). Text `#0f0f0f`, chrome `#ebebeb`. Brand font EuclidCircular (proprietary — fallback only).
- Last-price line/tag follows bar direction (green up). Range→interval map: 1D→1m, 5D→5m, 1M→30m, 3M→1h, 6M→2h, YTD/1Y→1d, 5Y→1w, All→1M. 11 stacked canvases. Evidence in `tooling/rea-tv-inspect.json`, `tooling/shots/tv-real-1920.png`, `tooling/rea_tv_facts.mjs` (layout facts only — tree stays clean-room, no TV code/assets).

## Working Agreement
- Brainstorm → spec → plan → implement in phases: 1) core chart, 2) drawings, 3) indicators/alerts/replay, 4) themes/polish.
- Ask before adding deps beyond the pinned `ccxt` CDN bundle. Keep vanilla promise.
