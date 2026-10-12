# TradingView Desktop Clone — Design Spec (2026-10-12)

Reference: `Screenshot from 2026-10-12 18-38-59.png` (BTCUSD 1D Bitstamp, light theme).
Stack: vanilla HTML/JS/CSS + Canvas, Node + CCXT proxy. Responsive desktop, light + dark.

## 1. Architecture
- Frontend: `index.html`, `styles.css`, `js/` modules. No frameworks, no chart libs.
- `js/viewstate.js`: single truth `{ symbol, timeframe, visible {from,to}, price {min,max}, theme, drawings[], alerts[], replayIndex }`. All UI mutations go through ViewState → `requestRender()`.
- Two stacked canvases in `.chart-area`: `#base` (grid, candles, volume, axes decorations) + `#overlay` (crosshair, drawing previews, alert lines). DevicePixelRatio scaling.
- Backend: `server/proxy.js` — Node http, `ccxt.bitstamp`, `GET /api/ohlcv?symbol=BTC/USD&timeframe=1d&limit=300`, 60s in-memory cache + JSON file cache. Serves `data/btcusd-1d.json` fallback.
- `data/btcusd-1d.json`: ~150 daily candles traced from screenshot for pixel-identical first paint offline.

## 2. Components
- **TopBar (48px):** hamburger, symbol search `BTCUSD`, premium diamond, compare `+`, timeframe `D`, candle-type, `Indicators`, templates grid, `Alert`, `Replay`, undo/redo, layout box, `Save` dropdown. SVG icons, 14px system font.
- **LeftRail (48px wide):** 15 tools: cross, trendline, fib retracement, brush/pitchfork, shapes, text, emoji, ruler/measure, zoom, magnet, lock, hide/eye, remove/trash, plus pattern tools. Active tool highlighted. Pixel-matched 32px hit areas.
- **ChartArea:** header row (BTC icon, `Bitcoin / U.S. Dollar · 1D · Bitstamp`, OHLC `O83679 H84254 L82207 C82473 -1206 (-1.44%)` red/green, SELL/BUY pills `82474`, `Vol·BTC 1.32K`), canvas, right price axis (56k–90k, bold at 60/70/80/90k), bottom time axis (May–Oct), range footer (`1D 5D 1M 3M 6M YTD 1Y 5Y All` + calendar), UTC clock `22:38:58 UTC`, gear, TradingView watermark bottom-left, globe cluster bottom-right.
- Isolation: each component exposes `render(state)`; only imports ViewState. No direct canvas writes from event handlers.

## 3. Data Flow
1. Load: `data.js` fetches `/api/ohlcv` → on fail uses embedded JSON. Shows toast when fallback active.
2. Normalize to `{t,o,h,l,c,v}` sorted ascending.
3. ViewState computes visible window (default: May→mid-Oct) + auto price min/max with 8% padding.
4. `chart.js` draws: dotted grid (`#e0e3eb`, 1px dotted), candles (up `#089981`, down `#F23645`, body 60% of step, wick 1px), volume bars (same color, 40% alpha, bottom 15% pane), last-price dotted red line + right-axis tag `82473` + time `01:21:01`, volume tag `1.32K`.
5. `axes.js` draws right + bottom axes (DOM overlay for crisp text, canvas for ticks).
6. Pan/zoom mutates `visible`/`price` only, then `requestAnimationFrame(render)`.

## 4. Interaction + Extras
- Drag = pan, wheel = zoom time (shift+wheel = price), dblclick = reset.
- Crosshair (dashed lines + axis labels + OHLC tooltip).
- Click price axis → price alert line (draggable, persists); Alt+click time axis → vertical time alert.
- Drawings: trend, horizontal, fib retracement, text. Stored in time/price coords, magnet snaps to OHLC within 8px, selection handles, Delete key, undo/redo stack (50), localStorage `tv-clone-layout-v1`.
- Indicators dialog: SMA(20/50), EMA, RSI(14), Volume toggle. Computed in `indicators.js`, drawn on base canvas.
- Replay: enters mode hiding future bars, `<-`/`->` step, play speed, exit restores full range.
- TopBar: symbol search switches `BTC/USD|ETH/USD|...` via proxy, timeframe D/1W/1H re-fetches, chart-type candles/bars/line, Save dropdown saves named layouts.
- Themes: `[data-theme=light|dark]` CSS vars + canvas palette swap (`bg #fff→#131722`, grid `#e0e3eb→#2a2e39`, text `#131722→#d1d4dc`). Toggle persisted, no flash (inline `data-theme` script in `<head>`).
- Extras beyond original: multi-layout save, PNG export (`canvas.toDataURL` composite), keyboard shortcuts.

## 5. Error Handling
- Proxy down/CORS → fallback JSON + non-blocking toast `Live data unavailable — showing cached`.
- CCXT rate-limit → serve stale cache with `X-Cache: STALE`, exponential backoff retry 5s/15s/60s.
- Invalid symbol/timeframe → header shows error state, chart keeps last good data.
- Empty/malformed OHLCV → validate `h>=l, h>=o,c>=l`; drop bad rows, log warning.

## 6. Testing / Definition of Done
- Visual: side-by-side at 1920px, layout drift <2px, candle colors ΔE <3 vs screenshot eyedropper.
- Functional: pan/zoom 60fps (measure via rAF), crosshair OHLC matches hovered candle, drawings persist after reload, light/dark toggle without flash, proxy returns 300 rows, fallback works with server stopped.
- No console errors, vanilla only (audit: no `import` of React/Vue/chart libs; `ccxt` only in `server/`).

## 7. Phases
1. Core chart + axes + proxy + fallback. 2. Drawings + alerts + persistence. 3. Indicators + replay + symbol/timeframe switching. 4. Themes + extras + polish to gold-cup.
