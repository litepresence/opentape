// js/ui.js
import { fetchOHLCV } from './data.js';
import { renderBase } from './chart.js';
import { renderPriceAxis, renderTimeAxis } from './axes.js';

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
  const priceAxis = document.querySelector('#price-axis');
  const timeAxis = document.querySelector('#time-axis');
  let rows = [];
  const geomFor = () => base
    ? { left: 0, top: 0, width: base.width, height: base.height }
    : { left: 0, top: 0, width: 1600, height: 800 };
  function renderAll(state) {
    if (!base || !rows.length || !state.visible || !state.price) return;
    const geom = geomFor();
    renderBase(base.getContext('2d'), state, rows, geom);
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
  });
  window.addEventListener('resize', () => renderAll(v.get()));
}
