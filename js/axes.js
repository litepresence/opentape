// js/axes.js
import { niceTicks, xForTime, yForPrice, PAL, visibleRows, xForRowTime, lastVisibleBar } from './chart.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function renderPriceAxis(el, rows, state, geom) {
  if (!el || !state.price) return;
  const pal = PAL[state.theme] || PAL.light;
  el.innerHTML = '';
  el.style.position = 'relative';
  el.style.overflow = 'hidden';
  if (!Number.isFinite(state.price.min) || !Number.isFinite(state.price.max) || !(state.price.max > state.price.min)) return;
  for (const p of niceTicks(state.price.min, state.price.max)) {
    const y = yForPrice(p, state.price, geom.top, geom.height);
    const d = document.createElement('div');
    d.textContent = p.toLocaleString('en-US');
    d.style.position = 'absolute';
    d.style.top = Math.round(y - 7) + 'px';
    d.style.left = '0';
    d.style.right = '0';
    d.style.textAlign = 'left';
    d.style.paddingLeft = '6px';
    d.style.fontSize = '11px';
    d.style.lineHeight = '14px';
    d.style.color = pal.text;
    d.style.fontWeight = p % 10000 === 0 ? '700' : '400';
    d.style.pointerEvents = 'none';
    el.appendChild(d);
  }
  // Last-price tag pill (price + UTC clock), colored by bar direction.
  const last = Array.isArray(rows) && rows.length ? lastVisibleBar(rows, state) : null;
  if (last) {
    const y = yForPrice(last.c, state.price, geom.top, geom.height);
    const up = last.c >= last.o;
    const tag = document.createElement('div');
    tag.id = 'last-price-tag';
    tag.style.position = 'absolute';
    tag.style.top = Math.round(y - 14) + 'px';
    tag.style.right = '0';
    tag.style.background = up ? pal.up : pal.down;
    tag.style.color = '#fff';
    tag.style.fontSize = '11px';
    tag.style.lineHeight = '13px';
    tag.style.padding = '2px 5px';
    tag.style.borderRadius = '3px';
    tag.style.textAlign = 'right';
    tag.style.pointerEvents = 'none';
    const pl = document.createElement('div');
    pl.textContent = Math.round(last.c).toLocaleString('en-US');
    const tm = document.createElement('div');
    tm.textContent = new Date().toISOString().slice(11, 19);
    tag.appendChild(pl); tag.appendChild(tm);
    el.appendChild(tag);
  }
  // Volume tag pill (last bar volume, K-formatted), colored by bar direction.
  if (last && Number.isFinite(last.v)) {
    const up = last.c >= last.o;
    const vtag = document.createElement('div');
    vtag.id = 'last-volume-tag';
    vtag.style.position = 'absolute';
    vtag.style.bottom = '2px';
    vtag.style.right = '0';
    vtag.style.background = up ? pal.up : pal.down;
    vtag.style.color = '#fff';
    vtag.style.fontSize = '11px';
    vtag.style.lineHeight = '13px';
    vtag.style.padding = '2px 5px';
    vtag.style.borderRadius = '3px';
    vtag.style.textAlign = 'right';
    vtag.style.pointerEvents = 'none';
    vtag.textContent = last.v >= 1000 ? (last.v / 1000).toFixed(2) + 'K' : String(Math.round(last.v));
    el.appendChild(vtag);
  }
}

export function renderTimeAxis(el, rows, state, geom) {
  if (!el || !rows.length) return;
  const pal = PAL[state.theme] || PAL.light;
  el.innerHTML = '';
  el.style.position = 'relative';
  el.style.overflow = 'hidden';
  // Reserve right gutter so % positions align with canvas (canvas width = wrap - axis-w)
  el.style.marginRight = 'var(--axis-w)';
  // Same sliced array as the candle renderer: month marks come from visible
  // bars only, positioned with the shared index-based x mapping.
  const sliced = visibleRows(rows, state.visible);
  const src = sliced.length ? sliced : rows;
  let lastMonth = -1;
  const seen = new Set();
  const marks = [];
  src.forEach((r) => {
    const d = new Date(r.t);
    const m = d.getUTCMonth();
    const key = d.getUTCFullYear() + '-' + m;
    if (m !== lastMonth && !seen.has(key)) {
      seen.add(key);
      marks.push({ t: r.t, label: MONTHS[m] });
    }
    if (m !== lastMonth) lastMonth = m;
  });
  marks.forEach((mk, idx) => {
    const x = sliced.length
      ? xForRowTime(mk.t, sliced, geom.left, geom.width)
      : xForTime(mk.t, state.visible, geom.left, geom.width);
    const s = document.createElement('span');
    s.textContent = mk.label;
    s.style.position = 'absolute';
    s.style.top = '6px';
    if (idx === 0) {
      // first label sits at the left edge — don't center-clip it
      s.style.left = '2px';
    } else {
      s.style.left = (x / Math.max(1, geom.width)) * 100 + '%';
      // last label sits at the right edge — right-align it
      s.style.transform = idx === marks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)';
    }
      s.style.fontSize = '11px';
      s.style.color = pal.text;
      s.style.pointerEvents = 'none';
      el.appendChild(s);
  });
}
