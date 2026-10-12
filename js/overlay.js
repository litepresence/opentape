// js/overlay.js
import { xForTime, yForPrice } from './chart.js';
export function hitTest(mx, vis, left, width, rows) {
  const step = width / Math.max(1, rows.length);
  let best = 0, bd = 1e18;
  rows.forEach((r, i) => { const x = left + i * step + step / 2; const d = Math.abs(x - mx); if (d < bd) { bd = d; best = i; } });
  return best;
}
export function drawCrosshair(ctx, mx, my, geom, pal) {
  ctx.save(); ctx.strokeStyle = pal.text; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(mx, geom.top); ctx.lineTo(mx, geom.top + geom.height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(geom.left, my); ctx.lineTo(geom.left + geom.width, my); ctx.stroke(); ctx.restore();
}
