// js/ui.js
import { fetchOHLCV, wasLive, normalizeOHLCV } from './data.js';
import { renderBase, PAL, stuColor, compositeToDataURL, visibleRows, sliceOffset, replayCount, xForRowTime, timeForX } from './chart.js';
import { renderPriceAxis, renderTimeAxis } from './axes.js';
import { hitTest, drawCrosshair, drawDrawings, drawAlerts, drawPending } from './overlay.js';
import { snapPrice, serialize, deserialize, addDrawing } from './drawings.js';
import { STUDIES, migrateStudies, makeInstance } from './studies.js';

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
      // Studies migrate to instances on load: legacy string[] ids and
      // Task-7 indicators flags both become instances; save never writes
      // legacy or indicators flags (layoutFromState persists state.studies
      // as instances only).
      let studies;
      if (parsed.studies !== undefined || parsed.indicators) {
        try { studies = migrateStudies({ studies: parsed.studies || [], indicators: parsed.indicators || {} }); }
        catch { studies = undefined; }
      }
      return {
        drawings: parsed.drawings || [],
        alerts: parsed.alerts || [],
        studies,
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
    if (persisted.chartType) patch.chartType = persisted.chartType;
    if (persisted.symbol) patch.symbol = persisted.symbol;
    if (persisted.timeframe) patch.timeframe = persisted.timeframe;
    if (persisted.interval) patch.interval = persisted.interval;
    if (Object.keys(patch).length) v.set(patch);
  }
  // One-shot: migrate any in-memory legacy indicators flags to instances,
  // then drop the flags (state relies on migrated instances from here on).
  try {
    const st0 = v.get();
    if (st0.indicators && Object.keys(st0.indicators).length) {
      const mig = migrateStudies({ studies: st0.studies || [], indicators: st0.indicators });
      v.set({ studies: mig, indicators: undefined });
    }
  } catch {}
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
      pending = null;
      v.set({ tool: 'cross' });
      document.querySelectorAll('#rail button').forEach(x => {
        if (x.dataset.tool === 'magnet') return;
        x.classList.toggle('active', x.dataset.tool === 'cross');
      });
    }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
      if (isEditable(e.target)) return;
      v.set({ tool: 'trend' });
      document.querySelectorAll('#rail button').forEach(x => {
        if (x.dataset.tool === 'magnet') return;
        x.classList.toggle('active', x.dataset.tool === 'trend');
      });
      pending = null;
    }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      if (isEditable(e.target)) return;
      v.set({ tool: 'fib' });
      document.querySelectorAll('#rail button').forEach(x => {
        if (x.dataset.tool === 'magnet') return;
        x.classList.toggle('active', x.dataset.tool === 'fib');
      });
      pending = null;
    }
    else if (e.key === 'Escape') {
      // Escape exits any drawing tool -> cross + clear pending anchor +
      // sync rail active class (mirrors c/t/f handler pattern). Runs even
      // from inputs so a stray anchor never survives; dialog Esc still
      // closes natively (no preventDefault).
      pending = null;
      v.set({ tool: 'cross' });
      document.querySelectorAll('#rail button').forEach(x => {
        if (x.dataset.tool === 'magnet') return;
        x.classList.toggle('active', x.dataset.tool === 'cross');
      });
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
  const paintBootRows = () => {
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
  };
  // Embedded-first boot: paint local fallback immediately (never awaits
  // whenCcxt), then upgrade to live rows only when the fetch actually
  // returned live exchange data (wasLive guard prevents mislabeling
  // embedded BTC rows as another symbol).
  fetch('./data/btcusd-1d.json').then((r) => r.json()).then((j) => {
    const fb = normalizeOHLCV(j);
    if (fb.length && !rows.length) { rows = fb; paintBootRows(); }
  }).catch(() => { /* embedded missing — live upgrade below still tries */ }).finally(() => {
    fetchOHLCV({ symbol: v.get().symbol || 'BTC/USD', timeframe: v.get().interval || '1d' }).then((data) => {
      if (!wasLive()) return;
      if (Array.isArray(data) && data.length) { rows = data; paintBootRows(); }
    }).catch(() => { /* offline + fallback failed — keep embedded/empty, no unhandled rejection */ });
  });
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
        // Unlimited-placement guarantee: never reset `tool` on placement.
        // The tool stays selected across unlimited placements until the user
        // switches tools or presses Escape (which sets cross + clears pending).
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
      // Pending rubber-band: anchor dot + dashed preview to cursor while a
      // 2-click anchor is set (non-destructive; renderAll clears it).
      if (pending && pending.p1) {
        try { drawPending(ctx, pending, { x: mx, y: my }, st, geom, rows); } catch {}
      }
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

  // Task 7: studies modal, replay, symbol/timeframe switching, chart-type toggle.
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
  // failure the old rows/label/scale are kept and an error toast is shown.
  const reload = async (symbol, ccxtTf, nextTf) => {
    try {
      const data = await fetchOHLCV({ symbol, timeframe: ccxtTf, limit: 300, liveOnly: true });
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
  // Indicators modal: Active instance cards + Browse groups with Add.
  // Task-7 checkboxes removed; state relies on migrated instances only.
  if (!document.querySelector('#ind-dialog')) {
    const cur = v.get();
    if (!cur.chartType) v.set({ chartType: 'candles' });
    if (!cur.studies) v.set({ studies: [] });
    const dlg = document.createElement('dialog');
    dlg.id = 'ind-dialog';
    dlg.innerHTML = '<div class="ind-head"><span class="ind-title">Indicators</span>'
      + '<input id="ind-filter" placeholder="Search…" autocomplete="off">'
      + '<button value="close" class="ind-close" type="button" title="Close">✕</button></div>'
      + '<div class="ind-sec"><div class="ind-sec-title">Active</div><div id="ind-active-list"></div></div>'
      + '<div class="ind-sec"><div class="ind-sec-title">Browse</div><div id="ind-groups"></div></div>';
    document.body.appendChild(dlg);
    const host = dlg.querySelector('#ind-groups');
    const activeHost = dlg.querySelector('#ind-active-list');
    const metaById = (id) => STUDIES.find((s) => s.id === id);
    const instances = () => {
      const raw = v.get().studies || [];
      return raw.filter((e) => e && typeof e === 'object' && typeof e.id === 'string');
    };
    const countById = (id) => instances().filter((e) => e.id === id).length;

    const commitStudies = (next) => {
      v.set({ studies: next });
      saveLayout();
      renderActive();
      syncBrowse();
    };
    const renderActive = () => {
      activeHost.innerHTML = '';
      const list = instances();
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'ind-empty';
        empty.textContent = 'No active indicators — add from Browse below.';
        activeHost.appendChild(empty);
        return;
      }
      const transforms = list.filter((e) => metaById(e.id)?.kind === 'transform' && e.visible !== false);
      const activeTUid = transforms.length ? transforms[0].uid : null;
      list.forEach((inst, idx) => {
        const meta = metaById(inst.id);
        if (!meta) return;
        const card = document.createElement('div');
        card.className = 'ind-card';
        card.dataset.uid = inst.uid;
        const top = document.createElement('div');
        top.className = 'ind-card-top';
        if (meta.kind === 'transform') {
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'tv-transform-active';
          radio.dataset.transformActive = inst.uid;
          radio.checked = inst.uid === activeTUid;
          radio.title = 'Active transform (selecting one replaces the other)';
          radio.addEventListener('change', () => {
            if (!radio.checked) return;
            const nonT = instances().filter((e) => metaById(e.id)?.kind !== 'transform');
            commitStudies([...nonT, { ...inst, visible: true }]);
          });
          top.appendChild(radio);
        }
        const label = document.createElement('span');
        label.className = 'ind-card-label';
        label.textContent = `${meta.label} (${meta.id})`;
        label.style.flex = '1';
        top.appendChild(label);
        const eye = document.createElement('button');
        eye.type = 'button';
        eye.dataset.eye = inst.uid;
        eye.title = 'Toggle visibility';
        eye.textContent = inst.visible === false ? '🚫' : '👁';
        eye.addEventListener('click', () => {
          commitStudies(instances().map((e) => (
            e.uid === inst.uid ? { ...e, visible: e.visible === false ? true : false } : e
          )));
        });
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.dataset.remove = inst.uid;
        rm.title = 'Remove';
        rm.textContent = '✕';
        rm.addEventListener('click', () => {
          commitStudies(instances().filter((e) => e.uid !== inst.uid));
        });
        top.appendChild(eye);
        top.appendChild(rm);
        card.appendChild(top);
        // Per-param number editors (min/max/step from defs, change commits).
        for (const def of meta.params || []) {
          const row = document.createElement('label');
          row.className = 'ind-param';
          const nm = document.createElement('span');
          nm.textContent = def.key;
          const inp = document.createElement('input');
          inp.type = 'number';
          inp.dataset.param = def.key;
          inp.dataset.uid = inst.uid;
          if (def.min != null) inp.min = String(def.min);
          if (def.max != null) inp.max = String(def.max);
          if (def.step != null) inp.step = String(def.step);
          const curVal = inst.params?.[def.key] ?? meta.opts?.[def.key] ?? '';
          inp.value = String(curVal);
          inp.addEventListener('change', () => {
            const rawVal = inp.value;
            const num = def.type === 'int' ? parseInt(rawVal, 10) : parseFloat(rawVal);
            if (!Number.isFinite(num)) { inp.value = String(inst.params?.[def.key] ?? ''); return; }
            commitStudies(instances().map((e) => (
              e.uid === inst.uid ? { ...e, params: { ...(e.params || {}), [def.key]: num } } : e
            )));
          });
          row.append(nm, inp);
          card.appendChild(row);
        }
        // Color swatch: value shows explicit color or palette fallback; Auto resets to null (palette).
        const colorRow = document.createElement('div');
        colorRow.className = 'ind-param';
        const colorLabel = document.createElement('span');
        colorLabel.textContent = 'color';
        const colorInp = document.createElement('input');
        colorInp.type = 'color';
        colorInp.dataset.color = inst.uid;
        let shown = inst.color;
        if (typeof shown !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(shown)) {
          try { shown = stuColor(inst.id, idx); } catch { shown = '#2962FF'; }
        }
        colorInp.value = shown;
        colorInp.title = inst.color ? 'Custom color (Auto resets to palette)' : 'Palette color (pick to customize)';
        colorInp.addEventListener('change', () => {
          commitStudies(instances().map((e) => (
            e.uid === inst.uid ? { ...e, color: colorInp.value } : e
          )));
        });
        const autoB = document.createElement('button');
        autoB.type = 'button';
        autoB.dataset.auto = inst.uid;
        autoB.textContent = 'Auto';
        autoB.title = 'Reset to palette color';
        autoB.addEventListener('click', () => {
          commitStudies(instances().map((e) => (
            e.uid === inst.uid ? { ...e, color: null } : e
          )));
        });
        colorRow.append(colorLabel, colorInp, autoB);
        card.appendChild(colorRow);
        activeHost.appendChild(card);
      });
    };
    // Browse groups (built once; badges synced on every refresh).
    const groups = [];
    for (const s of STUDIES) {
      let g = groups.find((x) => x.name === s.group);
      if (!g) { g = { name: s.group, items: [] }; groups.push(g); }
      g.items.push(s);
    }
    for (const g of groups) {
      const box = document.createElement('div');
      box.dataset.group = g.name;
      box.className = 'ind-group';
      const head = document.createElement('div');
      head.className = 'ind-group-head';
      const title = document.createElement('span');
      title.textContent = g.name;
      title.style.flex = '1';
      head.appendChild(title);
      box.appendChild(head);
      for (const s of g.items) {
        const row = document.createElement('div');
        row.className = 'ind-row';
        row.dataset.studyRow = s.id;
        row.dataset.label = `${s.id} ${s.label}`.toLowerCase();
        const lab = document.createElement('span');
        lab.className = 'ind-row-label';
        lab.textContent = `${s.label} (${s.id})`;
        lab.style.flex = '1';
        const badge = document.createElement('span');
        badge.className = 'ind-count';
        badge.dataset.count = s.id;
        badge.textContent = '0';
        const add = document.createElement('button');
        add.type = 'button';
        add.dataset.add = s.id;
        add.textContent = '+ Add';
        add.title = s.kind === 'transform' ? 'Add (replaces other transforms)' : `Add ${s.label}`;
        add.addEventListener('click', () => {
          try {
            const fresh = makeInstance(s.id);
            if (s.kind === 'transform') {
              const nonT = instances().filter((e) => metaById(e.id)?.kind !== 'transform');
              commitStudies([...nonT, fresh]);
            } else {
              commitStudies([...instances(), fresh]);
            }
          } catch { /* unknown id — skip */ }
        });
        row.append(lab, badge, add);
        box.appendChild(row);
      }
      host.appendChild(box);
    }
    const syncBrowse = () => {
      host.querySelectorAll('[data-count]').forEach((b) => {
        b.textContent = String(countById(b.dataset.count));
      });
    };
    const refreshModal = () => {
      // Normalize any legacy string entries to instances on open (writes
      // instances only going forward; chart already tolerates strings).
      try {
        const raw = v.get().studies || [];
        if (raw.some((e) => typeof e === 'string')) {
          const mig = migrateStudies(raw);
          v.set({ studies: mig });
          saveLayout();
        }
      } catch {}
      renderActive();
      syncBrowse();
    };
    dlg.querySelector('#ind-filter')?.addEventListener('input', (e) => {
      const q = String(e.target.value || '').toLowerCase();
      host.querySelectorAll('[data-study-row]').forEach((row) => {
        row.style.display = !q || (row.dataset.label || '').includes(q) ? 'flex' : 'none';
      });
      host.querySelectorAll('[data-group]').forEach((box) => {
        const anyVisible = [...box.querySelectorAll('[data-study-row]')].some((r) => r.style.display !== 'none');
        box.style.display = anyVisible ? '' : 'none';
      });
    });
    dlg.querySelector('button[value="close"]')?.addEventListener('click', () => {
      try { dlg.close(); } catch { dlg.removeAttribute('open'); }
    });
    dlg._syncStudies = refreshModal;
    document.querySelector('#ind-btn')?.addEventListener('click', () => {
      refreshModal();
      if (typeof dlg.showModal === 'function') {
        if (!dlg.open) dlg.showModal();
      } else dlg.setAttribute('open', '');
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
  // Watchlist sidebar: Symbol/Last/Chg/Chg% fed by browser CCXT (daily bars);
  // click a row to switch the chart to that symbol. liveOnly skips the
  // embedded BTC fallback so offline rows keep em-dash via the catch below.
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
        const d = await fetchOHLCV({ symbol: w.sym, timeframe: '1d', limit: 2, liveOnly: true });
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
      if (L.studies !== undefined || L.indicators) {
        try { patch.studies = migrateStudies({ studies: L.studies || [], indicators: L.indicators || {} }); }
        catch { /* keep current studies on migration failure */ }
      }
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
