// js/chart.js
export const PAL = { light: { bg: '#ffffff', grid: '#e0e3eb', text: '#787b86', up: '#089981', down: '#F23645' }, dark: { bg: '#131722', grid: '#2a2e39', text: '#d1d4dc', up: '#089981', down: '#F23645' } };
export function xForTime(t, vis, left, width) { return left + ((t - vis.from) / (vis.to - vis.from)) * width; }
export function yForPrice(p, pr, top, height) { return top + (1 - (p - pr.min) / (pr.max - pr.min)) * height; }
export function niceTicks(min, max, n = 7) { const step0 = (max - min) / n; const mag = 10 ** Math.floor(Math.log10(step0)); const norm = step0 / mag; const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag; const out = []; for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v); return out; }
export function renderBase(ctx, state, rows, geom) {
  const pal = PAL[state.theme] || PAL.light;
  const { left, top, width, height } = geom;
  ctx.fillStyle = pal.bg; ctx.fillRect(left, top, width, height);
  ctx.strokeStyle = pal.grid; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
  for (const p of niceTicks(state.price.min, state.price.max)) { const y = Math.round(yForPrice(p, state.price, top, height)) + .5; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke(); }
  const step = width / Math.max(1, rows.length);
  const bw = Math.max(2, step * 0.6);
  const vh = height * 0.15;
  rows.forEach((r, i) => {
    const x = left + i * step + step / 2;
    const col = r.c >= r.o ? pal.up : pal.down;
    ctx.strokeStyle = col; ctx.setLineDash([]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, yForPrice(r.h, state.price, top, height)); ctx.lineTo(Math.round(x) + .5, yForPrice(r.l, state.price, top, height)); ctx.stroke();
    ctx.fillStyle = col;
    const yO = yForPrice(r.o, state.price, top, height), yC = yForPrice(r.c, state.price, top, height);
    ctx.fillRect(Math.round(x - bw / 2), Math.round(Math.min(yO, yC)), Math.round(bw), Math.max(1, Math.round(Math.abs(yC - yO))));
    ctx.globalAlpha = 0.4;
    const vmax = Math.max(...rows.map(q => q.v));
    const bh = (r.v / vmax) * vh;
    ctx.fillRect(Math.round(x - bw / 2), Math.round(top + height - bh), Math.round(bw), Math.round(bh));
    ctx.globalAlpha = 1;
  });
  // last-price dotted line
  const last = rows[rows.length - 1];
  if (last) { const y = yForPrice(last.c, state.price, top, height); ctx.strokeStyle = pal.down; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke(); ctx.setLineDash([]); }
}
