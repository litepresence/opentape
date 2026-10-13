// js/ui.js
import { fetchOHLCV, normalizeOHLCV } from './data.js';
import { renderBase, PAL, compositeToDataURL, visibleRows, sliceOffset, replayCount, xForRowTime, timeForX } from './chart.js';
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
  const showToast = (msg) => {
    console.warn(msg);
    try {
      let el = document.querySelector('#toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.style.cssText = 'position:fixed;bottom:48px;left:50%;transform:translateX(-50%);background:#323232;color:#fff;padding:8px 14px;border-radius:4px;font:13px sans-serif;z-index:9999;opacity:0.95';
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.style.display = 'block';
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
    } catch {}
  };
  const layoutFromState = (s) => ({
    drawings: s.drawings || [],
    alerts: s.alerts || [],
    studies: s.studies || [],
    indicators: s.indicators || {},
    chartType: s.chartType || 'candles',
    symbol: s.symbol || 'BTC/USD',
    timeframe: s.timeframe || '1D',
    interval: s.interval || '1d',
  });
  const saveLayout = () => {
    try {
      localStorage.setItem(LAYOUT_KEY, serialize(layoutFromState(v.get())));
    } catch {}
  };
  const loadLayout = () => {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return null;
      const parsed = deserialize(raw);
      if (Array.isArray(parsed)) return { drawings: parsed, alerts: [] };
      return {
        drawings: parsed.drawings || [],
        alerts: parsed.alerts || [],
        studies: parsed.studies,
        indicators: parsed.indicators,
        chartType: parsed.chartType,
        symbol: parsed.symbol,
        timeframe: parsed.timeframe,
        interval: parsed.interval,
      };
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
  if (persisted) {
    const patch = {};
    if (persisted.drawings) patch.drawings = persisted.drawings;
    if (persisted.alerts) patch.alerts = persisted.alerts;
    if (persisted.studies) patch.studies = persisted.studies;
    if (persisted.indicators) patch.indicators = persisted.indicators;
    if (persisted.chartType) patch.chartType = persisted.chartType;
    if (persisted.symbol) patch.symbol = persisted.symbol;
    if (persisted.timeframe) patch.timeframe = persisted.timeframe;
    if (persisted.interval) patch.interval = persisted.interval;
    if (Object.keys(patch).length) v.set(patch);
  }
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
    const isEditable = (el) => {
      const tag = ((el && el.tagName) || '').toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!(el && el.isContentEditable);
    };
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      if (isEditable(e.target)) return;
      v.set({ tool: 'cross' });
      document.querySelectorAll('#rail button').forEach(x => x.classList.toggle('active', x.dataset.tool === 'cross'));
    }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
      if (isEditable(e.target)) return;
      v.set({ tool: 'trend' });
      document.querySelectorAll('#rail button').forEach(x => x.classList.toggle('active', x.dataset.tool === 'trend'));
      pending = null;
    }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      if (isEditable(e.target)) return;
      v.set({ tool: 'fib' });
      document.querySelectorAll('#rail button').forEach(x => x.classList.toggle('active', x.dataset.tool === 'fib'));
      pending = null;
    }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (isEditable(e.target)) return;
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
  // DPR-aware buffer sizing (cap 2): canvas buffers track CSS layout size.
  const fitCanvases = () => {
    try {
      const stack = document.querySelector('#canvas-stack');
      const cw = Math.round(stack?.clientWidth || base?.clientWidth || 1600);
      const ch = Math.round(stack?.clientHeight || base?.clientHeight || 800);
      if (!(cw > 0 && ch > 0)) return;
      const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
      if (base && (base.width !== W || base.height !== H)) { base.width = W; base.height = H; }
      if (overlay && (overlay.width !== W || overlay.height !== H)) { overlay.width = W; overlay.height = H; }
    } catch {}
  };
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
      drawDrawings(octx, state.drawings, state, geom, rows);
      drawAlerts(octx, state.alerts, state, geom);
    }
    renderPriceAxis(priceAxis, rows, state, geom);
    renderTimeAxis(timeAxis, rows, state, geom);
    // OHLC header tracks the last *visible-in-replay* bar (sliced + offset).
    const sliced = visibleRows(rows, state.visible);
    const src = sliced.length ? sliced : rows;
    const off = sliced.length ? sliceOffset(rows, sliced) : 0;
    const effSliced = state.replayIndex != null && Number.isFinite(state.replayIndex)
      ? replayCount(rows, src, off, state)
      : src.length;
    const last = (effSliced > 0 ? src[effSliced - 1] : src[src.length - 1]) || rows[rows.length - 1];
    if (!last) return;
    const ohlc = document.querySelector('#ohlc');
    if (ohlc) ohlc.textContent = `O ${last.o.toFixed(0)} H ${last.h.toFixed(0)} L ${last.l.toFixed(0)} C ${last.c.toFixed(0)}`;
    const sell = document.querySelector('#sell');
    const buy = document.querySelector('#buy');
    if (sell) sell.textContent = `${last.c.toFixed(0)} SELL`;
    if (buy) buy.textContent = `${last.c.toFixed(0)} BUY`;
  }
  v.onRender(renderAll);
  fitCanvases();
  const scaleFor = (list) => {
    let mn = Infinity, mx = -Infinity;
    for (const r of list) { if (r.l < mn) mn = r.l; if (r.h > mx) mx = r.h; }
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) return null;
    if (!(mx > mn)) { mn -= 1; mx += 1; }
    const pad = (mx - mn) * 0.08;
    const price = { min: Math.floor((mn - pad) / 1000) * 1000, max: Math.ceil((mx + pad) / 1000) * 1000 };
    if (!(price.max > price.min)) price.max = price.min + 1000;
    return { visible: { from: list[0].t, to: list[list.length - 1].t }, price };
  };
  fetchOHLCV({ symbol: v.get().symbol || 'BTC/USD', timeframe: v.get().interval || '1d' }).then((data) => {
    if (Array.isArray(data) && data.length) rows = data;
    if (!rows.length) return;
    fitCanvases();
    const s = v.get();
    const patch = {};
    if (!s.visible || !s.price) {
      const sc = scaleFor(rows);
      if (!s.visible && sc) patch.visible = sc.visible;
      if (!s.price && sc) patch.price = sc.price;
    }
    // Restored symbol/timeframe from layout: reflect in topbar labels.
    const symBtn0 = document.querySelector('#sym');
    if (symBtn0 && s.symbol) symBtn0.textContent = String(s.symbol).replace('/', '');
    if (Object.keys(patch).length) v.set(patch);
    else renderAll(v.get());
    const cur = v.get();
    if (cur.visible && !fullVisible) fullVisible = { ...cur.visible };
    if (cur.price && !fullPrice) fullPrice = { ...cur.price };
  }).catch(() => { /* offline + fallback failed — keep empty, no unhandled rejection */ });
  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    const raf = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame : (cb) => setTimeout(cb, 0);
    raf(() => { resizeQueued = false; fitCanvases(); renderAll(v.get()); });
  });

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
        const sliced = visibleRows(rows, st.visible);
        const src = sliced.length ? sliced : null;
        const t = src ? timeForX(mx, src, geom.left, geom.width) : tForX(mx, st.visible, geom.left, geom.width);
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
      const selSlice = visibleRows(rows, st.visible);
      const selSrc = selSlice.length ? selSlice : null;
      for (const d of s.drawings || []) {
        if (d.type === 'horizontal') {
          const y = geom.top + (1 - (d.price - s.price.min) / (s.price.max - s.price.min)) * geom.height;
          const dist = Math.abs(y - my);
          if (dist <= bd) { bd = dist; bestId = d.id; }
        } else if ((d.type === 'trend' || d.type === 'fib') && d.p1) {
          const pts = [d.p1, d.p2].filter(Boolean);
          for (const pt of pts) {
            const px = selSrc ? xForRowTime(pt.t, selSrc, geom.left, geom.width) : (pt.t - st.visible.from) / (st.visible.to - st.visible.from) * geom.width + geom.left;
            const dx = px - mx;
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
      drawDrawings(ctx, st.drawings, st, geom, rows);
      drawAlerts(ctx, st.alerts, st, geom);
      const pal = PAL[st.theme] || PAL.light;
      drawCrosshair(ctx, mx, my, geom, pal);
      const idx = hitTest(mx, st.visible, geom.left, geom.width, rows);
      const effCap = (st.replayIndex != null && Number.isFinite(st.replayIndex))
        ? Math.max(0, Math.min(rows.length - 1, Math.floor(st.replayIndex)))
        : rows.length - 1;
      updateOhlc(rows[Math.min(idx, effCap)]);
    });
    overlay.addEventListener('mouseleave', () => {
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      const st = v.get();
      drawDrawings(ctx, st.drawings, st, geomFor(), rows);
      drawAlerts(ctx, st.alerts, st, geomFor());
      if (rows.length) {
        const sliced = visibleRows(rows, st.visible);
        const src = sliced.length ? sliced : rows;
        const off = sliced.length ? sliceOffset(rows, sliced) : 0;
        const effSliced = st.replayIndex != null && Number.isFinite(st.replayIndex)
          ? replayCount(rows, src, off, st)
          : src.length;
        updateOhlc((effSliced > 0 ? src[effSliced - 1] : src[src.length - 1]) || rows[rows.length - 1]);
      }
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
  // Range footer: buttons switch the real data interval (captured from the
  // live page: 1D→1-minute … All→1-month) then set the time window. Windows
  // are time-based so they stay correct on any interval.
  const rangeHost = document.querySelector('#rangebar span');
  const RANGE_TF = { '1D': '1m', '5D': '5m', '1M': '30m', '3M': '1h', '6M': '2h', 'YTD': '1d', '1Y': '1d', '5Y': '1w', 'All': '1M' };
  const RANGE_SPAN = { '1D': 864e5, '5D': 5 * 864e5, '1M': 30 * 864e5, '3M': 90 * 864e5, '6M': 180 * 864e5, '1Y': 365 * 864e5, '5Y': 5 * 365 * 864e5 };
  const RANGE_TIP = { '1D': '1 day in 1 minute intervals', '5D': '5 days in 5 minutes intervals', '1M': '1 month in 30 minutes intervals', '3M': '3 months in 1 hour intervals', '6M': '6 months in 2 hours intervals', 'YTD': 'Year to day in 1 day intervals', '1Y': '1 year in 1 day intervals', '5Y': '5 years in 1 week intervals', 'All': 'All data in 1 month intervals' };
  const curInterval = () => v.get().interval || TF_CCXT[tfLabel()] || '1d';
  const visibleForRange = (label) => {
    if (!rows.length) return null;
    const last = rows[rows.length - 1];
    if (label === 'YTD') {
      const y = new Date(last.t).getUTCFullYear();
      const first = rows.find((r) => new Date(r.t).getUTCFullYear() === y) || rows[0];
      return { from: first.t, to: last.t };
    }
    if (!RANGE_SPAN[label]) return { from: rows[0].t, to: last.t };
    return { from: Math.max(rows[0].t, last.t - RANGE_SPAN[label]), to: last.t };
  };
  if (rangeHost && !rangeHost.dataset.enhanced) {
    rangeHost.dataset.enhanced = '1';
    const labels = rangeHost.textContent.trim().split(/\s+/);
    rangeHost.textContent = '';
    labels.forEach((label) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.range = label;
      if (RANGE_TIP[label]) b.title = RANGE_TIP[label];
      b.style.padding = '2px 4px';
      b.addEventListener('click', async () => {
        const tf = RANGE_TF[label] || '1d';
        if (curInterval() !== tf) {
          const ok = await reload(v.get().symbol || 'BTC/USD', tf, label);
          if (!ok) return; // reload toasted; keep old data + view
          v.set({ interval: tf });
        } else if (label) {
          v.set({ timeframe: label });
          saveLayout();
        }
        const vis = visibleForRange(label);
        if (vis) v.set({ visible: vis });
      });
      rangeHost.appendChild(b);
      rangeHost.appendChild(document.createTextNode(' '));
    });
  }

  // Task 7: indicators dialog, replay, symbol/timeframe switching, chart-type toggle.
  const TF_ORDER = ['D', '1W', '1H'];
  const TF_CCXT = { D: '1d', '1D': '1d', '1W': '1w', '1H': '1h' };
  const tfLabel = () => {
    const t = v.get().timeframe;
    if (t === '1D') return 'D';
    return TF_ORDER.includes(t) ? t : 'D';
  };
  const normalizeSymbol = (input) => {
    const s = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!s) return null;
    if (s.includes('/')) return s;
    for (const q of ['USDT', 'USD', 'EUR', 'BTC']) {
      if (s.length > q.length && s.endsWith(q)) return s.slice(0, -q.length) + '/' + q;
    }
    return s;
  };
  const resetScale = () => {
    if (!rows.length) return;
    let mn = Infinity, mx = -Infinity;
    for (const r of rows) { if (r.l < mn) mn = r.l; if (r.h > mx) mx = r.h; }
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) return;
    if (!(mx > mn)) { mn -= 1; mx += 1; }
    const pad = (mx - mn) * 0.08;
    const visible = { from: rows[0].t, to: rows[rows.length - 1].t };
    const price = { min: Math.floor((mn - pad) / 1000) * 1000, max: Math.ceil((mx + pad) / 1000) * 1000 };
    if (!(price.max > price.min)) price.max = price.min + 1000;
    fullVisible = { ...visible };
    fullPrice = { ...price };
    v.set({ visible, price, replayIndex: null });
  };
  // Symbol/timeframe reload: label + scale update ONLY on success. On
  // failure the old rows/label/scale are kept and an error toast is shown
  // (same fallback-toast pattern as data.js). Fetches /api/ohlcv directly
  // so a proxy failure can't masquerade fallback BTC data as the new symbol.
  const reload = async (symbol, ccxtTf, nextTf) => {
    try {
      const r = await fetch(`/api/ohlcv?symbol=${encodeURIComponent(symbol)}&timeframe=${ccxtTf}&limit=300`);
      if (!r.ok) throw new Error('proxy ' + r.status);
      const data = normalizeOHLCV(await r.json());
      if (!Array.isArray(data) || !data.length) throw new Error('empty');
      rows = data;
      resetScale();
      fitCanvases();
      const patch = { symbol };
      if (nextTf) patch.timeframe = nextTf;
      v.set(patch);
      saveLayout();
      const symBtn = document.querySelector('#sym');
      if (symBtn) symBtn.textContent = String(symbol).replace('/', '');
      return true;
    } catch (e) {
      showToast(`Live data unavailable — keeping ${v.get().symbol || 'current chart'}`);
      return false;
    }
  };
  // Indicators <dialog> with SMA20/SMA50/EMA20/RSI checkboxes.
  if (!document.querySelector('#ind-dialog')) {
    const cur = v.get();
    if (!cur.indicators) v.set({ indicators: { sma20: false, sma50: false, ema20: false, rsi: false } });
    if (!cur.chartType) v.set({ chartType: 'candles' });
    if (!cur.studies) v.set({ studies: [] });
    const dlg = document.createElement('dialog');
    dlg.id = 'ind-dialog';
    dlg.innerHTML = '<form method="dialog" style="display:flex;flex-direction:column;gap:6px;font:13px sans-serif;min-width:280px;max-height:80vh;overflow:auto">'
      + '<label><input type="checkbox" data-ind="sma20"> SMA 20</label>'
      + '<label><input type="checkbox" data-ind="sma50"> SMA 50</label>'
      + '<label><input type="checkbox" data-ind="ema20"> EMA 20</label>'
      + '<label><input type="checkbox" data-ind="rsi"> RSI</label>'
      + '<hr><input id="ind-filter" placeholder="Filter studies…" style="padding:4px">'
      + '<div id="ind-groups" style="display:flex;flex-direction:column;gap:8px"></div>'
      + '<button value="close">Close</button></form>';
    document.body.appendChild(dlg);
    dlg.querySelectorAll('input[data-ind]').forEach((cb) => {
      cb.checked = !!(v.get().indicators || {})[cb.dataset.ind];
      cb.addEventListener('change', () => {
        v.set({ indicators: { ...(v.get().indicators || {}), [cb.dataset.ind]: cb.checked } });
        saveLayout();
      });
    });
    // Task 9: all 85 vendored studies, grouped, with filter + transform radios.
    import('./studies.js').then(({ STUDIES }) => {
      const host = dlg.querySelector('#ind-groups');
      const groups = [];
      for (const s of STUDIES) {
        let g = groups.find(x => x.name === s.group);
        if (!g) { g = { name: s.group, items: [] }; groups.push(g); }
        g.items.push(s);
      }
      const setStudies = (ids) => { v.set({ studies: ids }); saveLayout(); };
      const activeIds = () => v.get().studies || [];
      const syncStudies = () => {
        const cur = new Set(activeIds());
        host.querySelectorAll('input[data-study]').forEach((cb) => {
          cb.checked = cur.has(cb.dataset.study);
        });
        const transforms = STUDIES.filter(s => s.kind === 'transform');
        const activeT = transforms.find(s => cur.has(s.id));
        host.querySelectorAll('input[data-transform]').forEach((r) => {
          r.checked = !!activeT && r.dataset.transform === activeT.id;
        });
        const noneR = host.querySelector('input[data-transform-none]');
        if (noneR) noneR.checked = !activeT;
      };
      for (const g of groups) {
        const box = document.createElement('div');
        box.dataset.group = g.name;
        const head = document.createElement('div');
        head.style.cssText = 'display:flex;gap:6px;align-items:center;font-weight:700';
        const title = document.createElement('span');
        title.textContent = g.name;
        title.style.flex = '1';
        const allB = document.createElement('button');
        allB.type = 'button'; allB.textContent = 'All'; allB.dataset.all = g.name;
        const noneB = document.createElement('button');
        noneB.type = 'button'; noneB.textContent = 'None'; noneB.dataset.none = g.name;
        head.append(title, allB, noneB);
        box.appendChild(head);
        allB.addEventListener('click', () => {
          const cur = new Set(activeIds());
          for (const s of g.items) {
            if (s.kind === 'transform') continue;
            cur.add(s.id);
          }
          setStudies([...cur]);
          syncStudies();
        });
        noneB.addEventListener('click', () => {
          setStudies(activeIds().filter(id => !g.items.some(s => s.id === id)));
          syncStudies();
        });
        for (const s of g.items) {
          const lab = document.createElement('label');
          lab.dataset.label = (s.id + ' ' + s.label).toLowerCase();
          lab.style.cssText = 'display:flex;gap:6px;align-items:center';
          const inp = document.createElement('input');
          if (s.kind === 'transform') {
            inp.type = 'radio';
            inp.name = 'tv-transform';
            inp.dataset.transform = s.id;
            inp.addEventListener('change', () => {
              if (!inp.checked) return;
              setStudies([...activeIds().filter(id => {
                const m = STUDIES.find(x => x.id === id);
                return m && m.kind !== 'transform';
              }), s.id]);
            });
          } else {
            inp.type = 'checkbox';
            inp.dataset.study = s.id;
            inp.addEventListener('change', () => {
              const cur = new Set(activeIds());
              if (inp.checked) cur.add(s.id);
              else cur.delete(s.id);
              setStudies([...cur]);
            });
          }
          lab.appendChild(inp);
          lab.appendChild(document.createTextNode(` ${s.label} (${s.id})`));
          box.appendChild(lab);
        }
        host.appendChild(box);
      }
      // Transform "None" radio clears the active transform.
      const clearBox = document.createElement('label');
      clearBox.style.cssText = 'display:flex;gap:6px;align-items:center';
      const clear = document.createElement('input');
      clear.type = 'radio';
      clear.name = 'tv-transform';
      clear.dataset.transformNone = '1';
      clear.addEventListener('change', () => {
        if (!clear.checked) return;
        setStudies(activeIds().filter(id => {
          const m = STUDIES.find(x => x.id === id);
          return m && m.kind !== 'transform';
        }));
      });
      clearBox.appendChild(clear);
      clearBox.appendChild(document.createTextNode(' No transform'));
      host.appendChild(clearBox);
      dlg.addEventListener('close', syncStudies);
      dlg.querySelector('#ind-filter')?.addEventListener('input', (e) => {
        const q = String(e.target.value || '').toLowerCase();
        host.querySelectorAll('label[data-label]').forEach((lab) => {
          lab.style.display = !q || lab.dataset.label.includes(q) ? 'flex' : 'none';
        });
      });
      dlg._syncStudies = syncStudies;
      syncStudies();
    }).catch(() => { /* studies dialog extension unavailable — Task-7 checkboxes still work */ });
    document.querySelector('#ind-btn')?.addEventListener('click', () => {
      dlg.querySelectorAll('input[data-ind]').forEach((cb) => {
        cb.checked = !!(v.get().indicators || {})[cb.dataset.ind];
      });
      if (typeof dlg._syncStudies === 'function') dlg._syncStudies();
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    });
  }
  // Replay mode: hides bars after replayIndex, step buttons <- / ->.
  const replayBtn = document.querySelector('#replay-btn');
  if (replayBtn && !replayBtn.dataset.bound) {
    replayBtn.dataset.bound = '1';
    let bar = null;
    const exitReplay = () => {
      v.set({ replayIndex: null });
      if (bar) { bar.remove(); bar = null; }
      replayBtn.classList.remove('active');
    };
    const step = (d) => {
      const st = v.get();
      if (st.replayIndex == null) return;
      const nx = Math.max(0, Math.min(rows.length - 1, st.replayIndex + d));
      v.set({ replayIndex: nx });
      if (bar) {
        const label = bar.querySelector('[data-rp="pos"]');
        if (label) label.textContent = `${nx + 1} / ${rows.length}`;
      }
    };
    replayBtn.addEventListener('click', () => {
      const st = v.get();
      if (st.replayIndex != null) { exitReplay(); return; }
      if (!rows.length) return;
      const start = rows.length > 30 ? rows.length - 30 : Math.floor(rows.length / 2);
      v.set({ replayIndex: start });
      replayBtn.classList.add('active');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'replay-bar';
        bar.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 8px;font:12px sans-serif';
        bar.innerHTML = '<button data-rp="back">&lt;-</button><span data-rp="pos"></span><button data-rp="fwd">-&gt;</button><button data-rp="exit">Exit</button>';
        bar.querySelector('[data-rp="back"]').addEventListener('click', () => step(-1));
        bar.querySelector('[data-rp="fwd"]').addEventListener('click', () => step(1));
        bar.querySelector('[data-rp="exit"]').addEventListener('click', exitReplay);
        document.querySelector('#chart-wrap')?.prepend(bar);
      }
      step(0);
    });
  }
  // Symbol search: re-fetch + reset visible (label/state change only on success).
  const symBtn = document.querySelector('#sym');
  if (symBtn && !symBtn.dataset.bound) {
    symBtn.dataset.bound = '1';
    symBtn.addEventListener('click', async () => {
      if (typeof prompt === 'undefined') return;
      const cur = v.get().symbol || 'BTC/USD';
      const ans = prompt('Symbol (e.g. BTC/USD, ETH/USD):', cur);
      if (!ans) return;
      const sym = normalizeSymbol(ans);
      if (!sym) return;
      await reload(sym, curInterval());
    });
  }
  // Watchlist sidebar: Symbol/Last/Chg/Chg% fed by the proxy (daily bars);
  // click a row to switch the chart to that symbol. Offline rows show em-dash.
  const WATCH = [
    { group: 'CRYPTO', sym: 'BTC/USD', label: 'BTCUSD' },
    { group: 'CRYPTO', sym: 'ETH/USD', label: 'ETHUSD' },
  ];
  const renderWatchlist = async () => {
    const host = document.querySelector('#watch-groups');
    if (!host) return;
    host.innerHTML = '';
    let group = null;
    for (const w of WATCH) {
      if (w.group !== group) {
        group = w.group;
        const g = document.createElement('div');
        g.className = 'wgroup';
        g.textContent = group;
        host.appendChild(g);
      }
      const row = document.createElement('button');
      row.className = 'wrow';
      let last = '—', chg = '—', chgp = '—', cls = '';
      try {
        const r = await fetch(`/api/ohlcv?symbol=${encodeURIComponent(w.sym)}&timeframe=1d&limit=2`);
        if (r.ok) {
          const d = normalizeOHLCV(await r.json());
          if (d.length) {
            const c = d[d.length - 1].c;
            last = c.toLocaleString('en-US', { maximumFractionDigits: c < 10 ? 3 : 0 });
            if (d.length >= 2) {
              const p = d[d.length - 2].c, dc = c - p, pct = dc / p * 100;
              cls = dc >= 0 ? 'up' : 'down';
              chg = (dc >= 0 ? '+' : '') + dc.toFixed(dc < 10 && dc > -10 ? 3 : 0);
              chgp = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
            }
          }
        }
      } catch {}
      row.innerHTML = '';
      const s0 = document.createElement('span'); s0.textContent = w.label;
      const s1 = document.createElement('span'); s1.textContent = last;
      const s2 = document.createElement('span'); s2.textContent = chg; if (cls) s2.className = cls;
      const s3 = document.createElement('span'); s3.textContent = chgp; if (cls) s3.className = cls;
      row.append(s0, s1, s2, s3);
      row.addEventListener('click', async () => {
        await reload(w.sym, curInterval());
        renderWatchlist();
      });
      host.appendChild(row);
    }
  };
  const watchAdd = document.querySelector('#watch-add');
  if (watchAdd && !watchAdd.dataset.bound) {
    watchAdd.dataset.bound = '1';
    watchAdd.addEventListener('click', async () => {
      if (typeof prompt === 'undefined') return;
      const ans = prompt('Add symbol (e.g. BTC/USD, ETH/USD):', '');
      const sym = normalizeSymbol(ans);
      if (!sym) return;
      if (!WATCH.some(w => w.sym === sym)) WATCH.push({ group: 'CRYPTO', sym, label: sym.replace('/', '') });
      renderWatchlist();
    });
  }
  renderWatchlist();
  // Timeframe D/1W/1H -> ccxt 1d/1w/1h (state + button label change only on success).
  const tfBtn = document.querySelector('#tf-btn');
  if (tfBtn && !tfBtn.dataset.bound) {
    tfBtn.dataset.bound = '1';
    if (!TF_ORDER.includes(tfBtn.textContent) && tfBtn.textContent !== 'D') { /* leave custom labels */ }
    tfBtn.textContent = tfLabel();
    tfBtn.addEventListener('click', async () => {
      const next = TF_ORDER[(TF_ORDER.indexOf(tfLabel()) + 1) % TF_ORDER.length];
      const ok = await reload(v.get().symbol || 'BTC/USD', TF_CCXT[next], next);
      if (ok) { tfBtn.textContent = next; v.set({ interval: TF_CCXT[next] }); }
    });
  }
  // Chart-type toggle: candles / bars / line.
  const ctBtn = document.querySelector('#ctype');
  if (ctBtn && !ctBtn.dataset.bound) {
    ctBtn.dataset.bound = '1';
    const ORDER = ['candles', 'bars', 'line'];
    ctBtn.addEventListener('click', () => {
      const next = ORDER[(ORDER.indexOf(v.get().chartType || 'candles') + 1) % ORDER.length];
      v.set({ chartType: next });
      saveLayout();
    });
  }

  // Task 8 polish: PNG export (composites base+overlay) + multi-layout Save dropdown.
  const LAYOUTS_KEY = 'tv-layouts';
  const getNamedLayouts = () => {
    try { return JSON.parse(localStorage.getItem(LAYOUTS_KEY) || '{}') || {}; }
    catch { return {}; }
  };
  const saveNamedLayout = (name) => {
    try {
      const all = getNamedLayouts();
      all[name] = layoutFromState(v.get());
      localStorage.setItem(LAYOUTS_KEY, JSON.stringify(all));
    } catch {}
  };
  const loadNamedLayout = (name) => {
    const all = getNamedLayouts();
    const L = all[name];
    if (!L) return;
    pushHistory();
    // Backward-compat: legacy named layouts may be a drawings array or a
    // {drawings, alerts} object; missing study/chart keys keep current state.
    const cur = v.get();
    const patch = { selectedId: null };
    if (Array.isArray(L)) { patch.drawings = L; patch.alerts = []; }
    else {
      if (L.drawings) patch.drawings = L.drawings;
      if (L.alerts) patch.alerts = L.alerts;
      if (L.studies) patch.studies = L.studies;
      if (L.indicators) patch.indicators = L.indicators;
      if (L.chartType) patch.chartType = L.chartType;
      if (L.symbol) {
        patch.symbol = L.symbol;
        const symBtn = document.querySelector('#sym');
        if (symBtn) symBtn.textContent = String(L.symbol).replace('/', '');
      }
      if (L.timeframe) patch.timeframe = L.timeframe;
      void cur;
    }
    v.set(patch);
    saveLayout();
  };
  const exportPNG = () => {
    const b = document.querySelector('#base');
    const o = document.querySelector('#overlay');
    if (!b) return;
    let url = '';
    try {
      url = compositeToDataURL(b, o);
    } catch {
      const c = document.createElement('canvas');
      c.width = b.width; c.height = b.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(b, 0, 0);
      if (o) ctx.drawImage(o, 0, 0);
      url = c.toDataURL('image/png');
    }
    const a = document.createElement('a');
    a.download = 'chart.png';
    a.href = url;
    a.click();
  };
  const saveBtn = [...document.querySelectorAll('#topbar button')].find((b) => (b.textContent || '').includes('Save'));
  if (!document.querySelector('#export-btn')) {
    const ex = document.createElement('button');
    ex.id = 'export-btn';
    ex.textContent = 'Export PNG';
    ex.addEventListener('click', exportPNG);
    if (saveBtn) saveBtn.before(ex);
    else document.querySelector('#topbar')?.appendChild(ex);
  }
  if (!document.querySelector('#layout-select')) {
    const sel = document.createElement('select');
    sel.id = 'layout-select';
    sel.title = 'Layouts';
    const refresh = () => {
      sel.innerHTML = '';
      const ph = document.createElement('option');
      ph.value = ''; ph.textContent = 'Layouts…';
      sel.appendChild(ph);
      for (const k of Object.keys(getNamedLayouts())) {
        const op = document.createElement('option');
        op.value = k; op.textContent = k;
        sel.appendChild(op);
      }
      const sv = document.createElement('option');
      sv.value = '__save__'; sv.textContent = 'Save current…';
      sel.appendChild(sv);
    };
    refresh();
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      if (sel.value === '__save__') {
        const name = typeof prompt !== 'undefined' ? prompt('Layout name:') : null;
        if (name) { saveNamedLayout(name); refresh(); }
      } else loadNamedLayout(sel.value);
      sel.value = '';
    });
    if (saveBtn) saveBtn.after(sel);
    else document.querySelector('#topbar')?.appendChild(sel);
    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = '1';
      saveBtn.addEventListener('click', () => {
        const name = typeof prompt !== 'undefined' ? prompt('Layout name:') : null;
        if (name) { saveNamedLayout(name); refresh(); }
      });
    }
  }
}
