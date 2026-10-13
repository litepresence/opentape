# Drawing Rail Parity — Spec & Plan (2026-10-13)

Reference: `Screenshot from 2026-10-13 12-16-30.png` (original left sidebar, zoomed).
Reference 2: `Screenshot from 2026-10-12 18-38-59.png` (full app).

## Spec

### Gap analysis (ours vs original)

| # | Original tool | Ours today | Status |
|---|---|---|---|
| 1 | Cross | `cross` | ok |
| 2 | Trend line | `trend` | place-only, no handles/move |
| 3 | Fib / Gann & Fibonacci | `fib` | place-only, flat levels |
| 4 | Patterns (XABCD) | — | **missing** |
| 5 | Prediction & measurement (extrapolate) | — | **missing** |
| 6 | Brush (freehand) | aliases to horizontal | **fake** |
| 7 | Text | `text` | prompt only |
| 8 | Icon | `emoji` | prompt only |
| 9 | Measure (ruler) | `measure` | marquee ok |
| 10 | Zoom in | `zoom` | momentary ok |
| 11 | Magnet | `magnet` | toggle ok |
| 12 | Stay in drawing mode | — | **missing** |
| 13 | Lock all drawings | `lock` | ok |
| 14 | Hide all drawings | `hide` | ok |
| 15 | Remove objects | `del` | ok |
| — | Geometric shapes (rect/ellipse/ray/line) | aliases to horizontal | **fake** |

Cross-cutting gap: **no selection/editing**. Drawings cannot be selected, moved, or adjusted —
the original shows anchor handles on the active trend line.

### Target model

Unified drawing record: `{ id, type, points: [{t, p}], text? }`, rendered in canvas
time/price coordinates (unchanged principle — pan/zoom stays correct). Legacy `{p1,p2,price,t}`
records migrate on load.

Types and anchors:
- `trend` 2 · `prediction` 2 · `fib` 2 · `ray` 2 · `rect` 2 · `ellipse` 2
- `brush` N (freehand path) · `xabcd` 5 (X,A,B,C,D) · `horizontal` 1 (price)
- `text`/`icon` 1 + `text`

Interactions (original behavior):
- Click body → select (blue highlight + anchor handles).
- Drag body → move whole drawing; drag anchor → adjust that anchor; magnet snap applies.
- `Delete`/`Backspace` → remove selection; `Escape` → deselect and return to cross.
- **Stay in drawing mode** toggle: on = tool persists after each placement (current behavior);
  off = tool returns to cross after each placement.
- Undo/redo covers place, move, adjust, delete (existing stacks).

Rail: 15 tools in 4 groups with separators, TV tooltip names:
cross, trend, fib, pattern, prediction, brush, text, icon | measure, zoom | magnet, stay,
lock, hide | remove.

## Plan

1. **`js/drawings.js` — model + migration**: `POINTS_FOR`, `migrateDrawing`, `drawingsEqual`
   anchors, `anchorCount`, `makeDrawing(type, points, extra)`.
2. **`js/overlay.js` — render + hit-test**: per-type drawing (brush path, rect/ellipse, ray,
   prediction with dashed extrapolation to the right edge, xabcd polyline with letters,
   fib with shaded band between anchors), anchor handles when selected, `hitTestDrawing`,
   `hitTestAnchor`.
3. **`js/ui.js` — interactions**: click-select, drag-move, drag-anchor (magnet), stay-mode,
   placement for new types, keyboard, undo/redo integration.
4. **`index.html` + `styles.css`** — rail rebuild (groups/separators/icons/tooltips), stay-mode
   button.
5. **Audit** `tooling/audit_drawings.mjs`: place/edit/move/delete every type; stay-mode toggle;
   persistence round-trip; zero page errors.
6. **Polish** — hit tolerance, handle styling, keyboard discoverability, docs.

## Definition of done
- Every original tool either implemented or deliberately omitted with rationale in AGENTS.md.
- No aliases pretending to be tools (brush/shape must be real).
- Selection, move, anchor-adjust, delete, undo/redo for every drawing type.
- Full unit suite green; drawing audit green; no console errors.
