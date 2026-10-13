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

## Drawing Rail Parity (2026-10-13, vs `Screenshot from 2026-10-13 12-16-30.png`)
All original rail tools implemented — no aliases pretending to be tools: cross, trend, fib,
xabcd, prediction (dashed extrapolation), brush (freehand), text, icon, geometric shapes
(horizontal/rect/ellipse/ray/line), measure, zoom, magnet, stay-in-drawing-mode, lock, hide,
remove. Unified `{id,type,points[]}` model in time/price coords; legacy `{p1,p2,price}`
records migrate on load. Every drawing supports click-select, body-drag (translates a
snapshot, so the delta can't accumulate), anchor-handle drag with magnet snap, Delete,
and undo/redo. Audit: `tooling/audit_drawings.mjs` (22 checks incl. malformed-record
crash-proofing and sub-pixel drag tracking). Study colors: auto palette advances per
*instance* as well as per line (`autoColor(id, ord, k)`), so an SMA mesh is multi-colored.

## Rail Parity With The Original Sidebar (2026-10-13)
The rail is **data-driven**: `js/tools.js` holds the whole sidebar (12 flyout
groups, 94 menu items, section headers, `Alt + X` shortcuts, switches), and
`js/ui.js` renders the rail, the menus and the emoji picker from it — the HTML
is just `<nav id="rail"></nav>`. Clicking a glyph arms that group's current
tool; the chevron at the glyph's right edge opens the menu (as measured on the
live chart, where hovering only shows a tooltip).

Ground truth is `tooling/tv-rail-spec.json`, distilled from live DOM captures by
`tooling/tv_menu_capture.mjs` → `tooling/derive_rail_spec.mjs`. Getting those
captures needed three fixes worth remembering: a full-viewport signup
interstitial (`div.modal-*`/`wrap-*`/`backdrop-*`) swallows *every* click and has
no close control, so it must be detached before measuring; the submenu chevron
is a real 11x34 button that its parent overlaps, so Playwright's actionability
check refuses it and raw mouse coordinates are required; and a menu opens only
from the chevron, because clicking the glyph body arms a tool — which, in an
anonymous session, raises the "Join for free" paywall.

Geometry lives in `js/geometry.js`: every tool reduces to a primitive list
(`line`/`path`/`rect`/`ellipse`/`arc`/`text`/`box`) that render and hit-test both
consume, so the selectable region always matches the paint. The Icons group has
no menu rows — it opens an emoji grid, and the chosen emoji arms the `icon` tool.

Audits: `tooling/audit_rail_parity.mjs` (structure vs the captured spec),
`tooling/audit_rail_browser.mjs` (real browser: menus, shortcuts, switches),
`tooling/audit_drawing_kinds.mjs` (every anchored tool paints real ink — each is
measured on a cleared canvas, since one translucent fill makes a global
pixel-delta meaningless). Navigation for the older audits is in
`tooling/rail_helpers.mjs`.

## Toolbar & Symbol Feedback (2026-10-14)
Every rail action gives visible feedback — toggles toast (`magnet`, `hide`, `lock`, `stay`,
`del`, `zoom`, shape submenu) and multi-anchor tools announce progress
(`Anchor 1/5 — click to set the next point`). The symbol modal hints as you type:
exchange names are derived from the browser bundle's lowercase classes (the bundle has **no**
`ccxt.exchanges` array — 103 venues, verified ones marked ✓ and listed first), pair lists come
from `loadMarkets()` per venue with a pair count. Parameterized URLs carry the venue:
`?symbol=BTC/USD&interval=1d&exchange=binance`, and `?exchange=` composes the qualified
`exchange:symbol` the router uses (sanitized to `[a-z][a-z0-9_]*`).
Audit: `tooling/audit_symbols.mjs` (8 checks).

## Lock Is Never a Silent Trap (2026-10-14)
`locked` persists, and its rail button used to look exactly like hover — a mode left on
was invisible, so picking a shape silently refused placement. Now: mode toggles
(magnet/stay/lock/hide) render an **engaged** style (accent fill + blue outline), a locked
terminal shows a `Drawings locked · click to unlock` header badge, and every refusal toast
carries an **Unlock** button (as does the badge). `toggleLock()`/`syncLockBadge()` are
hoisted functions — a `const` pair here threw a temporal-dead-zone error during init and
blanked the app. Audit: `tooling/audit_lock.mjs` (10 checks).

## REA Findings (2026-10-13, from live tradingview.com capture)
- Font: `-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif` (no Segoe UI). Text `#0f0f0f`, chrome `#ebebeb`. Brand font EuclidCircular (proprietary — fallback only).
- Last-price line/tag follows bar direction (green up). Range→interval map: 1D→1m, 5D→5m, 1M→30m, 3M→1h, 6M→2h, YTD/1Y→1d, 5Y→1w, All→1M. 11 stacked canvases. Evidence in `tooling/rea-tv-inspect.json`, `tooling/shots/tv-real-1920.png`, `tooling/rea_tv_facts.mjs` (layout facts only — tree stays clean-room, no TV code/assets).

## Working Agreement
- Brainstorm → spec → plan → implement in phases: 1) core chart, 2) drawings, 3) indicators/alerts/replay, 4) themes/polish.
- Ask before adding deps beyond the pinned `ccxt` CDN bundle. Keep vanilla promise.
