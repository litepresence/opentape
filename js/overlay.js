// js/overlay.js — crosshair, drawing rendering and hit-testing.
import { xForTime, yForPrice, visibleRows, sliceOffset, xForRowTime } from './chart.js';
import { ANCHORS as ANCHOR_COUNTS } from './drawings.js';

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 1];
const FONT = '11px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
const SEL = '#2962FF';
const IDLE = '#787b86';

// Index-based hitTest over the visible slice so hover agrees with candle x.
// Returns the index into the FULL rows array (offset + sliced index).
export function hitTest(mx, vis, left, width, rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const sliced = visibleRows(rows, vis);
  const src = sliced.length ? sliced : rows;
  const off = sliced.length ? sliceOffset(rows, sliced) : 0;
  const step = width / Math.max(1, src.length);
  let best = 0, bd = 1e18;
  src.forEach((r, i) => { const x = left + i * step + step / 2; const d = Math.abs(x - mx); if (d < bd) { bd = d; best = i; } });
  return off + best;
}
export function drawCrosshair(ctx, mx, my, geom, pal) {
  ctx.save(); ctx.strokeStyle = pal.text; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(mx, geom.top); ctx.lineTo(mx, geom.top + geom.height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(geom.left, my); ctx.lineTo(geom.left + geom.width, my); ctx.stroke(); ctx.restore();
}
function tx(t, state, geom, sliced) {
  if (sliced && sliced.length) return xForRowTime(t, sliced, geom.left, geom.width);
  return xForTime(t, state.visible, geom.left, geom.width);
}
const px = (d, i, state, geom, sliced) => {
  const p = d.points[i];
  if (!p || !Number.isFinite(p.p)) return null;
  const x = Number.isFinite(p.t) ? tx(p.t, state, geom, sliced) : geom.left;
  return Number.isFinite(x) ? { x, y: yForPrice(p.p, state.price, geom.top, geom.height) } : null;
};
// A drawing needs every anchor it declares before it can be drawn or hit —
// one malformed record (legacy 1-point trend, hostile localStorage) must never
// throw out of the render/hit path and freeze the whole chart.
const drawable = (d) => {
  if (!d || !Array.isArray(d.points) || !d.points.length) return false;
  const need = d.type === 'brush' ? 2 : (ANCHOR_COUNTS[d.type] ?? 2);
  return d.points.length >= need && d.points.slice(0, need).every(p => p && Number.isFinite(p.p));
};
function handle(ctx, x, y, color) {
  ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
}
function path(ctx, pts) {
  ctx.beginPath();
  pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
}

// One drawing, one geometry path — shared by render and hit-test so the
// selectable region always matches what is painted.
function outline(d, state, geom, sliced) {
  if (!drawable(d)) return [];
  const n = d.points.length;
  if (d.type === 'trend' || d.type === 'ray') {
    const a = px(d, 0, state, geom, sliced), b = px(d, 1, state, geom, sliced);
    return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  }
  if (d.type === 'prediction') {
    // Two clicks anchor the solid stem; the line extrapolates to the edge.
    const a = px(d, 0, state, geom, sliced), b = px(d, 1, state, geom, sliced);
    const dx = b.x - a.x, dy = b.y - a.y;
    if (!dx) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
    const k = (geom.left + geom.width - a.x) / dx;
    return [{ x: a.x, y: a.y }, { x: a.x + dx * k, y: a.y + dy * k }];
  }
  if (d.type === 'rect' || d.type === 'ellipse') {
    const a = px(d, 0, state, geom, sliced), b = px(d, 1, state, geom, sliced);
    return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  }
  if (d.type === 'fib') {
    const a = px(d, 0, state, geom, sliced), b = px(d, 1, state, geom, sliced);
    return [{ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }];
  }
  if (d.type === 'brush' || d.type === 'xabcd') {
    return d.points.map((_, i) => px(d, i, state, geom, sliced));
  }
  const a = px(d, 0, state, geom, sliced);
  return [{ x: a.x, y: a.y }, { x: a.x + 1, y: a.y }];
}

export function drawDrawings(ctx, drawings, state, geom, rows) {
  if (!drawings || !drawings.length || !state.visible || !state.price) return;
  const sliced = Array.isArray(rows) && rows.length ? visibleRows(rows, state.visible) : null;
  const src = sliced && sliced.length ? sliced : null;
  ctx.save();
  ctx.font = FONT;
  for (const d of drawings) {
    if (!drawable(d)) continue;
    const sel = d.id === state.selectedId;
    ctx.strokeStyle = sel ? SEL : IDLE;
    ctx.fillStyle = sel ? SEL : IDLE;
    ctx.lineWidth = sel ? 2 : 1;
    ctx.setLineDash([]);

    if (d.type === 'trend') {
      const [a, b] = outline(d, state, geom, src);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (d.type === 'ray') {
      const [a, b] = outline(d, state, geom, src);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + (b.x - a.x) * 3, a.y + (b.y - a.y) * 3); ctx.stroke();
    } else if (d.type === 'prediction') {
      const [a, b] = outline(d, state, geom, src);
      const stem = px(d, 1, state, geom, src);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(stem.x, stem.y); ctx.stroke();
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(stem.x, stem.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    } else if (d.type === 'horizontal') {
      const y = yForPrice(d.points[0].p, state.price, geom.top, geom.height);
      // horizontal lines have no time anchor
      ctx.beginPath(); ctx.moveTo(geom.left, y); ctx.lineTo(geom.left + geom.width, y); ctx.stroke();
    } else if (d.type === 'rect') {
      const [a, b] = outline(d, state, geom, src);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else if (d.type === 'ellipse') {
      const [a, b] = outline(d, state, geom, src);
      ctx.beginPath();
      ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (d.type === 'fib') {
      const [a, b] = outline(d, state, geom, src);
      const p1 = d.points[0].p, p2 = d.points[1].p;
      const hi = Math.max(p1, p2), lo = Math.min(p1, p2);
      // shaded band between the anchors, then level lines + labels
      ctx.save();
      ctx.globalAlpha = 0.08;
      ctx.fillRect(a.x, Math.min(a.y, b.y), b.x - a.x, Math.abs(b.y - a.y));
      ctx.restore();
      for (const lv of FIB_LEVELS) {
        const price = hi - (hi - lo) * lv;
        const y = yForPrice(price, state.price, geom.top, geom.height);
        ctx.globalAlpha = (lv === 0 || lv === 1) ? 1 : 0.75;
        ctx.beginPath(); ctx.moveTo(a.x, y); ctx.lineTo(b.x, y); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillText(String(lv), b.x + 4, y + 3);
      }
    } else if (d.type === 'brush') {
      const pts = outline(d, state, geom, src);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      path(ctx, pts); ctx.stroke();
    } else if (d.type === 'xabcd') {
      const pts = outline(d, state, geom, src);
      path(ctx, pts); ctx.stroke();
      ['X', 'A', 'B', 'C', 'D'].slice(0, pts.length).forEach((L, i) => {
        ctx.fillText(L, pts[i].x - 7, pts[i].y - 6);
      });
    } else if (d.type === 'text' || d.type === 'icon') {
      const a = px(d, 0, state, geom, src);
      ctx.font = d.type === 'icon' ? '16px sans-serif' : FONT;
      ctx.fillText(d.text || (d.type === 'icon' ? '⭐' : ''), a.x + 5, a.y + 4);
      ctx.font = FONT;
    }

    if (sel) {
      for (let i = 0; i < d.points.length; i++) {
        if (!Number.isFinite(d.points[i]?.p)) continue;
        const h = px(d, i, state, geom, src);
        if (h) handle(ctx, h.x, h.y, SEL);
      }
    }
  }
  ctx.restore();
}

// Nearest anchor of the selected drawing within `tol` px, else -1.
export function hitTestAnchor(drawings, state, geom, rows, mx, my, tol = 8) {
  const sliced = Array.isArray(rows) && rows.length ? visibleRows(rows, state.visible) : null;
  const src = sliced && sliced.length ? sliced : null;
  const d = (drawings || []).find(x => x && x.id === state.selectedId);
  if (!drawable(d)) return -1;
  for (let i = 0; i < d.points.length; i++) {
    const p = d.points[i];
    if (!p || !Number.isFinite(p.p) || !Number.isFinite(p.t)) continue;
    const h = px(d, i, state, geom, src);
    if (Math.hypot(h.x - mx, h.y - my) <= tol) return i;
  }
  return -1;
}

// Body hit-test: nearest drawing whose outline passes within `tol` px.
export function hitTestDrawing(drawings, state, geom, rows, mx, my, tol = 6) {
  const sliced = Array.isArray(rows) && rows.length ? visibleRows(rows, state.visible) : null;
  const src = sliced && sliced.length ? sliced : null;
  let best = null, bd = tol;
  for (const d of drawings || []) {
    if (!drawable(d)) continue;
    if (d.type === 'horizontal') {
      const y = yForPrice(d.points[0].p, state.price, geom.top, geom.height);
      const dist = Math.abs(y - my);
      if (dist <= bd) { bd = dist; best = d; }
      continue;
    }
    const pts = outline(d, state, geom, src);
    for (let i = 0; i + 1 < pts.length; i++) {
      const dist = segDist(mx, my, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (dist <= bd) { bd = dist; best = d; }
    }
    // "Inside a shape" is a weaker signal than "on its outline": remember it
    // but let a genuine outline hit anywhere win.
    if (!best && (d.type === 'rect' || d.type === 'ellipse')) {
      const a = pts[0], b = pts[1];
      if (a && b && mx >= Math.min(a.x, b.x) && mx <= Math.max(a.x, b.x)
        && my >= Math.min(a.y, b.y) && my <= Math.max(a.y, b.y)) { best = d; }
    }
  }
  return best;
}
function segDist(px0, py0, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px0 - x1) * dx + (py0 - y1) * dy) / len2)) : 0;
  return Math.hypot(px0 - (x1 + t * dx), py0 - (y1 + t * dy));
}

export function drawAlerts(ctx, alerts, state, geom) {
  if (!alerts || !alerts.length || !state.price) return;
  ctx.save();
  ctx.font = FONT;
  for (const a of alerts) {
    if (!Number.isFinite(a.price)) continue;
    const y = yForPrice(a.price, state.price, geom.top, geom.height);
    const sel = a.id === state.selectedId;
    ctx.strokeStyle = '#F23645';
    ctx.lineWidth = sel ? 2 : 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(geom.left, y); ctx.lineTo(geom.left + geom.width, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#F23645';
    const label = String(Math.round(a.price));
    const w = ctx.measureText ? ctx.measureText(label).width + 8 : 60;
    ctx.fillRect(geom.left + geom.width - w, y - 9, w, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, geom.left + geom.width - w + 4, y + 4);
  }
  ctx.restore();
}
// Pending rubber-band preview: anchor dots + dashed preview to the cursor
// (multi-anchor tools accumulate; the newest segment tracks the pointer).
export function drawPending(ctx, pending, cursor, state, geom, rows) {
  if (!pending || !Array.isArray(pending.points) || !pending.points.length) return;
  const sliced = Array.isArray(rows) && rows.length ? visibleRows(rows, state.visible) : null;
  const src = sliced && sliced.length ? sliced : null;
  const pts = pending.points.map(pt => ({ x: tx(pt.t, state, geom, src), y: yForPrice(pt.p, state.price, geom.top, geom.height) }));
  const x2 = cursor && Number.isFinite(cursor.x) ? cursor.x : pts[pts.length - 1].x;
  const y2 = cursor && Number.isFinite(cursor.y) ? cursor.y : pts[pts.length - 1].y;
  ctx.save();
  ctx.strokeStyle = SEL;
  ctx.fillStyle = SEL;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
  pts.forEach((q) => handle(ctx, q.x, q.y, SEL));
  ctx.restore();
}
