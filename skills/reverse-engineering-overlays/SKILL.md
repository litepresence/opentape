---
name: reverse-engineering-overlays
description: Use when reverse-engineering a TradingView drawing overlay's behavior or perfecting a canvas financial overlay (fibs, pitchforks, patterns, positions, channels, annotations) in this repo's primitive geometry engine
---

# Reverse Engineering Overlays

## Overview

REA-style evidence loop adapted to this repo: observe the live original with
Playwright (screenshots, DOM, measured geometry), record the evidence, spec
the behavior, implement with our primitive vocabulary, verify with the audit
harness. Behavior facts only — clean-room throughout.

**Iron law: NEVER copy TradingView code, assets, fonts, orDom structure. Our
own line art, our own code. Labels, order, colors, and geometry facts are
evidence; implementation is always original.**

## When to Use

- Perfecting any builder in `js/geometry.js` (57 kinds in `references/kinds.md`)
- Any overlay renders as a stub (bare line/box where the original shows
  labels, prices, ratios, fills, or projected bars)
- Adding labels, axis tags, level prices, or stats readouts to a drawing

When NOT to use: rail structure/menus (`audit_rail_parity`), data fetching,
indicator math (`js/studies.js`).

## The Loop

1. **Observe.** Drive the live chart in Playwright: place the tool with known
   anchors, screenshot, read DOM/tooltips. Vary anchors (up/down trend,
   short/long span) to separate constant styling from data-driven output.
2. **Evidence.** Record: primitives drawn, exact label texts (ratios, prices,
   percents, bar counts), colors, line styles (solid/dash), fills + alpha,
   what extends to chart edges, what tracks axes. Numbers over adjectives.
3. **Spec.** Write the behavior spec FIRST: geometry rules, label formats,
   level sets, colors, edge cases (zero-span anchors, reversed points).
4. **Implement.** One builder function `(d, c) => prims[]` using only the
   primitive vocabulary and `ctx` API below plus existing helpers
   (`lerp`, `lerpP`, `rot`, `smoothPath`, `sample`). Never invent new op types
   without updating `paintPrimitives` AND `primDist` in `js/overlay.js`.
5. **Verify.** `node tooling/audit_drawing_kinds.mjs` (ink), `npm test`,
   zero console errors, side-by-side screenshot vs the original.

## Primitive Vocabulary

| op | fields |
|---|---|
| `line` | `x1,y1,x2,y2, dash?, arrows?` (`end`, `both`, `dot`) |
| `path` | `pts:[{x,y}], close?, smooth?, dash?, thick?, fill?` (fill = alpha 0-1) |
| `rect` | `x,y,w,h, fill?` |
| `ellipse` | `cx,cy,rx,ry` |
| `arc` | `cx,cy,r,a0,a1, dash?` |
| `text` | `x,y,text,align?,size?,color?` |
| `box` | `x,y,w,h,label?,variant?,image?` (stats/label panels) |

## ctx API (`makeCtx` in `js/overlay.js`)

`xy(p)` time/price→pixels; `geom` `{left,top,width,height,right,bottom}`;
`barWidth()`; `xForRow(r)`; `yForPrice(p)`; `lastRow()`; `window(x0,x1)` rows in
pixel range; `vwap(x0)` anchored-VWAP points; `volProfile(x0,x1)` 24-bin
`[{v,y}]`; `dateLabel(t0,t1)`. Anchors arrive as time/price; `d.variant`
selects sub-behavior; `d.labels` holds joint letters.

## Builder Contract

- Signature `(d, c)`, return primitive array. `buildPrimitives` drops any prim
  containing a non-finite number — degenerate anchors must yield `[]`, never
  `NaN` ink, never throw.
- Extend trend tools to chart edges (slope-projected, not axis-aligned
  shortcuts). Level tools print **level + price**; range tools print the stats
  box (bars, abs, %); pattern tools print joint letters AND leg ratios.
- One anchor-count source of truth: `js/tools.js`. Don't change counts here.

## Dispatched-Agent Deliverable Contract

Agents perfecting a kind return, in their final message, and edit NO files:
1. Behavior spec (geometry, labels, colors, numbers, edge cases).
2. Drop-in builder function code (full function body, original code).
3. Verification notes (anchors tried, what matches, known limits).

## Verification

- `node tooling/audit_drawing_kinds.mjs` — every anchored tool paints ink.
- `npm test` — 64 unit tests green, zero console errors.
- `tooling/compare_tv_local.mjs` — place/select/Delete/undo per family.
- Screenshots in `tooling/shots/` for side-by-side review.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Bare line where original shows labels/prices | Level+price on every fib/channel/range level |
| Axis-aligned shortcut (`y1:a.y`) instead of slope projection | Project through both anchors to the edge |
| One spiral for arcs AND spiral | Arcs = concentric level arcs; spiral = log spiral |
| Static text box for table/position/note | Real rows: entry/stop/target, risk, P&L, grid |
| Ghost/bar-pattern with no projected bars | Clone past bars forward (dashed/hollow style) |
| Ignoring `d.variant` (Schiff, square-fixed, short, highlight) | Branch per variant with measured math |
| New op type without hit-test | Update `paintPrimitives` AND `primDist` together |
