// js/chart.js
import { STUDIES, computeStudy } from './studies.js';
export const PAL = { light: { bg: '#ffffff', grid: '#e0e3eb', text: '#787b86', up: '#089981', down: '#F23645' }, dark: { bg: '#131722', grid: '#2a2e39', text: '#d1d4dc', up: '#089981', down: '#F23645' } };
export const IND_COLORS = { sma20: '#2962FF', sma50: '#FF6D00', ema20: '#9C27B0', rsi: '#7E57C2' };
// Task 9: study line colors keyed by registry index (+ per-key offset).
export const STU_COLORS = ['#2962FF', '#FF6D00', '#9C27B0', '#00897B', '#E91E63', '#00ACC1', '#7CB342', '#FB8C00', '#5C6BC0', '#AD1457', '#6D4C41', '#00838F'];
export function stuColor(id, k = 0) {
  const i = STUDIES.findIndex(s => s.id === id);
  return STU_COLORS[((i < 0 ? 0 : i) + k + STU_COLORS.length) % STU_COLORS.length];
}
// Auto color for an instance: the palette advances per *instance* as well as
// per line, so several copies of one study (an SMA mesh) get distinct colors
// instead of all landing on palette[0] blue.
export function autoColor(id, ord = 0, k = 0) {
  const i = STUDIES.findIndex(s => s.id === id);
  const base = i < 0 ? 0 : i;
  return STU_COLORS[(base + ord + k + STU_COLORS.length) % STU_COLORS.length];
}
// Memoized study values per rows array (rows identity is stable across pan/zoom).
const studyCache = new WeakMap();
export function studyVals(id, rows, opts) {
  let m = studyCache.get(rows);
  if (!m) { m = new Map(); studyCache.set(rows, m); }
  const key = id + JSON.stringify(opts || {});
  if (!m.has(key)) m.set(key, computeStudy(id, rows, opts || {}));
  return m.get(key).series;
}
// Transform studies replace the candle source before render (radio: first
// visible active wins). Accepts instance objects; tolerates legacy string ids
// read-only (rendered with registry defaults, never rewritten).
export function applyTransform(rows, state) {
  const act = state.studies || [];
  let t = null, opts = {};
  for (const e of act) {
    const id = typeof e === 'string' ? e : e?.id;
    const meta = STUDIES.find(s => s.id === id);
    if (!meta || meta.kind !== 'transform') continue;
    if (e && typeof e === 'object' && e.visible === false) continue;
    t = meta;
    opts = (e && typeof e === 'object' && e.params) ? e.params : {};
    break;
  }
  if (!t) return rows;
  try {
    if (t.id === 'heikinashi') {
      const s = studyVals('heikinashi', rows, opts);
      return rows.map((r, i) => ({ ...r, o: s.open[i] ?? r.o, h: s.high[i] ?? r.h, l: s.low[i] ?? r.l, c: s.close[i] ?? r.c }));
    }
    const s = studyVals(t.id, rows, opts);
    return rows.map((r, i) => {
      const c = s.line[i] ?? r.c;
      const o = i === 0 ? c : (s.line[i - 1] ?? c);
      return { ...r, o, c, h: Math.max(o, c), l: Math.min(o, c) };
    });
  } catch { return rows; }
}
export function xForTime(t, vis, left, width) {
  if (!Number.isFinite(t) || !vis || !Number.isFinite(vis.from) || !Number.isFinite(vis.to) || !(vis.to > vis.from)) return NaN;
  return left + ((t - vis.from) / (vis.to - vis.from)) * width;
}
export function yForPrice(p, pr, top, height) {
  if (!Number.isFinite(p) || !pr || !Number.isFinite(pr.min) || !Number.isFinite(pr.max) || !(pr.max > pr.min)) return NaN;
  return top + (1 - (p - pr.min) / (pr.max - pr.min)) * height;
}
// Slice full rows to the visible time window before layout. All layers
// (candles, axes, drawings, hitTest) operate on this same sliced array so
// pan/zoom/range changes cannot desync them. Index-based x is kept:
// step = width / sliced.length.
export function visibleRows(rows, vis) {
  if (!Array.isArray(rows) || !rows.length) return Array.isArray(rows) ? rows : [];
  if (!vis || !Number.isFinite(vis.from) || !Number.isFinite(vis.to) || !(vis.to > vis.from)) return rows;
  return rows.filter((r) => r && Number.isFinite(r.t) && r.t >= vis.from && r.t <= vis.to);
}
// Replay hides bars after replayIndex. replayIndex addresses full rows;
// map it onto the visible slice via the slice offset.
export function replayCount(full, rows, offset, state) {
  if (state.replayIndex == null || !Number.isFinite(state.replayIndex)) return rows.length;
  const cap = Math.max(0, Math.min(full.length, Math.floor(state.replayIndex) + 1));
  return Math.max(0, Math.min(rows.length, cap - offset));
}
// Index of the first sliced row inside the full array (filter preserves
// identity, so indexOf is exact; falls back to 0 for foreign arrays).
export function sliceOffset(full, sliced) {
  if (!Array.isArray(full) || !Array.isArray(sliced) || !sliced.length) return 0;
  const i = full.indexOf(sliced[0]);
  return i >= 0 ? i : 0;
}
// Canonical candle x for slot i of an n-slot sliced layout.
export function candleX(i, n, left, width) {
  if (!Number.isFinite(i) || !Number.isFinite(n) || !(n > 0)) return NaN;
  const step = width / Math.max(1, n);
  return left + i * step + step / 2;
}
// Time -> x via the sliced index layout (keeps candles/axes/drawings/
// hitTest on one mapping). Interpolates between bar slots for arbitrary t.
export function xForRowTime(t, sliced, left, width) {
  if (!Number.isFinite(t) || !Array.isArray(sliced) || !sliced.length) return NaN;
  const n = sliced.length;
  const step = width / Math.max(1, n);
  if (n === 1) return left + width / 2;
  if (t <= sliced[0].t) return left + step / 2;
  if (t >= sliced[n - 1].t) return left + (n - 1) * step + step / 2;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (sliced[mid].t <= t) lo = mid; else hi = mid; }
  const t0 = sliced[lo].t, t1 = sliced[hi].t;
  const frac = (t1 > t0) ? (t - t0) / (t1 - t0) : 0;
  return left + (lo + frac) * step + step / 2;
}
// Inverse of xForRowTime: canvas x -> time via sliced slots.
export function timeForX(x, sliced, left, width) {
  if (!Array.isArray(sliced) || !sliced.length) return NaN;
  const n = sliced.length;
  const step = width / Math.max(1, n);
  if (n === 1) return sliced[0].t;
  let f = (x - left) / step - 0.5;
  if (f <= 0) return sliced[0].t;
  if (f >= n - 1) return sliced[n - 1].t;
  const j = Math.floor(f), frac = f - j;
  const t0 = sliced[j].t, t1 = sliced[j + 1].t;
  return t0 + frac * (t1 - t0);
}
// Window a full-history value array onto the visible slice (same offset model
// as candles/replay). Indicators/studies must be computed on FULL rows so
// warmup null-runs and EMA/RSI seeds cannot shift on pan/zoom.
export function windowVals(vals, offset, len) {
  if (!Array.isArray(vals)) return vals;
  return vals.slice(offset, offset + len);
}
// Last bar visible under the current window + replay position (single source
// for the dotted last-price line and the price-axis tag pill).
export function lastVisibleBar(full, state) {
  const vrows = visibleRows(full, state.visible);
  const n = replayCount(full, vrows, sliceOffset(full, vrows), state);
  return n > 0 ? vrows[n - 1] : null;
}
export function niceTicks(min, max, n = 7) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return [];
  const step0 = (max - min) / n; const mag = 10 ** Math.floor(Math.log10(step0)); const norm = step0 / mag; const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag; const out = []; for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v); return out;
}
function drawIndLine(ctx, vals, n, state, geom, rows, color) {
  ctx.save(); ctx.strokeStyle = color; ctx.setLineDash([]); ctx.lineWidth = 1.5;
  ctx.beginPath();
  const step = geom.width / Math.max(1, rows.length);
  let started = false;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v == null) continue;
    const x = geom.left + i * step + step / 2;
    const y = yForPrice(v, state.price, geom.top, geom.height);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.restore();
}
// Task 9: PSAR renders as dots per vendor convention.
function drawDots(ctx, vals, n, state, geom, rows, color) {
  ctx.save(); ctx.fillStyle = color;
  const step = geom.width / Math.max(1, rows.length);
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v == null) continue;
    const x = geom.left + i * step + step / 2;
    const y = yForPrice(v, state.price, geom.top, geom.height);
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill();
  }
  ctx.restore();
}
// Task 9: bands fill between the `fill` pair at 12% alpha.
function fillBand(ctx, upper, lower, n, state, geom, rows, color) {
  const step = geom.width / Math.max(1, rows.length);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const u = upper[i], l = lower[i];
    if (u == null || l == null) continue;
    const x = geom.left + i * step + step / 2;
    pts.push([x, yForPrice(u, state.price, geom.top, geom.height), yForPrice(l, state.price, geom.top, geom.height)]);
  }
  if (!pts.length) return;
  ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
  for (let k = pts.length - 1; k >= 0; k--) ctx.lineTo(pts[k][0], pts[k][2]);
  ctx.closePath(); ctx.fill(); ctx.restore();
}
// Task 9: generic oscillator-pane line scaled to an explicit union {min,max}.
function drawPaneLine(ctx, vals, n, scale, geom, rows, color, paneTop, paneHeight) {
  ctx.save(); ctx.strokeStyle = color; ctx.setLineDash([]); ctx.lineWidth = 1.5;
  ctx.beginPath();
  const step = geom.width / Math.max(1, rows.length);
  let started = false;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v == null) continue;
    const x = geom.left + i * step + step / 2;
    const y = paneTop + (1 - (v - scale.min) / (scale.max - scale.min)) * paneHeight;
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.restore();
}
export function renderBase(ctx, state, rows, geom) {
  // Hide indicators: skip transforms and overlays so the chart shows raw bars.
  const full = state.indicatorsHidden ? rows : applyTransform(rows, state);
  // Model (a): slice to the visible window BEFORE layout; every layer
  // (candles, indicators, studies, axes, drawings, hitTest) operates on
  // this same sliced array with index-based x (step = width / sliced.length).
  const vrows = visibleRows(full, state.visible);
  const offset = sliceOffset(full, vrows);
  const pal = PAL[state.theme] || PAL.light;
  const { left, top, width, height } = geom;
  ctx.fillStyle = pal.bg; ctx.fillRect(left, top, width, height);
  ctx.strokeStyle = pal.grid; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
  if (state.price && Number.isFinite(state.price.min) && Number.isFinite(state.price.max) && state.price.max > state.price.min) {
    for (const p of niceTicks(state.price.min, state.price.max)) { const y = Math.round(yForPrice(p, state.price, top, height)) + .5; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke(); }
  }
  // Replay: replayIndex addresses full rows; map onto the slice via offset.
  const n = replayCount(full, vrows, offset, state);
  const step = width / Math.max(1, vrows.length);
  const bw = Math.max(2, step * 0.6);
  const vh = height * 0.15;
  const chartType = state.chartType || 'candles';
  const xAt = (i) => left + i * step + step / 2;
  const vmax = Math.max(1, ...vrows.map(q => q.v));
  if (chartType === 'line') {
    ctx.strokeStyle = '#2962FF'; ctx.setLineDash([]); ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xAt(i), y = yForPrice(vrows[i].c, state.price, top, height);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else if (chartType === 'bars') {
    for (let i = 0; i < n; i++) {
      const r = vrows[i];
      const x = xAt(i);
      const col = r.c >= r.o ? pal.up : pal.down;
      ctx.strokeStyle = col; ctx.setLineDash([]); ctx.lineWidth = 1;
      const yH = yForPrice(r.h, state.price, top, height), yL = yForPrice(r.l, state.price, top, height);
      const yO = yForPrice(r.o, state.price, top, height), yC = yForPrice(r.c, state.price, top, height);
      ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, yH); ctx.lineTo(Math.round(x) + .5, yL); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(Math.round(x - bw / 2), Math.round(yO) + .5); ctx.lineTo(Math.round(x) + .5, Math.round(yO) + .5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, Math.round(yC) + .5); ctx.lineTo(Math.round(x + bw / 2), Math.round(yC) + .5); ctx.stroke();
      ctx.globalAlpha = 0.4; ctx.fillStyle = col;
      const bh = (r.v / vmax) * vh;
      ctx.fillRect(Math.round(x - bw / 2), Math.round(top + height - bh), Math.round(bw), Math.round(bh));
      ctx.globalAlpha = 1;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const r = vrows[i];
      const x = xAt(i);
      const col = r.c >= r.o ? pal.up : pal.down;
      ctx.strokeStyle = col; ctx.setLineDash([]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, yForPrice(r.h, state.price, top, height)); ctx.lineTo(Math.round(x) + .5, yForPrice(r.l, state.price, top, height)); ctx.stroke();
      ctx.fillStyle = col;
      const yO = yForPrice(r.o, state.price, top, height), yC = yForPrice(r.c, state.price, top, height);
      ctx.fillRect(Math.round(x - bw / 2), Math.round(Math.min(yO, yC)), Math.round(bw), Math.max(1, Math.round(Math.abs(yC - yO))));
      ctx.globalAlpha = 0.4;
      const bh = (r.v / vmax) * vh;
      ctx.fillRect(Math.round(x - bw / 2), Math.round(top + height - bh), Math.round(bw), Math.round(bh));
      ctx.globalAlpha = 1;
    }
  }
  // Study instances (parameterized, multi-instance) on base canvas.
  // Full-history compute, then window by the slice offset so warmup/seeds
  // cannot shift on pan/zoom (same offset model as candles/replay).
  // Tolerates legacy string ids read-only (registry defaults); visible:false
  // instances are skipped but kept in state. Hidden indicators render nothing.
  const metaById = (id) => STUDIES.find(s => s.id === id);
  const active = [];
  if (!state.indicatorsHidden) {
  for (const e of (state.studies || [])) {
    if (typeof e === 'string') {
      const meta = metaById(e);
      if (meta) active.push({ id: e, params: { ...(meta.opts || {}) }, color: null });
    } else if (e && typeof e === 'object' && typeof e.id === 'string') {
      const meta = metaById(e.id);
      if (!meta) continue;
      if (e.visible === false) continue;
      active.push({ id: e.id, params: { ...(meta.opts || {}), ...(e.params || {}) }, color: ('color' in e) ? e.color : null });
    }
  }
  }
  // Assign each instance an ordinal per study id so auto colors vary across
  // instances (mesh) as well as across lines.
  const ordSeen = new Map();
  for (const inst of active) {
    const seen = ordSeen.get(inst.id) || 0;
    inst.ord = seen;
    ordSeen.set(inst.id, seen + 1);
  }
  const colorFor = (inst, k = 0) => inst.color ?? autoColor(inst.id, inst.ord || 0, k);
  for (const inst of active) {
    const meta = metaById(inst.id);
    if (meta.kind !== 'overlay' && meta.kind !== 'multiline') continue;
    let series = null;
    try { series = studyVals(inst.id, full, inst.params); } catch { continue; }
    meta.lines.forEach((key, k) => {
      const vals = series[key] ? windowVals(series[key], offset, vrows.length) : null;
      if (!vals) return;
      if (inst.id === 'psar') drawDots(ctx, vals, n, state, geom, vrows, colorFor(inst, k));
      else drawIndLine(ctx, vals, n, state, geom, vrows, colorFor(inst, k));
    });
  }
  for (const inst of active) {
    const meta = metaById(inst.id);
    if (meta.kind !== 'bands') continue;
    let series = null;
    try { series = studyVals(inst.id, full, inst.params); } catch { continue; }
    const [f0, f1] = meta.fill || [];
    if (f0 && f1 && series[f0] && series[f1]) fillBand(ctx, windowVals(series[f0], offset, vrows.length), windowVals(series[f1], offset, vrows.length), n, state, geom, vrows, colorFor(inst));
    meta.lines.forEach((key, k) => {
      if (series[key]) drawIndLine(ctx, windowVals(series[key], offset, vrows.length), n, state, geom, vrows, colorFor(inst, k));
    });
  }
  // Shared oscillator pane, scaled to the union min/max of active pane series.
  const paneJobs = [];
  for (const inst of active) {
    const meta = metaById(inst.id);
    if (meta.kind !== 'pane') continue;
    let series = null;
    try { series = studyVals(inst.id, full, inst.params); } catch { continue; }
    meta.lines.forEach((key, k) => {
      if (series[key]) paneJobs.push({ vals: windowVals(series[key], offset, vrows.length), color: colorFor(inst, k) });
    });
  }
  if (paneJobs.length) {
    let mn = Infinity, mx = -Infinity;
    for (const j of paneJobs) {
      for (const v of j.vals) {
        if (typeof v !== 'number' || !isFinite(v)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    if (!isFinite(mn) || !isFinite(mx)) { mn = 0; mx = 1; }
    if (mn === mx) { mn -= 1; mx += 1; }
    const scale = { min: mn, max: mx };
    const ph = Math.round(height * 0.22), py = top + height - ph;
    ctx.save();
    ctx.fillStyle = state.theme === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';
    ctx.fillRect(left, py, width, ph);
    ctx.restore();
    if (mn < 0 && mx > 0) {
      ctx.save();
      ctx.strokeStyle = pal.grid; ctx.setLineDash([2, 3]);
      const y0 = py + (1 - (0 - mn) / (mx - mn)) * ph;
      ctx.beginPath(); ctx.moveTo(left, y0); ctx.lineTo(left + width, y0); ctx.stroke();
      ctx.restore();
    }
    for (const j of paneJobs) drawPaneLine(ctx, j.vals, n, scale, { left, top, width, height }, vrows, j.color, py, ph);
  }
  // last-price dotted line (last *visible-in-replay* bar), colored by bar direction
  const last = lastVisibleBar(rows, state);
  if (last && n > 0) { const y = yForPrice(last.c, state.price, top, height); ctx.strokeStyle = last.c >= last.o ? pal.up : pal.down; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke(); ctx.setLineDash([]); }
}
// Task 8: composite base+overlay for PNG export (used by ui.js export button).
export function compositeToDataURL(base, overlay) {
  const c = document.createElement('canvas');
  c.width = base.width; c.height = base.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(base, 0, 0);
  if (overlay && overlay.width && overlay.height) ctx.drawImage(overlay, 0, 0);
  return c.toDataURL('image/png');
}
