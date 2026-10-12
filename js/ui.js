// js/ui.js
import { fetchOHLCV } from './data.js';
import { renderBase, PAL } from './chart.js';
import { renderPriceAxis, renderTimeAxis } from './axes.js';
import { hitTest, drawCrosshair } from './overlay.js';

export function initUI(v) {
  document.documentElement.dataset.theme = v.get().theme;
  document.querySelector('#theme-btn')?.addEventListener('click', () => v.toggleTheme());
  document.querySelectorAll('#rail button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#rail button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); v.set({ tool: b.dataset.tool });
  }));
  setInterval(() => { const el = document.querySelector('#clock'); if (el) el.textContent = new Date().toISOString().slice(11, 19); }, 1000);

  // Task 4: fetch OHLCV + render base canvas + axes; re-render on ViewState changes.
  const base = document.querySelector('#base');
  const overlay = document.querySelector('#overlay');
  const priceAxis = document.querySelector('#price-axis');
  const timeAxis = document.querySelector('#time-axis');
  let rows = [];
  let fullVisible = null;
  let fullPrice = null;
  const geomFor = () => base
    ? { left: 0, top: 0, width: base.width, height: base.height }
    : { left: 0, top: 0, width: 1600, height: 800 };
  function renderAll(state) {
    if (!base || !rows.length || !state.visible || !state.price) return;
    const geom = geomFor();
    renderBase(base.getContext('2d'), state, rows, geom);
    // Pan/zoom invalidates hover — clear overlay so no stale crosshair lingers.
    if (overlay) overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
    renderPriceAxis(priceAxis, state, geom);
    renderTimeAxis(timeAxis, rows, state, geom);
    const last = rows[rows.length - 1];
    const ohlc = document.querySelector('#ohlc');
    if (ohlc) ohlc.textContent = `O ${last.o.toFixed(0)} H ${last.h.toFixed(0)} L ${last.l.toFixed(0)} C ${last.c.toFixed(0)}`;
    const sell = document.querySelector('#sell');
    const buy = document.querySelector('#buy');
    if (sell) sell.textContent = `${last.c.toFixed(0)} SELL`;
    if (buy) buy.textContent = `${last.c.toFixed(0)} BUY`;
  }
  v.onRender(renderAll);
  fetchOHLCV().then((data) => {
    rows = data;
    const s = v.get();
    const patch = {};
    if (!s.visible) patch.visible = { from: rows[0].t, to: rows[rows.length - 1].t };
    if (!s.price) {
      let mn = Infinity, mx = -Infinity;
      for (const r of rows) { if (r.l < mn) mn = r.l; if (r.h > mx) mx = r.h; }
      const pad = (mx - mn) * 0.08;
      patch.price = { min: Math.floor((mn - pad) / 1000) * 1000, max: Math.ceil((mx + pad) / 1000) * 1000 };
    }
    if (Object.keys(patch).length) v.set(patch);
    else renderAll(v.get());
    const cur = v.get();
    if (cur.visible && !fullVisible) fullVisible = { ...cur.visible };
    if (cur.price && !fullPrice) fullPrice = { ...cur.price };
  });
  window.addEventListener('resize', () => renderAll(v.get()));

  // Task 5: pan / zoom / crosshair / ranges. All mutations via ViewState.
  const toCanvas = (e) => {
    const el = overlay || base;
    const rect = el.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (el.width / Math.max(1, rect.width));
    const my = (e.clientY - rect.top) * (el.height / Math.max(1, rect.height));
    return { mx, my };
  };
  const updateOhlc = (row) => {
    const ohlc = document.querySelector('#ohlc');
    if (ohlc && row) ohlc.textContent = `O ${row.o.toFixed(0)} H ${row.h.toFixed(0)} L ${row.l.toFixed(0)} C ${row.c.toFixed(0)}`;
  };
  if (overlay) {
    let dragging = false;
    let startX = 0;
    let startVis = null;
    overlay.addEventListener('mousedown', (e) => {
      dragging = true; startX = e.clientX;
      const s = v.get(); startVis = s.visible ? { ...s.visible } : null;
    });
    window.addEventListener('mouseup', () => { dragging = false; startVis = null; });
    overlay.addEventListener('mousemove', (e) => {
      const st = v.get();
      if (!rows.length || !st.visible || !st.price) return;
      const geom = geomFor();
      const { mx, my } = toCanvas(e);
      if (dragging && startVis) {
        const dx = (e.clientX - startX) * (geom.width / Math.max(1, overlay.getBoundingClientRect().width));
        const span = startVis.to - startVis.from;
        const dt = dx * span / Math.max(1, geom.width);
        v.set({ visible: { from: startVis.from - dt, to: startVis.to - dt } });
        return;
      }
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      const pal = PAL[st.theme] || PAL.light;
      drawCrosshair(ctx, mx, my, geom, pal);
      const idx = hitTest(mx, st.visible, geom.left, geom.width, rows);
      updateOhlc(rows[idx]);
    });
    overlay.addEventListener('mouseleave', () => {
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      if (rows.length) updateOhlc(rows[rows.length - 1]);
    });
    overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      const st = v.get();
      if (!rows.length || !st.visible || !st.price) return;
      const factor = e.deltaY < 0 ? 0.9 : 1.1;
      const geom = geomFor();
      const { mx, my } = toCanvas(e);
      if (e.shiftKey) {
        const span = st.price.max - st.price.min;
        if (span <= 0) return;
        const fy = my / Math.max(1, geom.height);
        const pCur = st.price.min + (1 - fy) * span;
        const nSpan = span * factor;
        const nMin = pCur - (1 - fy) * nSpan;
        v.set({ price: { min: nMin, max: nMin + nSpan } });
      } else {
        const span = st.visible.to - st.visible.from;
        if (span <= 0) return;
        const fx = (mx - geom.left) / Math.max(1, geom.width);
        const tCur = st.visible.from + fx * span;
        const nSpan = span * factor;
        v.set({ visible: { from: tCur - fx * nSpan, to: tCur - fx * nSpan + nSpan } });
      }
    }, { passive: false });
    overlay.addEventListener('dblclick', () => {
      if (fullVisible && fullPrice) v.set({ visible: { ...fullVisible }, price: { ...fullPrice } });
    });
  }
  // Range footer: turn "1D 5D 1M ..." span into buttons; set visible window.
  const rangeHost = document.querySelector('#rangebar span');
  const visibleForRange = (label) => {
    if (!rows.length) return null;
    const n = rows.length;
    const last = rows[n - 1];
    const take = (k) => ({ from: rows[Math.max(0, n - k)].t, to: last.t });
    switch (label) {
      case '1D': return take(2);
      case '5D': return take(5);
      case '1M': return take(30);
      case '3M': return take(90);
      case '6M': return take(Math.min(180, n));
      case 'YTD': {
        const y = new Date(last.t).getUTCFullYear();
        const first = rows.find((r) => new Date(r.t).getUTCFullYear() === y) || rows[0];
        return { from: first.t, to: last.t };
      }
      case '1Y': return take(Math.min(365, n));
      case '5Y':
      case 'All':
      default: return { from: rows[0].t, to: last.t };
    }
  };
  if (rangeHost && !rangeHost.dataset.enhanced) {
    rangeHost.dataset.enhanced = '1';
    const labels = rangeHost.textContent.trim().split(/\s+/);
    rangeHost.textContent = '';
    labels.forEach((label) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.range = label;
      b.style.padding = '2px 4px';
      b.addEventListener('click', () => {
        const vis = visibleForRange(label);
        if (vis) v.set({ visible: vis });
      });
      rangeHost.appendChild(b);
      rangeHost.appendChild(document.createTextNode(' '));
    });
  }
}
