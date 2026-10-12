// js/ui.js
import { fetchOHLCV } from './data.js';
import { renderBase, PAL } from './chart.js';
import { renderPriceAxis, renderTimeAxis } from './axes.js';
import { hitTest, drawCrosshair, drawDrawings, drawAlerts } from './overlay.js';
import { snapPrice, serialize, deserialize, addDrawing } from './drawings.js';

const LAYOUT_KEY = 'tv-clone-layout-v1';

export function initUI(v) {
  document.documentElement.dataset.theme = v.get().theme;
  document.querySelector('#theme-btn')?.addEventListener('click', () => v.toggleTheme());
  // Task 6 state: magnet, pending 2-click anchor, undo/redo stacks.
  let magnetOn = true;
  let pending = null;
  const undoStack = [];
  const redoStack = [];
  const tForX = (x, vis, left, width) => vis.from + ((x - left) / Math.max(1, width)) * (vis.to - vis.from);
  const pForY = (y, pr, top, height) => pr.min + (1 - (y - top) / Math.max(1, height)) * (pr.max - pr.min);
  const saveLayout = () => {
    try {
      const s = v.get();
      localStorage.setItem(LAYOUT_KEY, serialize({ drawings: s.drawings || [], alerts: s.alerts || [] }));
    } catch {}
  };
  const loadLayout = () => {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return null;
      const parsed = deserialize(raw);
      if (Array.isArray(parsed)) return { drawings: parsed, alerts: [] };
      return { drawings: parsed.drawings || [], alerts: parsed.alerts || [] };
    } catch { return null; }
  };
  const pushHistory = () => {
    const s = v.get();
    undoStack.push(serialize({ drawings: s.drawings || [], alerts: s.alerts || [] }));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  };
  const undo = () => {
    if (!undoStack.length) return;
    const s = v.get();
    redoStack.push(serialize({ drawings: s.drawings || [], alerts: s.alerts || [] }));
    const prev = deserialize(undoStack.pop());
    v.set({ drawings: prev.drawings || [], alerts: prev.alerts || [], selectedId: null });
    saveLayout();
  };
  const redo = () => {
    if (!redoStack.length) return;
    const s = v.get();
    undoStack.push(serialize({ drawings: s.drawings || [], alerts: s.alerts || [] }));
    const nxt = deserialize(redoStack.pop());
    v.set({ drawings: nxt.drawings || [], alerts: nxt.alerts || [], selectedId: null });
    saveLayout();
  };
  const persisted = loadLayout();
  if (persisted) v.set({ drawings: persisted.drawings, alerts: persisted.alerts });
  document.querySelectorAll('#rail button').forEach(b => b.addEventListener('click', () => {
    const tool = b.dataset.tool;
    if (tool === 'magnet') {
      magnetOn = !magnetOn;
      b.classList.toggle('active', magnetOn);
      return;
    }
    if (tool === 'del') {
      const s = v.get();
      if (!s.drawings.length && !s.alerts.length) return;
      pushHistory();
      if (s.selectedId) {
        v.set({
          drawings: s.drawings.filter(d => d.id !== s.selectedId),
          alerts: (s.alerts || []).filter(a => a.id !== s.selectedId),
          selectedId: null,
        });
      } else {
        v.set({ drawings: s.drawings.slice(0, -1) });
      }
      saveLayout();
      return;
    }
    document.querySelectorAll('#rail button').forEach(x => { if (x.dataset.tool !== 'magnet') x.classList.remove('active'); });
    b.classList.add('active'); v.set({ tool });
    pending = null;
  }));
  // Magnet button reflects default-on state.
  document.querySelector('#rail button[data-tool="magnet"]')?.classList.add('active');
  // Topbar undo/redo (↩ ↪) + keyboard.
  document.querySelectorAll('#topbar button').forEach(b => {
    if (b.textContent === '↩') b.addEventListener('click', undo);
    if (b.textContent === '↪') b.addEventListener('click', redo);
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const s = v.get();
      if (!s.selectedId && !s.drawings.length) return;
      pushHistory();
      if (s.selectedId) {
        v.set({
          drawings: s.drawings.filter(d => d.id !== s.selectedId),
          alerts: (s.alerts || []).filter(a => a.id !== s.selectedId),
          selectedId: null,
        });
      } else {
        v.set({ drawings: s.drawings.slice(0, -1) });
      }
      saveLayout();
    }
  });
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
  const maybeSnap = (p, geom, state) => {
    if (!magnetOn || !rows.length) return p;
    const span = state.price.max - state.price.min;
    const tol = (span / Math.max(1, geom.height)) * 8;
    return snapPrice(p, rows, tol);
  };
  function renderAll(state) {
    if (!base || !rows.length || !state.visible || !state.price) return;
    const geom = geomFor();
    renderBase(base.getContext('2d'), state, rows, geom);
    // Pan/zoom invalidates hover — clear overlay so no stale crosshair lingers.
    if (overlay) {
      const octx = overlay.getContext('2d');
      octx.clearRect(0, 0, overlay.width, overlay.height);
      drawDrawings(octx, state.drawings, state, geom);
      drawAlerts(octx, state.alerts, state, geom);
    }
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
  const DRAW_TOOLS = new Set(['trend', 'fib', 'text', 'horizontal', 'shape', 'brush']);
  if (overlay) {
    let dragging = false;
    let startX = 0;
    let startVis = null;
    let dragAlertId = null;
    const alertAtY = (my, state, geom) => {
      for (const a of state.alerts || []) {
        const y = geom.top + (1 - (a.price - state.price.min) / (state.price.max - state.price.min)) * geom.height;
        if (Math.abs(y - my) <= 8) return a;
      }
      return null;
    };
    overlay.addEventListener('mousedown', (e) => {
      const st = v.get();
      if (!rows.length || !st.visible || !st.price) return;
      const geom = geomFor();
      const { mx, my } = toCanvas(e);
      // Alert drag takes priority over pan/draw.
      const hitA = alertAtY(my, st, geom);
      if (hitA) {
        pushHistory();
        dragAlertId = hitA.id;
        v.set({ selectedId: hitA.id });
        return;
      }
      const tool = st.tool || 'cross';
      if (DRAW_TOOLS.has(tool)) {
        const t = tForX(mx, st.visible, geom.left, geom.width);
        const p = maybeSnap(pForY(my, st.price, geom.top, geom.height), geom, st);
        const normTool = tool === 'shape' || tool === 'brush' ? 'horizontal' : tool;
        if (normTool === 'trend' || normTool === 'fib') {
          if (!pending) { pending = { type: normTool, p1: { t, p } }; }
          else {
            pushHistory();
            addDrawing(v, { type: pending.type, p1: pending.p1, p2: { t, p } });
            v.set({ selectedId: v.get().drawings[v.get().drawings.length - 1]?.id });
            pending = null;
            saveLayout();
          }
        } else if (normTool === 'horizontal') {
          pushHistory();
          addDrawing(v, { type: 'horizontal', price: p });
          v.set({ selectedId: v.get().drawings[v.get().drawings.length - 1]?.id });
          saveLayout();
        } else if (normTool === 'text') {
          const text = typeof prompt !== 'undefined' ? prompt('Text:') : null;
          if (!text) return;
          pushHistory();
          addDrawing(v, { type: 'text', t, p, text });
          saveLayout();
        }
        return;
      }
      dragging = true; startX = e.clientX;
      const s = v.get(); startVis = s.visible ? { ...s.visible } : null;
      // Select drawing on click (cross tool): nearest trend endpoint / horizontal within 8px.
      let bestId = null, bd = 8;
      for (const d of s.drawings || []) {
        if (d.type === 'horizontal') {
          const y = geom.top + (1 - (d.price - s.price.min) / (s.price.max - s.price.min)) * geom.height;
          const dist = Math.abs(y - my);
          if (dist <= bd) { bd = dist; bestId = d.id; }
        } else if ((d.type === 'trend' || d.type === 'fib') && d.p1) {
          const pts = [d.p1, d.p2].filter(Boolean);
          for (const pt of pts) {
            const dx = (pt.t - st.visible.from) / (st.visible.to - st.visible.from) * geom.width + geom.left - mx;
            const dy = (geom.top + (1 - (pt.p - s.price.min) / (s.price.max - s.price.min)) * geom.height) - my;
            const dist = Math.hypot(dx, dy);
            if (dist <= 12) { bestId = d.id; bd = 0; }
          }
        }
      }
      if (bestId) v.set({ selectedId: bestId });
    });
    window.addEventListener('mouseup', () => { dragging = false; startVis = null; dragAlertId = null; });
    overlay.addEventListener('mousemove', (e) => {
      const st = v.get();
      if (!rows.length || !st.visible || !st.price) return;
      const geom = geomFor();
      const { mx, my } = toCanvas(e);
      if (dragAlertId) {
        const p = pForY(my, st.price, geom.top, geom.height);
        v.set({ alerts: (st.alerts || []).map(a => a.id === dragAlertId ? { ...a, price: p } : a) });
        saveLayout();
        return;
      }
      if (dragging && startVis) {
        const dx = (e.clientX - startX) * (geom.width / Math.max(1, overlay.getBoundingClientRect().width));
        const span = startVis.to - startVis.from;
        const dt = dx * span / Math.max(1, geom.width);
        v.set({ visible: { from: startVis.from - dt, to: startVis.to - dt } });
        return;
      }
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      drawDrawings(ctx, st.drawings, st, geom);
      drawAlerts(ctx, st.alerts, st, geom);
      const pal = PAL[st.theme] || PAL.light;
      drawCrosshair(ctx, mx, my, geom, pal);
      const idx = hitTest(mx, st.visible, geom.left, geom.width, rows);
      updateOhlc(rows[idx]);
    });
    overlay.addEventListener('mouseleave', () => {
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      const st = v.get();
      drawDrawings(ctx, st.drawings, st, geomFor());
      drawAlerts(ctx, st.alerts, st, geomFor());
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
  // Task 6: click price axis adds a draggable alert line; persisted under same key.
  if (priceAxis && !priceAxis.dataset.alertBound) {
    priceAxis.dataset.alertBound = '1';
    priceAxis.style.cursor = 'pointer';
    priceAxis.addEventListener('click', (e) => {
      const st = v.get();
      if (!rows.length || !st.visible || !st.price) return;
      const geom = geomFor();
      const rect = priceAxis.getBoundingClientRect();
      const my = (e.clientY - rect.top) * (geom.height / Math.max(1, rect.height));
      const p = pForY(geom.top + my, st.price, geom.top, geom.height);
      pushHistory();
      const cur = v.get().alerts || [];
      const id = 'a' + Date.now();
      v.set({ alerts: [...cur, { id, price: p }], selectedId: id });
      saveLayout();
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
