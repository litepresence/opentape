// js/overlay.js
import { xForTime, yForPrice, visibleRows, sliceOffset, xForRowTime } from './chart.js';
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 1];
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
// x mapping shared with the candle renderer: when rows are provided, map
// time via the visible-slice index layout; otherwise fall back to xForTime.
function tx(t, state, geom, sliced) {
  if (sliced && sliced.length) return xForRowTime(t, sliced, geom.left, geom.width);
  return xForTime(t, state.visible, geom.left, geom.width);
}
export function drawDrawings(ctx, drawings, state, geom, rows) {
  if (!drawings || !drawings.length || !state.visible || !state.price) return;
  const sliced = Array.isArray(rows) && rows.length ? visibleRows(rows, state.visible) : null;
  const src = sliced && sliced.length ? sliced : null;
  ctx.save();
  ctx.font = '11px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  for (const d of drawings) {
    const sel = d.id === state.selectedId;
    ctx.strokeStyle = sel ? '#2962FF' : '#787b86';
    ctx.fillStyle = sel ? '#2962FF' : '#787b86';
    ctx.lineWidth = sel ? 2 : 1;
    ctx.setLineDash([]);
    if (d.type === 'trend' && d.p1 && d.p2) {
      const x1 = tx(d.p1.t, state, geom, src);
      const y1 = yForPrice(d.p1.p, state.price, geom.top, geom.height);
      const x2 = tx(d.p2.t, state, geom, src);
      const y2 = yForPrice(d.p2.p, state.price, geom.top, geom.height);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      for (const [x, y] of [[x1, y1], [x2, y2]]) { ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill(); }
    } else if (d.type === 'horizontal' && Number.isFinite(d.price)) {
      const y = yForPrice(d.price, state.price, geom.top, geom.height);
      ctx.beginPath(); ctx.moveTo(geom.left, y); ctx.lineTo(geom.left + geom.width, y); ctx.stroke();
    } else if (d.type === 'fib' && d.p1 && d.p2) {
      const x1 = tx(d.p1.t, state, geom, src);
      const x2 = tx(d.p2.t, state, geom, src);
      const lo = Math.min(d.p1.p, d.p2.p), hi = Math.max(d.p1.p, d.p2.p);
      for (const lv of FIB_LEVELS) {
        const p = hi - (hi - lo) * lv;
        const y = yForPrice(p, state.price, geom.top, geom.height);
        ctx.globalAlpha = lv === 0 || lv === 1 ? 1 : 0.8;
        ctx.beginPath(); ctx.moveTo(Math.min(x1, x2), y); ctx.lineTo(Math.max(x1, x2), y); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillText(String(lv), Math.max(x1, x2) + 4, y + 3);
      }
    } else if (d.type === 'text' && Number.isFinite(d.t) && Number.isFinite(d.p)) {
      const x = tx(d.t, state, geom, src);
      const y = yForPrice(d.p, state.price, geom.top, geom.height);
      ctx.fillText(d.text || '', x + 4, y - 4);
      ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill();
    }
  }
  ctx.restore();
}
export function drawAlerts(ctx, alerts, state, geom) {
  if (!alerts || !alerts.length || !state.price) return;
  ctx.save();
  ctx.font = '11px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
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
