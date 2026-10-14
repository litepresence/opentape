# Live OHLCV streaming — design (2026-10-14)

## Goal
Keep the visible chart live at the selected symbol + interval: the forming
candle ticks, new candles append, header/pills/clock follow, drawings persist.
No new dependencies — rides the already-pinned `ccxt` browser bundle, whose
`ccxt.pro` surface (`watchOHLCV`) was probed present in a live headless page.

## Non-goals
Real brokerage execution, ticker/level-2, order/alert triggering on stream,
backfill beyond the 300-bar load window, multi-symbol streaming (watchlist
stays snapshot), replay interaction changes.

## Architecture
- `js/data.js`: `mergeCandle(rows, candle)` pure helper (same-`t` merge:
  `h=max, l=min, c, v`; greater-`t` append; older-`t` ignored) + `watchCandles`
  subscription helper (capability check → `watchOHLCV` loop with backoff).
- `js/ui.js`: stream lifecycle (`startStream` after every successful load /
  reload, `stopStream` before switching), status dot near the clock
  (LIVE / DELAYED / OFFLINE), render + conditional refit on each update.
- Transports: WS primary via `ccxt.pro`; REST polling fallback
  (`fetchOHLCV` last bars on a per-interval cadence) when the exchange lacks
  WS support, the socket fails, or the tab is hidden (pause/resume on
  `visibilitychange`).

## Behavior
- Subscribe on boot (after first successful `loadData`) and on every
  successful `reload`; exactly one active subscription; unsubscribe on switch.
- Each candle: merge-or-append into `rows` (cap ~2000, drop oldest), then the
  existing render path; refit price to visible bars only when
  `priceAuto !== false`; OHLC header + SELL/BUY pills follow the last bar.
- Replay active: append to `rows` but do not advance `replayIndex`; header
  keeps following replay.
- Stale threshold per interval (>2× interval silence → DELAYED); stream error
  → toast + polling fallback (existing reload contract: never fake data, keep
  last good rows).
- Drawings/alerts/lock/hide/replay semantics unchanged; public data only.

## Verification
- Unit: `mergeCandle` merge/append/ignore/cap cases (`npm test`).
- Headless: stubbed `watchOHLCV` delivering scripted candles → rows, header,
  and refit update; kill-switch → fallback engages, no console errors.
- Existing harnesses stay green (kinds ink, drawings, rail, compare).
