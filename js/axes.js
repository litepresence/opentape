// js/axes.js
import { niceTicks, xForTime, yForPrice, PAL, visibleRows, xForRowTime } from './chart.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function renderPriceAxis(el, state, geom) {
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
