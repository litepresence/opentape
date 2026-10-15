// js/ui.js
import { fetchOHLCV, resolveMarket, watchCandles, mergeCandle, timeframeMs } from './data.js';
import { renderBase, PAL, stuColor, autoColor, compositeToDataURL, visibleRows, sliceOffset, replayCount, xForRowTime, timeForX } from './chart.js';
import { renderPriceAxis, renderTimeAxis } from './axes.js';
import { hitTest, drawCrosshair, drawDrawings, drawAlerts, drawPending, hitTestDrawing, hitTestAnchor } from './overlay.js';
import { snapPrice, serialize, deserialize, addDrawing, makeDrawing, anchorCount, translateDrawing, moveAnchor, migrateDrawings } from './drawings.js';
import { RAIL, RAIL_GROUPS, ITEMS, ITEM_LIST, groupOf, firstToolOf, anchorsOf, iconSvg } from './tools.js';
import { parseChartUrl, formatChartUrl, normalizeSymbol } from './url.js';
import { STUDIES, migrateStudies, makeInstance } from './studies.js';

const LAYOUT_KEY = 'opentape-layout-v1';
const LEGACY_LAYOUT_KEY = 'tv-clone-layout-v1';
// Captured at import: later replaceState syncs may rewrite location.search,
// so the debug hook must not depend on reading it at initUI end.
let HAS_DEBUG = false;
try { HAS_DEBUG = new URLSearchParams(location.search).has('debug'); } catch {}

export function initUI(v) {
  document.documentElement.dataset.theme = v.get().theme;
  document.querySelector('#theme-btn')?.addEventListener('click', () => v.toggleTheme());
  // Task 6 state: magnet, pending 2-click anchor, undo/redo stacks.
  let magnetOn = true;
  let magnetStrength = 'weak';   // Magnets menu: weak | strong
  // Stay in drawing mode (original default): the tool persists after each
  // placement; when off the rail returns to cross. Persisted per user.
  let stayMode = true;
  // Last-used tool per rail group (the original toolbar slot keeps the picked
  // variant: the glyph re-arms it, and re-clicking the armed group opens the
  // flyout instead). Defaults to each group's first tool.
  const groupCurrent = {};
  // Text-tool style (size 1–100x of the 13px base, indicator-style color with
  // Auto = inherit, opacity). Chosen in the text picker, carried onto each
  // placed drawing, persisted across sessions like the icon scale.
  const TEXT_BASE = 13;
  const TEXT_SCALE_KEY = 'opentape-text-scale';
  const TEXT_COLOR_KEY = 'opentape-text-color';
  const TEXT_OPACITY_KEY = 'opentape-text-opacity';
  const clampTextScale = (n) => Math.min(100, Math.max(1, Math.round(Number(n) || 1)));
  let textScale = 1, textColor = null, textOpacity = 1;
  try { textScale = clampTextScale(localStorage.getItem(TEXT_SCALE_KEY)); } catch {}
  try {
    const tc = localStorage.getItem(TEXT_COLOR_KEY);
    textColor = (typeof tc === 'string' && /^#[0-9a-fA-F]{6}$/.test(tc)) ? tc : null;
  } catch {}
  try {
    // NOTE: getItem returns null when unset and Number(null) === 0, so a
    // missing key must fall back to 1 (fully opaque), not 0 (invisible).
    const raw = localStorage.getItem(TEXT_OPACITY_KEY);
    const to = raw == null ? NaN : Number(raw);
    textOpacity = Number.isFinite(to) ? Math.min(1, Math.max(0, to)) : 1;
  } catch {}
  let pending = null;
  let measureStart = null;
  const undoStack = [];
  const redoStack = [];
  const tForX = (x, vis, left, width) => vis.from + ((x - left) / Math.max(1, width)) * (vis.to - vis.from);
  const pForY = (y, pr, top, height) => pr.min + (1 - (y - top) / Math.max(1, height)) * (pr.max - pr.min);
  const showToast = (msg, action = null) => {
    console.warn(msg);
    try {
      let el = document.querySelector('#toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.style.cssText = 'position:fixed;bottom:48px;left:50%;transform:translateX(-50%);background:#323232;color:#fff;padding:8px 14px;border-radius:4px;font:13px sans-serif;z-index:9999;opacity:0.95;gap:4px';
        document.body.appendChild(el);
      }
      el.textContent = '';
      const span = document.createElement('span');
      span.textContent = msg;
      el.appendChild(span);
      if (action) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = action.label;
        btn.style.cssText = 'margin-left:10px;padding:3px 10px;border-radius:4px;border:1px solid rgba(255,255,255,.5);background:transparent;color:#fff;cursor:pointer;font:inherit;font-size:12px';
        btn.addEventListener('click', () => { action.onAction(); hideToast(); });
        el.appendChild(btn);
      }
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => { el.style.display = 'none'; }, action ? 8000 : 4000);
    } catch {}
  };
  const hideToast = () => {
    const el = document.querySelector('#toast');
    if (el) el.style.display = 'none';
  };
  const layoutFromState = (s) => ({
    drawings: s.drawings || [],
    alerts: s.alerts || [],
    studies: s.studies || [],
    chartType: s.chartType || 'candles',
    symbol: s.symbol || 'BTC/USD',
    timeframe: s.timeframe || '1D',
    interval: s.interval || '1d',
    source: s.source || '',
    venue: s.venue || '',
    locked: !!s.locked,
    lockedDrawings: !!s.lockedDrawings,
    lockedIndicators: !!s.lockedIndicators,
    drawingsHidden: !!s.drawingsHidden,
    indicatorsHidden: !!s.indicatorsHidden,
    priceAuto: s.priceAuto !== false,
    stayMode: s.stayMode !== false,
    snapIndicators: !!s.snapIndicators,
    valuesTooltip: !!s.valuesTooltip,
    removeLocked: !!s.removeLocked,
  });
  const saveLayout = () => {
    try {
      localStorage.setItem(LAYOUT_KEY, serialize(layoutFromState(v.get())));
    } catch {}
  };
  const loadLayout = () => {
    try {
      // Opentape key first; one-shot adopt the legacy tv-clone key so
      // existing users keep their drawings (re-saved under the new key).
      let raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) {
        raw = localStorage.getItem(LEGACY_LAYOUT_KEY);
        if (raw) { try { localStorage.setItem(LAYOUT_KEY, raw); localStorage.removeItem(LEGACY_LAYOUT_KEY); } catch {} }
      }
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
        source: parsed.source,
        venue: parsed.venue,
        locked: parsed.locked,
        lockedDrawings: parsed.lockedDrawings,
        lockedIndicators: parsed.lockedIndicators,
        drawingsHidden: parsed.drawingsHidden,
        indicatorsHidden: parsed.indicatorsHidden,
        priceAuto: parsed.priceAuto,
        stayMode: parsed.stayMode,
        snapIndicators: parsed.snapIndicators,
        valuesTooltip: parsed.valuesTooltip,
        removeLocked: parsed.removeLocked,
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
    if (persisted.drawings) patch.drawings = migrateDrawings(persisted.drawings);
    if (persisted.alerts) patch.alerts = persisted.alerts;
    if (persisted.studies) patch.studies = persisted.studies;
    if (persisted.chartType) patch.chartType = persisted.chartType;
    if (persisted.symbol) patch.symbol = persisted.symbol;
    if (persisted.timeframe) patch.timeframe = persisted.timeframe;
    if (persisted.interval) patch.interval = persisted.interval;
    if (persisted.source) patch.source = persisted.source;
    if (persisted.venue) patch.venue = persisted.venue;
    if (persisted.locked) patch.locked = true;
    if (persisted.lockedDrawings) patch.lockedDrawings = true;
    if (persisted.lockedIndicators) patch.lockedIndicators = true;
    if (persisted.drawingsHidden) patch.drawingsHidden = true;
    if (persisted.indicatorsHidden) patch.indicatorsHidden = true;
    if (persisted.priceAuto === false) patch.priceAuto = false;
    if (persisted.stayMode === false) patch.stayMode = false;
    if (persisted.snapIndicators) patch.snapIndicators = true;
    if (persisted.valuesTooltip) patch.valuesTooltip = true;
    if (persisted.removeLocked) patch.removeLocked = true;
    stayMode = persisted.stayMode !== false;
    if (Object.keys(patch).length) v.set(patch);
  }
  // Parameterized URLs (original-compatible): ?symbol=BITSTAMP:BTCUSD&interval=D
  // overrides the stored layout on load; the URL is kept in sync afterwards
  // so links are shareable.
  try {
    const q = parseChartUrl(location.search);
    const upatch = {};
    if (q.symbol) upatch.symbol = q.symbol;
    if (q.interval) upatch.interval = q.interval;
    if (q.timeframe) upatch.timeframe = q.timeframe;
    // Companion routing params (kept in ui.js so js/url.js stays untouched):
    // ?source=yahoo&venue=US carries the tier-1/tier-2 selection. Venue ids
    // keep their listed case and may contain hyphens (MOEX-SHARES, CN-A,
    // ECB-FX): lowercasing or rejecting the hyphen would drop the venue and
    // break companion routing on reload/shared links.
    try {
      const rawQ = new URLSearchParams(location.search);
      const so = String(rawQ.get('source') || '').trim().toLowerCase();
      const ve = String(rawQ.get('venue') || '').trim();
      if (/^[a-z][a-z0-9_]*$/.test(so)) upatch.source = so;
      if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(ve)) upatch.venue = ve;
    } catch {}
    if (Object.keys(upatch).length) v.set(upatch);
  } catch {}
  let lastUrl = '';
  const syncUrl = () => {
    try {
      const s = v.get();
      // Merge into the live query string so foreign params (debug, theme
      // overrides, campaign tags) survive UI-driven syncs.
      const cur = new URLSearchParams(location.search);
      let ex = '';
      try { ex = String(resolveMarket(s.symbol || 'BTC/USD').exchange || '').toLowerCase(); } catch {}
      const next = new URLSearchParams(formatChartUrl({ symbol: s.symbol, interval: s.interval || '1d', exchange: ex }));
      for (const [k, val] of next) cur.set(k, val);
      // Tier routing survives UI-driven syncs alongside the exchange param
      // (source ids are lowercase; venue ids keep their listed case so
      // hyphenated/cased venues like MOEX-SHARES round-trip intact).
      const so = String(s.source || '').toLowerCase();
      if (/^[a-z][a-z0-9_]*$/.test(so)) cur.set('source', so);
      else cur.delete('source');
      const ve = String(s.venue || '');
      if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(ve)) cur.set('venue', ve);
      else cur.delete('venue');
      const url = location.pathname + '?' + cur.toString();
      if (url !== lastUrl) {
        lastUrl = url;
        history.replaceState(null, '', url);
      }
    } catch {}
  };
  v.subscribe(() => syncUrl());
  syncUrl();
  // One-shot: migrate any in-memory legacy indicators flags to instances,
  // then drop the flags (state relies on migrated instances from here on).
  try {
    const st0 = v.get();
    if (st0.indicators && Object.keys(st0.indicators).length) {
      const mig = migrateStudies({ studies: st0.studies || [], indicators: st0.indicators });
      v.set({ studies: mig, indicators: undefined });
    }
  } catch {}
  // --- rail ---------------------------------------------------------------
  // The rail is generated from js/tools.js so it can never drift from the
  // captured spec. Each entry is a glyph that arms the group's current tool,
  // plus (for groups) a chevron that opens the tool menu.
  const railEl = document.querySelector('#rail');
  const railBtns = new Map();
  const buildRail = () => {
    if (!railEl) return;
    railEl.innerHTML = '';
    for (const g of RAIL) {
      const current = firstToolOf(g.id);
      const wrap = document.createElement('div');
      wrap.className = 'rail-item';
      wrap.dataset.group = g.id;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rail-btn';
      b.dataset.groupId = g.id;
      b.dataset.tool = g.direct ? g.id : current;
      b.title = g.direct ? g.label : `${g.label} — click to use ${current ? (ITEMS[current]?.label || '') : ''}`;
      b.innerHTML = iconSvg(g.icon);
      wrap.appendChild(b);
      railBtns.set(g.id, b);
      if (!g.direct && g.sections.length) {
        const chev = document.createElement('button');
        chev.type = 'button';
        chev.className = 'rail-chev';
        chev.dataset.chevron = g.id;
        chev.setAttribute('aria-label', g.label);
        chev.title = g.label;
        chev.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
        wrap.appendChild(chev);
      }
      railEl.appendChild(wrap);
    }
  };
  buildRail();

  // Mode toggles the rail reflects (magnets, lock, hide).
  const modeFlags = () => {
    const s = v.get();
    return {
      magnets: magnetOn,
      lock: !!(s.locked || s.lockedDrawings || s.lockedIndicators),
      hide: !!s.drawingsHidden,
      stay: stayMode,
    };
  };
  const currentOf = (gid) => groupCurrent[gid] || firstToolOf(gid);
  const syncRail = () => {
    const tool = v.get().tool;
    const flags = modeFlags();
    for (const [gid, b] of railBtns) {
      const g = RAIL_GROUPS[gid];
      // Keep the glyph's armed-tool pointer and tooltip on the last-used
      // variant so re-arming (and the plain-key shortcuts below) stay exact.
      if (g && !g.direct && currentOf(gid)) {
        b.dataset.tool = currentOf(gid);
        b.title = `${g.label} — click to use ${ITEMS[currentOf(gid)]?.label || ''}`;
      }
      const armed = g.direct ? flags[gid] === true || tool === gid : tool && groupOf(tool) === gid;
      b.classList.toggle('active', !!armed);
      b.classList.toggle('engaged', !!flags[gid]);
    }
  };
  // Rail glyph click: arm the group's last-used tool, or run its direct
  // action. Re-clicking the already-armed group's glyph toggles its menu —
  // the original toolbar re-click opens the flyout — so every button reaches
  // its submenu with plain clicks; the chevron opens it directly.
  const setMode = (key, on) => { v.set({ [key]: on }); syncRail(); saveLayout(); };
  const removeWhat = (what) => {
    const s = v.get();
    const nD = (s.drawings || []).length;
    const nS = (s.studies || []).length;
    if (what === 'drawings' && !nD) { showToast('No drawings to remove'); return; }
    if (what === 'indicators' && !nS) { showToast('No indicators to remove'); return; }
    if (what === 'all' && !nD && !nS) { showToast('Nothing to remove'); return; }
    // "Always remove locked drawings" bypasses the drawings lock for explicit
    // removals; the indicators lock always holds for indicator removals.
    const drawingsLocked = (s.locked || s.lockedDrawings) && !s.removeLocked;
    const indicatorsLocked = !!(s.locked || s.lockedIndicators);
    if ((what === 'drawings' || what === 'all') && nD && drawingsLocked) { showToast('Drawings are locked', { label: 'Unlock', onAction: () => toggleLock() }); return; }
    if ((what === 'indicators' || what === 'all') && nS && indicatorsLocked) { showToast('Indicators are locked', { label: 'Unlock', onAction: () => toggleLock() }); return; }
    pushHistory();
    const patch = { selectedId: null };
    if (what === 'drawings' || what === 'all') { patch.drawings = []; patch.alerts = []; }
    if (what === 'indicators' || what === 'all') { patch.studies = []; }
    v.set(patch);
    saveLayout();
    showToast(what === 'all' ? `Removed ${nD} drawing${nD === 1 ? '' : 's'} & ${nS} indicator${nS === 1 ? '' : 's'}` : `Removed ${what === 'drawings' ? nD : nS} ${what === 'drawings' ? (nD === 1 ? 'drawing' : 'drawings') : (nS === 1 ? 'indicator' : 'indicators')}`);
  };
  const ACTIONS = {
    'lock:drawings': () => setMode('lockedDrawings', !v.get().lockedDrawings),
    'lock:indicators': () => setMode('lockedIndicators', !v.get().lockedIndicators),
    'lock:all': () => toggleLock(),
    'hide:drawings': () => setMode('drawingsHidden', !v.get().drawingsHidden),
    'hide:indicators': () => setMode('indicatorsHidden', !v.get().indicatorsHidden),
    'hide:positions': () => showToast('No positions or orders on this chart'),
    'hide:all': () => { setMode('drawingsHidden', true); setMode('indicatorsHidden', true); },
    'remove:drawings': () => removeWhat('drawings'),
    'remove:indicators': () => removeWhat('indicators'),
    'remove:all': () => removeWhat('all'),
    'magnet:weak': () => { magnetOn = true; magnetStrength = 'weak'; syncRail(); saveLayout(); showToast('Weak magnet — snaps to the nearest OHLC'); },
    'magnet:strong': () => { magnetOn = true; magnetStrength = 'strong'; syncRail(); saveLayout(); showToast('Strong magnet — snaps to open/close/high/low'); },
    'cursor:cross': () => armTool('cross'),
    'cursor:dot': () => armTool('dot'),
    'cursor:arrow': () => armTool('arrow-cursor'),
    'cursor:demo': () => armTool('demonstration'),
    'cursor:magic': () => armTool('magic'),
    'cursor:eraser': () => armTool('eraser'),
    'open:emoji': () => openEmojiPicker(),
  };
  document.querySelectorAll('#rail button[data-group-id]').forEach((b) => {
    b.addEventListener('click', () => {
      const gid = b.dataset.groupId;
      const g = RAIL_GROUPS[gid];
      if (!g) return;
      if (g.id === 'magnets') { magnetOn = !magnetOn; syncRail(); saveLayout(); showToast(magnetOn ? `Magnet on (${magnetStrength}) — drawings snap to OHLC` : 'Magnet off'); return; }
      if (g.id === 'stay') { stayMode = !stayMode; v.set({ stayMode }); syncRail(); saveLayout(); showToast(stayMode ? 'Stay in drawing mode on' : 'Stay in drawing mode off'); return; }
      if (g.id === 'lock') { toggleLock(); return; }
      if (g.id === 'hide') { const on = !v.get().drawingsHidden; setMode('drawingsHidden', on); showToast(on ? 'Drawings hidden' : 'Drawings shown'); return; }
      if (g.id === 'zoom') {
        const s = v.get();
        if (s.visible && rows.length && s.visible.to > s.visible.from) {
          const span = s.visible.to - s.visible.from;
          const mid = (s.visible.from + s.visible.to) / 2;
          const nSpan = span * 0.8;
          v.set({ visible: { from: mid - nSpan / 2, to: mid + nSpan / 2 } });
          showToast('Zoomed in');
        } else showToast('No data to zoom');
        return;
      }
      if (g.id === 'measure') { setTool('measure'); return; }
      if (g.id === 'icons') { openEmojiPicker(); return; }
      if (g.id === 'remove') {
        const s = v.get();
        if ((s.locked || s.lockedDrawings) && !s.removeLocked) { showToast('Drawings are locked', { label: 'Unlock', onAction: () => toggleLock() }); return; }
        if (!s.drawings.length && !s.alerts.length) { showToast('Nothing to remove'); return; }
        pushHistory();
        v.set({
          drawings: s.selectedId ? s.drawings.filter((d) => d.id !== s.selectedId) : s.drawings.slice(0, -1),
          alerts: s.selectedId ? (s.alerts || []).filter((a) => a.id !== s.selectedId) : s.alerts,
          selectedId: null,
        });
        saveLayout();
        showToast(s.selectedId ? 'Object removed' : 'Last object removed');
        return;
      }
      // Variant groups: first click arms the last-used tool; re-clicking the
      // already-armed group toggles its menu (original flyout behavior), so
      // plain button clicks always reach the submenu. Mode groups (magnets,
      // lock, hide, remove) never arm a tool, so their glyphs keep toggling.
      const cur = v.get().tool;
      if (!g.direct && g.id !== 'icons' && g.sections.length && cur && groupOf(cur) === gid) {
        openToolMenu(gid, b.parentElement);
        return;
      }
      const t = currentOf(gid);
      if (t) { pending = null; armTool(t); }
    });
  });
  // Reflect persisted mode state on the freshly built rail.
  syncRail();
  syncLockBadge(!!v.get().locked);
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
    else if (e.altKey && !e.ctrlKey && !e.metaKey) {
      // Original sidebar shortcuts: Alt+T/F/H/J/V/C arm the matching tool.
      // Shown in the menus; previously displayed but unbound.
      if (isEditable(e.target)) return;
      const k = (e.key || '').toLowerCase();
      const map = { t: 'trend', f: 'fib', h: 'horizontal', j: 'hray', v: 'vertical', c: 'crossline' };
      if (map[k]) { e.preventDefault(); armTool(map[k]); }
    }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      if (isEditable(e.target)) return;
      armTool('cross');
    }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
      if (isEditable(e.target)) return;
      armTool('trend');
    }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      if (isEditable(e.target)) return;
      armTool('fib');
    }
    else if (e.key === 'Escape') {
      // Escape exits any drawing tool -> cross + clear pending anchor.
      // Runs even from inputs so a stray anchor never survives; dialog Esc
      // still closes natively (no preventDefault).
      pending = null;
      measureStart = null;
      closeMenu();
      closeToolMenu();
      toolMenuOpen = false;
      armTool('cross');
    }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (isEditable(e.target)) return;
      const s = v.get();
      if ((s.locked || s.lockedDrawings) && !s.removeLocked) { showToast('Drawings are locked', { label: 'Unlock', onAction: () => toggleLock() }); return; }
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
  // Live-stream status dot next to the clock (LIVE / DELAYED / OFFLINE).
  const rangeClock = document.querySelector('#clock');
  if (rangeClock && !document.querySelector('#live-dot')) {
    const dot = document.createElement('span');
    dot.id = 'live-dot';
    dot.dataset.state = 'off';
    dot.style.cssText = 'font-size:11px;margin-left:8px;color:#787b86';
    rangeClock.after(dot);
  }
  // Staleness check: silence longer than two intervals means DELAYED.
  setInterval(() => {
    try {
      if (!streamActive()) return;
      const limit = Math.max(60000, 2 * timeframeMs(v.get().interval || '1d'));
      if (Date.now() - lastStreamTs > limit) setStreamState('delayed');
    } catch {}
  }, 5000);
  document.addEventListener('visibilitychange', () => {
    try {
      if (document.hidden) stopStream();
      else if (rows.length) startStream();
    } catch {}
  });

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
    // Weak magnet: 8px tolerance; strong magnet: wider 16px pull.
    const px = magnetStrength === 'strong' ? 16 : 8;
    const tol = (span / Math.max(1, geom.height)) * px;
    // Snap against the bars on screen only: snapping to a price that exists
    // on an off-screen bar puts the drawing where no candle is.
    const sliced = visibleRows(rows, state.visible);
    return snapPrice(p, sliced.length ? sliced : rows, tol);
  };
  function renderAll(state) {
    if (!base || !rows.length || !state.visible || !state.price) return;
    const geom = geomFor();
    renderBase(base.getContext('2d'), state, rows, geom);
    // Pan/zoom invalidates hover — clear overlay so no stale crosshair lingers.
    if (overlay) {
      const octx = overlay.getContext('2d');
      octx.clearRect(0, 0, overlay.width, overlay.height);
      if (!state.drawingsHidden) drawDrawings(octx, state.drawings, state, geom, rows);
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
  // Price bounds snap outward to a magnitude-aware step (a tenth of the
  // data-span decade) instead of a hardcoded 1000 — a $150 coin needs $1
  // steps and a $0.15 coin $0.001 steps, or market switches land on a
  // collapsed 0–1000 scale with the candles squeezed invisible.
  const priceBounds = (mn, mx) => {
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) return null;
    if (!(mx > mn)) { mn -= 1; mx += 1; }
    const pad = (mx - mn) * 0.08;
    const lo = mn - pad, hi = mx + pad;
    const mag = 10 ** Math.floor(Math.log10(Math.max(hi - lo, 1e-12)));
    const step = mag / 10;
    const price = { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step };
    if (!(price.max > price.min)) price.max = price.min + step;
    return price;
  };
  const scaleFor = (list) => {
    let mn = Infinity, mx = -Infinity;
    for (const r of list) { if (r.l < mn) mn = r.l; if (r.h > mx) mx = r.h; }
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) return null;
    if (!(mx > mn)) { mn -= 1; mx += 1; }
    const price = priceBounds(mn, mx);
    if (!price) return null;
    return { visible: { from: list[0].t, to: list[list.length - 1].t }, price };
  };
  // Live-only boot: show a loading state until real bars arrive, then paint.
  // On failure show the error + retry. No embedded dataset exists by design —
  // painting BTC candles under an ETH header would be misleading.
  const dataStatus = { state: 'loading', msg: '' };
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
    // Restored symbol/timeframe from layout: reflect in topbar + header.
    updateSymbolHead();
    if (Object.keys(patch).length) v.set(patch);
    else renderAll(v.get());
    const cur = v.get();
    if (cur.visible && !fullVisible) fullVisible = { ...cur.visible };
    if (cur.price && !fullPrice) fullPrice = { ...cur.price };
  };
  const setDataStatus = (state, msg = '') => {
    dataStatus.state = state;
    dataStatus.msg = msg;
    let el = document.querySelector('#data-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'data-status';
      document.querySelector('#canvas-stack')?.appendChild(el);
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-retry]')) loadData();
      });
    }
    el.className = state;
    el.innerHTML = '';
    if (state === 'loading') {
      el.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Loading market data…</span>';
    } else if (state === 'error') {
      el.innerHTML = '<strong>No market data</strong><span class="msg"></span><button type="button" data-retry>Retry</button>';
      el.querySelector('.msg').textContent = msg;
    }
    el.style.display = state === 'ok' || !rows.length ? 'none' : '';
    if (state === 'error') el.style.display = '';
  };
  // Live candle streaming: exactly one active subscription. Started after
  // every successful load/reload, stopped on switch, failure, or hidden tab.
  let stream = null;
  let streamState = 'off';
  let lastStreamTs = 0;
  let streamKey = null;
  const streamActive = () => !!stream;
  const setStreamState = (s) => {
    streamState = s;
    const el = document.querySelector('#live-dot');
    if (el) {
      el.dataset.state = s;
      el.textContent = s === 'live' ? '● LIVE' : s === 'delayed' ? '● DELAYED' : s === 'off' ? '' : '● OFFLINE';
      el.title = s === 'live' ? 'Streaming live candles' : s === 'delayed' ? 'No candle updates recently' : s === 'off' ? '' : 'Stream offline — showing last data';
    }
  };
  const onStreamCandle = (row) => {
    if (!row || !rows.length) return;
    rows = mergeCandle(rows, row);
    lastStreamTs = Date.now();
    if (streamState !== 'live') setStreamState('live');
    const st = v.get();
    if (st.replayIndex == null || !Number.isFinite(st.replayIndex)) {
      refitPriceToVisible();
      const last = rows[rows.length - 1];
      if (last && fullVisible) fullVisible = { ...fullVisible, to: last.t };
    }
    renderAll(v.get());
  };
  const startStream = () => {
    stopStream();
    const s = v.get();
    const symbol = s.symbol || 'BTC/USD';
    const tf = s.interval || '1d';
    lastStreamTs = Date.now();
    streamKey = { symbol, tf };
    stream = watchCandles({
      symbol,
      timeframe: tf,
      onCandle: onStreamCandle,
      onStatus: (st, detail) => {
        if (st === 'live') { lastStreamTs = Date.now(); setStreamState('live'); }
        else if (st === 'polling') setStreamState('live');
        else { setStreamState('offline'); if (detail) console.warn('Stream offline', detail); }
      },
    });
  };
  function stopStream() {
    try { stream && stream.stop(); } catch {}
    stream = null;
    streamKey = null;
  }
  const loadData = async () => {
    const s = v.get();
    setDataStatus('loading');
    try {
      const data = await fetchOHLCV({ symbol: s.symbol || 'BTC/USD', timeframe: s.interval || '1d' });
      if (!Array.isArray(data) || !data.length) throw new Error('No rows returned');
      rows = data;
      paintBootRows();
      setDataStatus('ok');
      startStream();
    } catch (e) {
      console.warn('Market data unavailable', e?.message ?? e);
      setDataStatus('error', e?.message ?? String(e));
      stopStream();
      setStreamState('off');
    }
  };
  loadData();
  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    const raf = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame : (cb) => setTimeout(cb, 0);
    raf(() => { resizeQueued = false; fitCanvases(); renderAll(v.get()); });
  });

  // Auto price scale (original behavior): while on, any time navigation
  // refits price to the visible bars. Any manual price adjustment (plot
  // vertical drag, price-axis drag/wheel, shift+wheel) turns it off;
  // price-axis double-click turns it back on. Pan/zoom-only changes never
  // persist the fitted price; the on/off preference itself is persisted.
  const refitPriceToVisible = () => {
    const st = v.get();
    if (st.priceAuto === false) return false;
    if (!rows.length || !st.visible) return false;
    const sliced = visibleRows(rows, st.visible);
    const sc = scaleFor(sliced.length ? sliced : rows);
    if (!sc) return false;
    v.set({ price: sc.price });
    return true;
  };
  const syncScaleTip = () => {
    if (!priceAxis) return;
    priceAxis.title = v.get().priceAuto !== false
      ? 'Auto scale on — drag to rescale, double-click to auto-fit'
      : 'Auto scale off — double-click to auto-fit';
  };
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
  // Chart header (icon / name / timeframe / exchange) follows state — the
  // original updates it on every symbol switch, so a static label that says
  // Bitcoin/Bitstamp under an ETH chart is a bug, not a stub.
  const SYMBOL_META = {
    'BTC/USD': { icon: '₿', name: 'Bitcoin / U.S. Dollar' },
    'ETH/USD': { icon: 'Ξ', name: 'Ethereum / U.S. Dollar' },
  };
  const EX_LABEL = { bitstamp: 'Bitstamp', binance: 'Binance', coinbase: 'Coinbase' };
  const displaySymbol = (s) => String(s || 'BTC/USD').replace(/^[A-Za-z0-9_]+:/, '');
  const headCache = { key: '' };
  const updateSymbolHead = () => {
    const s = v.get();
    const disp = displaySymbol(s.symbol);
    let exchange = '', icon = '◉', name = disp.replace('/', ' / ');
    try {
      const m = resolveMarket(s.symbol || 'BTC/USD');
      const ex = String(m.exchange || '').toLowerCase();
      exchange = EX_LABEL[ex] || (ex ? ex[0].toUpperCase() + ex.slice(1) : '');
    } catch {}
    const meta = SYMBOL_META[disp];
    if (meta) { icon = meta.icon; name = meta.name; }
    const tf = s.timeframe || '1D';
    const key = `${icon}|${name}|${tf}|${exchange}`;
    if (key === headCache.key) return;
    headCache.key = key;
    const set = (id, txt) => { const el = document.querySelector(id); if (el) el.textContent = txt; };
    set('#sym-icon', icon);
    set('#sym-name', name);
    set('#sym-tf', tf);
    set('#sym-ex', exchange);
    const symBtn = document.querySelector('#sym');
    if (symBtn) symBtn.textContent = disp.replace('/', '');
  };
  // Exchange switching has no button: only Binance is CORS-clean through
  // CCXT's market-load path (Bitstamp/Coinbase block pairs-info/currencies
  // preflights — verified live). Prefixed symbols (exchange:PAIR) still
  // parse and attempt gracefully. If a second venue verifies, add #ex-btn.
  // Every rail item that places something on the chart (cursor/action items do not).
  const DRAW_TOOLS = new Set(ITEM_LIST.filter((i) => i.anchors > 0).map((i) => i.id));
  let brushPath = null;      // in-progress freehand points
  let brushTool = 'brush';   // which freehand tool is being dragged
  let demoStep = -1;         // Demonstration cursor progress
  let brushDrawingId = null; // id of the committed freehand drawing
  let dragDrawingId = null;  // drawing being moved/edited
  let dragAnchorIdx = -1;    // anchor index when editing a single point
  let dragStartPoint = null; // pointer anchor captured at body-drag start
  let dragOrigin = null;     // original points snapshot for a body drag
  const cursorPoint = (mx, geom, st, my = null) => {
    const sliced = visibleRows(rows, st.visible);
    const src = sliced.length ? sliced : null;
    return {
      t: src ? timeForX(mx, src, geom.left, geom.width) : tForX(mx, st.visible, geom.left, geom.width),
      p: maybeSnap(pForY(my ?? geom.top, st.price, geom.top, geom.height), geom, st),
    };
  };
  function toggleLock() {
    const st = v.get();
    const locked = !(st.locked || st.lockedDrawings);
    v.set({ locked, lockedDrawings: locked, lockedIndicators: locked });
    syncRail();
    syncLockBadge(locked);
    showToast(locked ? 'Drawings and indicators locked' : 'Drawings unlocked');
    saveLayout();
  }
  // Persistent header badge: a mode toggle left on must never look like hover.
  function syncLockBadge(on) {
    let el = document.querySelector('#locked-badge');
    if (!on) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('button');
      el.id = 'locked-badge';
      el.type = 'button';
      el.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid #2962FF;color:#2962FF;background:transparent;cursor:pointer';
      el.addEventListener('click', () => toggleLock());
      document.querySelector('#ohlc-head')?.prepend(el);
    }
    el.textContent = 'Drawings locked · click to unlock';
  }
  // Carry the rail item's renderer spec (and a default caption for text-like
  // tools) onto the drawing record so js/geometry.js can build its shapes.
  const drawingExtras = (spec) => {
    const x = { kind: spec.kind };
    if (spec.variant) x.variant = spec.variant;
    if (spec.labels) x.labels = spec.labels;
    if (spec.smooth) x.smooth = true;
    if (spec.close) x.close = true;
    if (TEXT_TOOLS.has(spec.kind) || spec.kind === 'infoline') {
      const def = spec.label ? String(spec.label).toLowerCase() : '';
      const asked = typeof prompt !== 'undefined' ? prompt('Text:', def) : null;
      if (asked === null) { x.cancel = true; return x; }
      x.text = asked || def;
    }
    return x;
  };
  const TEXT_TOOLS = new Set(['text', 'note', 'pricenote', 'pricelabel', 'callout', 'post', 'infoline']);
  // Cursors menu: which pointer shape the crosshair wears.
  const cursorShape = (tool) => (tool === 'dot' ? 'dot' : tool === 'arrow-cursor' ? 'arrow' : 'cross');
  // Swing pivots drive the Magic and Demonstration cursor tools.
  const swingPivots = (list) => {
    const k = 2;
    const out = [];
    for (let i = k; i < list.length - k; i += 1) {
      const h = list[i].h, l = list[i].l;
      let isH = true, isL = true;
      for (let j = 1; j <= k; j += 1) {
        if (h <= list[i - j].h || h <= list[i + j].h) isH = false;
        if (l >= list[i - j].l || l >= list[i + j].l) isL = false;
      }
      if (isH) out.push({ t: list[i].t, p: h, kind: 'high' });
      if (isL) out.push({ t: list[i].t, p: l, kind: 'low' });
    }
    return out.sort((a, b) => a.t - b.t);
  };
  const setTool = (tool) => {
    v.set({ tool });
    pending = null;
    syncRail();
    syncTextPicker();
  };
  // Single arming path: remember the variant per group (toolbar-slot memory)
  // then arm it. Cursor/mode ids that belong to no variant group skip memory.
  const armTool = (tool) => {
    const g = groupOf(tool);
    if (g) groupCurrent[g] = tool;
    setTool(tool);
  };
  if (overlay) {
    let dragging = false;
    let startX = 0, startY = 0;
    let startVis = null, startPrice = null;
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
      // Alert drag takes priority over pan/draw (disabled while locked).
      const hitA = alertAtY(my, st, geom);
      if (hitA && !st.locked) {
        pushHistory();
        dragAlertId = hitA.id;
        v.set({ selectedId: hitA.id });
        return;
      }
      const tool = st.tool || 'cross';
      // Cursors menu: three of the six entries act on click rather than place.
      if (tool === 'eraser') {
        const hit = hitTestDrawing(st.drawings, st, geom, rows, mx, my, 10);
        if (hit) {
          if ((st.locked || st.lockedDrawings) && !st.removeLocked) { showToast('Drawings are locked', { label: 'Unlock', onAction: () => toggleLock() }); return; }
          pushHistory();
          v.set({ drawings: st.drawings.filter((d) => d.id !== hit.id), selectedId: null });
          saveLayout();
          showToast('Drawing erased');
        } else showToast('Nothing under the cursor');
        return;
      }
      if (tool === 'magic' || tool === 'demonstration') {
        const pivots = swingPivots(visibleRows(rows, st.visible).length ? visibleRows(rows, st.visible) : rows);
        if (pivots.length < 2) { showToast('No swing points detected yet'); return; }
        if (st.locked || st.lockedDrawings) { showToast('Drawings are locked', { label: 'Unlock', onAction: () => toggleLock() }); return; }
        if (tool === 'magic') {
          const [a, b] = pivots.slice(-2);
          pushHistory();
          const d = makeDrawing('trend', [{ t: a.t, p: a.p }, { t: b.t, p: b.p }], { kind: 'segment' });
          addDrawing(v, d);
          v.set({ selectedId: d.id });
          saveLayout();
          showToast('Trend line drawn between the last two swings');
        } else {
          demoStep = (demoStep + 1) % Math.max(1, pivots.length - 1);
          const a = pivots[demoStep];
          const b = pivots[demoStep + 1] || pivots[demoStep];
          pushHistory();
          const d = makeDrawing('trend', [{ t: a.t, p: a.p }, { t: b.t, p: b.p }], { kind: 'segment' });
          addDrawing(v, d);
          v.set({ selectedId: d.id });
          saveLayout();
          showToast(`Demonstration ${demoStep + 1}/${pivots.length - 1} — click again to advance`);
        }
        return;
      }
      if (tool === 'measure') {
        // Measure marquee: drag to read out Δbars / Δprice / Δ%.
        measureStart = { mx, my };
        return;
      }
      if (ITEMS[tool]?.kind === 'brush') {
        if (st.locked) { showToast('Drawings are locked', { label: 'Unlock', onAction: () => toggleLock() }); return; }
        pushHistory();
        brushPath = [{ t: cursorPoint(mx, geom, st).t, p: maybeSnap(pForY(my, st.price, geom.top, geom.height), geom, st) }];
        brushDrawingId = null;
        brushTool = tool;
        return;
      }
      if (DRAW_TOOLS.has(tool)) {
        if (st.lockedDrawings || st.locked) { showToast('Drawings are locked', { label: 'Unlock', onAction: () => toggleLock() }); return; }
        const spec = ITEMS[tool] || {};
        const { t, p } = cursorPoint(mx, geom, st, my);
        // Multi-click tools accumulate anchors until the tool is complete.
        const need = anchorCount(tool);
        if (need > 1) {
          const pts = (pending && pending.type === tool ? pending.points : []).concat([{ t, p }]);
          if (pts.length < need) {
            pending = { type: tool, points: pts };
            showToast(`Anchor ${pts.length}/${need} — click to set the next point`);
            return;
          }
          if (spec.kind === 'brush') return;
          pushHistory();
          const d = makeDrawing(tool, pts, drawingExtras(spec));
          addDrawing(v, d);
          v.set({ selectedId: d.id });
          pending = null;
          saveLayout();
          if (!stayMode) setTool('cross');
          return;
        }
        pushHistory();
        const extras = drawingExtras(spec);
        // An emoji chosen from the Icons picker already carries its own glyph
        // (and size scale) — no caption prompt involved.
        if (extras.cancel && pending && pending.type === tool && pending.glyph) delete extras.cancel;
        if (pending && pending.type === tool && pending.glyph) extras.text = pending.glyph;
        if (pending && pending.type === tool && Number.isFinite(pending.scale)) {
          extras.iconScale = Math.min(10, Math.max(1, Math.round(pending.scale)));
        }
        // Text-tool style from the text picker (size/color/opacity).
        if (tool === 'text') {
          if (textScale > 1) extras.size = Math.round(TEXT_BASE * textScale);
          if (textColor) extras.color = textColor;
          if (textOpacity < 1) extras.opacity = textOpacity;
        }
        if (extras.cancel) { pending = null; if (!stayMode) setTool('cross'); return; }
        const d = makeDrawing(tool, [{ t, p }], extras);
        addDrawing(v, d);
        v.set({ selectedId: d.id });
        pending = null;
        saveLayout();
        if (!stayMode) setTool('cross');
        return;
      }
      // Cross tool: select an existing drawing (anchor first, then body) and
      // allow dragging it. Anchor drags move one point; body drags move all.
      if (!st.locked && !st.drawingsHidden) {
        const anchorIdx = hitTestAnchor(st.drawings, st, geom, rows, mx, my, 8);
        if (anchorIdx >= 0) {
          pushHistory();
          dragDrawingId = st.selectedId;
          dragAnchorIdx = anchorIdx;
          return;
        }
        const hit = hitTestDrawing(st.drawings, st, geom, rows, mx, my, 6);
        if (hit) {
          pushHistory();
          dragDrawingId = hit.id;
          dragAnchorIdx = -1;
          dragStartPoint = cursorPoint(mx, geom, st, my);
          // Snapshot the original points: each mousemove translates this
          // snapshot, so the delta can't re-accumulate across events.
          dragOrigin = { id: hit.id, points: hit.points.map(p => ({ t: p.t, p: p.p })) };
          v.set({ selectedId: hit.id });
          return;
        }
        if (st.selectedId) v.set({ selectedId: null });
      }
      dragging = true; startX = e.clientX; startY = e.clientY;
      const s = v.get(); startVis = s.visible ? { ...s.visible } : null;
      startPrice = s.price ? { ...s.price } : null;
    });
    overlay.addEventListener('mouseup', (e) => {
      if (measureStart) {
        const st = v.get();
        const geom = geomFor();
        const r = overlay.getBoundingClientRect();
        const mx = (e.clientX - r.left) * (overlay.width / Math.max(1, r.width));
        const my = (e.clientY - r.top) * (overlay.height / Math.max(1, r.height));
        const pA = pForY(Math.min(measureStart.my, my), st.price, geom.top, geom.height);
        const pB = pForY(Math.max(measureStart.my, my), st.price, geom.top, geom.height);
        const dp = Math.abs(pA - pB), base = Math.min(pA, pB);
        const x0 = Math.min(measureStart.mx, mx), x1 = Math.max(measureStart.mx, mx);
        const tA = tForX(x0, st.visible, geom.left, geom.width), tB = tForX(x1, st.visible, geom.left, geom.width);
        const slice = visibleRows(rows, st.visible);
        const barMs = slice.length > 1 ? (st.visible.to - st.visible.from) / slice.length : 1;
        const bars = Math.max(1, Math.round(Math.abs(tB - tA) / Math.max(1, barMs)));
        showToast(`${bars} bars · ${dp >= 100 ? dp.toFixed(0) : dp.toFixed(2)} (${base > 0 ? (dp / base * 100).toFixed(2) : '0.00'}%)`);
        measureStart = null;
      }
    });
    window.addEventListener('mouseup', () => {
      if (brushPath) {
        // Freehand committed; stay mode keeps the brush for the next stroke.
        if (brushDrawingId && brushPath.length >= 2) saveLayout();
        brushPath = null; brushDrawingId = null;
      }
      if (dragDrawingId) saveLayout();
      dragDrawingId = null; dragAnchorIdx = -1; dragStartPoint = null; dragOrigin = null;
      dragging = false; startVis = null; dragAlertId = null;
    });
    overlay.addEventListener('mousemove', (e) => {
      const st = v.get();
      if (!rows.length || !st.visible || !st.price) return;
      const geom = geomFor();
      const { mx, my } = toCanvas(e);
      if (brushPath) {
        // Freehand: append points, commit on mouseup.
        const q = cursorPoint(mx, geom, st, my);
        const last = brushPath[brushPath.length - 1];
        if (!last || Math.hypot(q.t - last.t, q.p - last.p) > 1e-9) brushPath.push(q);
        const next = brushDrawingId
          ? v.get().drawings.map(d => (d.id === brushDrawingId ? { ...d, points: brushPath.slice() } : d))
          : [...v.get().drawings, makeDrawing(brushTool, brushPath.slice(), { kind: 'brush', variant: ITEMS[brushTool]?.variant })];
        if (!brushDrawingId) brushDrawingId = next[next.length - 1].id;
        v.set({ drawings: next, selectedId: brushDrawingId });
        return;
      }
      if (dragDrawingId) {
        const target = v.get().drawings.find(d => d.id === dragDrawingId);
        if (!target) return;
        if (dragAnchorIdx >= 0) {
          // Single anchor edit: the anchor follows the pointer (magnet applies).
          const q = cursorPoint(mx, geom, st, my);
          v.set({ drawings: v.get().drawings.map(d => (d.id === dragDrawingId ? moveAnchor(d, dragAnchorIdx, q) : d)) });
        } else if (dragOrigin) {
          // Whole-body move: translate the ORIGINAL snapshot by the total
          // pointer delta (never the already-moved state).
          const q = cursorPoint(mx, geom, st, my);
          const dt = q.t - dragStartPoint.t, dp = q.p - dragStartPoint.p;
          v.set({
            drawings: v.get().drawings.map(d => (
              d.id === dragOrigin.id ? { ...d, points: dragOrigin.points.map(pp => ({ t: pp.t == null ? null : pp.t + dt, p: pp.p + dp })) } : d
            )),
          });
        }
        return;
      }
      if (dragAlertId) {
        const p = pForY(my, st.price, geom.top, geom.height);
        v.set({ alerts: (st.alerts || []).map(a => a.id === dragAlertId ? { ...a, price: p } : a) });
        saveLayout();
        return;
      }
      if (dragging && startVis) {
        const rect = overlay.getBoundingClientRect();
        const dx = (e.clientX - startX) * (geom.width / Math.max(1, rect.width));
        const span = startVis.to - startVis.from;
        const dt = dx * span / Math.max(1, geom.width);
        const patch = { visible: { from: startVis.from - dt, to: startVis.to - dt } };
        // Vertical drag pans price too (content follows the cursor); any
        // real vertical move is a manual scale adjustment (auto off).
        const dyCss = e.clientY - startY;
        if (startPrice && Math.abs(dyCss) > 4) {
          const pSpan = startPrice.max - startPrice.min;
          const dPrice = dyCss * pSpan / Math.max(1, rect.height);
          patch.price = { min: startPrice.min - dPrice, max: startPrice.max - dPrice };
          patch.priceAuto = false;
        }
        v.set(patch);
        if (patch.priceAuto === false) { saveLayout(); syncScaleTip(); }
        refitPriceToVisible();
        return;
      }
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      if (!st.drawingsHidden) drawDrawings(ctx, st.drawings, st, geom, rows);
      drawAlerts(ctx, st.alerts, st, geom);
      // Measure marquee: dashed rect + Δbars / Δprice / Δ% readout while dragging.
      if (measureStart) {
        const x0 = Math.min(measureStart.mx, mx), x1 = Math.max(measureStart.mx, mx);
        const y0 = Math.min(measureStart.my, my), y1 = Math.max(measureStart.my, my);
        ctx.save();
        ctx.strokeStyle = '#2962FF'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.strokeRect(x0, geom.top, Math.max(1, x1 - x0), geom.height);
        ctx.setLineDash([]);
        const pA = pForY(y0, st.price, geom.top, geom.height), pB = pForY(y1, st.price, geom.top, geom.height);
        const dp = Math.abs(pA - pB), base = Math.min(pA, pB);
        const tA = tForX(x0, st.visible, geom.left, geom.width), tB = tForX(x1, st.visible, geom.left, geom.width);
        const slice = visibleRows(rows, st.visible);
        const barMs = slice.length > 1 ? (st.visible.to - st.visible.from) / slice.length : 1;
        const bars = Math.max(1, Math.round(Math.abs(tB - tA) / Math.max(1, barMs)));
        const label = `${bars} bars · ${dp >= 100 ? dp.toFixed(0) : dp.toFixed(2)} (${base > 0 ? (dp / base * 100).toFixed(2) : '0.00'}%)`;
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
        const w = ctx.measureText ? ctx.measureText(label).width + 12 : 120;
        ctx.fillStyle = 'rgba(41,98,255,0.9)';
        const bx = Math.min(x1 + 6, geom.left + geom.width - w), by = Math.max(geom.top + 4, y0 - 10);
        ctx.fillRect(bx, by, w, 18);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, bx + 6, by + 13);
        ctx.restore();
        const pal = PAL[st.theme] || PAL.light;
        drawCrosshair(ctx, mx, my, geom, pal, cursorShape(st.tool));
        return;
      }
      // Pending rubber-band: anchor dot + dashed preview to cursor while a
      // 2-click anchor is set (non-destructive; renderAll clears it).
      if (pending && pending.points && pending.points.length) {
        try { drawPending(ctx, pending, { x: mx, y: my }, st, geom, rows); } catch {}
      }
      const pal = PAL[st.theme] || PAL.light;
      drawCrosshair(ctx, mx, my, geom, pal, cursorShape(st.tool));
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
      if (!st.drawingsHidden) drawDrawings(ctx, st.drawings, st, geomFor(), rows);
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
        v.set({ price: { min: nMin, max: nMin + nSpan }, priceAuto: false });
        saveLayout(); syncScaleTip();
      } else {
        const span = st.visible.to - st.visible.from;
        if (span <= 0) return;
        const fx = (mx - geom.left) / Math.max(1, geom.width);
        const tCur = st.visible.from + fx * span;
        const nSpan = span * factor;
        v.set({ visible: { from: tCur - fx * nSpan, to: tCur - fx * nSpan + nSpan } });
        refitPriceToVisible();
      }
    }, { passive: false });
    overlay.addEventListener('dblclick', () => {
      if (fullVisible && fullPrice) {
        v.set({ visible: { ...fullVisible }, price: { ...fullPrice }, priceAuto: true });
        saveLayout(); syncScaleTip();
      }
    });
  }
  // Price axis is live like the original: vertical drag rescales (pans the
  // price range, content follows the cursor), wheel zooms price around the
  // cursor, double-click autofits price to the visible bars. A press without
  // drag still places an alert (click), preserving the existing behavior.
  if (priceAxis && !priceAxis.dataset.axisBound) {
    priceAxis.dataset.axisBound = '1';
    priceAxis.style.cursor = 'ns-resize';
    let pDrag = null;
    const priceAt = (clientY) => {
      const st = v.get();
      const rect = priceAxis.getBoundingClientRect();
      const fy = (clientY - rect.top) / Math.max(1, rect.height);
      return st.price.min + (1 - fy) * (st.price.max - st.price.min);
    };
    priceAxis.addEventListener('mousedown', (e) => {
      const st = v.get();
      if (!rows.length || !st.visible || !st.price) return;
      e.preventDefault();
      pDrag = { startY: e.clientY, min: st.price.min, max: st.price.max, moved: false };
    });
    window.addEventListener('mousemove', (e) => {
      if (!pDrag) return;
      const dy = e.clientY - pDrag.startY;
      if (Math.abs(dy) > 4) pDrag.moved = true;
      if (!pDrag.moved) return;
      const rect = priceAxis.getBoundingClientRect();
      const dPrice = dy * (pDrag.max - pDrag.min) / Math.max(1, rect.height);
      v.set({ price: { min: pDrag.min - dPrice, max: pDrag.max - dPrice }, priceAuto: false });
      saveLayout(); syncScaleTip();
    });
    window.addEventListener('mouseup', () => {
      if (!pDrag) return;
      const wasClick = !pDrag.moved;
      const y = pDrag.startY;
      pDrag = null;
      if (!wasClick) return;
      const st = v.get();
      if (st.locked) { showToast('Drawings are locked', { label: 'Unlock', onAction: () => toggleLock() }); return; }
      if (!rows.length || !st.visible || !st.price) return;
      const p = priceAt(y);
      pushHistory();
      const cur = v.get().alerts || [];
      const id = 'a' + Date.now();
      v.set({ alerts: [...cur, { id, price: p }], selectedId: id });
      saveLayout();
    });
    priceAxis.addEventListener('wheel', (e) => {
      e.preventDefault();
      const st = v.get();
      if (!rows.length || !st.visible || !st.price) return;
      const span = st.price.max - st.price.min;
      if (span <= 0) return;
      const factor = e.deltaY < 0 ? 0.9 : 1.1;
      const rect = priceAxis.getBoundingClientRect();
      const fy = (e.clientY - rect.top) / Math.max(1, rect.height);
      const pCur = st.price.min + (1 - fy) * span;
      const nSpan = span * factor;
      const nMin = pCur - (1 - fy) * nSpan;
      v.set({ price: { min: nMin, max: nMin + nSpan }, priceAuto: false });
      saveLayout(); syncScaleTip();
    }, { passive: false });
    priceAxis.addEventListener('dblclick', () => {
      if (!rows.length) return;
      const sliced = visibleRows(rows, v.get().visible);
      const sc = scaleFor(sliced.length ? sliced : rows);
      if (sc) v.set({ price: sc.price, priceAuto: true });
      saveLayout(); syncScaleTip();
    });
  }
  // Time axis is live like the original: horizontal drag pans time (content
  // follows the cursor), wheel zooms time around the cursor, double-click
  // jumps back to the full range.
  if (timeAxis && !timeAxis.dataset.axisBound) {
    timeAxis.dataset.axisBound = '1';
    timeAxis.style.cursor = 'ew-resize';
    let tDrag = null;
    timeAxis.addEventListener('mousedown', (e) => {
      const st = v.get();
      if (!rows.length || !st.visible) return;
      e.preventDefault();
      tDrag = { startX: e.clientX, from: st.visible.from, to: st.visible.to, moved: false };
    });
    window.addEventListener('mousemove', (e) => {
      if (!tDrag) return;
      const dx = e.clientX - tDrag.startX;
      if (Math.abs(dx) > 4) tDrag.moved = true;
      if (!tDrag.moved) return;
      const rect = timeAxis.getBoundingClientRect();
      const span = tDrag.to - tDrag.from;
      const dt = dx * span / Math.max(1, rect.width);
      v.set({ visible: { from: tDrag.from - dt, to: tDrag.to - dt } });
      refitPriceToVisible();
    });
    window.addEventListener('mouseup', () => { tDrag = null; });
    timeAxis.addEventListener('wheel', (e) => {
      e.preventDefault();
      const st = v.get();
      if (!rows.length || !st.visible) return;
      const span = st.visible.to - st.visible.from;
      if (span <= 0) return;
      const factor = e.deltaY < 0 ? 0.9 : 1.1;
      const rect = timeAxis.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / Math.max(1, rect.width);
      const tCur = st.visible.from + fx * span;
      const nSpan = span * factor;
      v.set({ visible: { from: tCur - fx * nSpan, to: tCur - fx * nSpan + nSpan } });
      refitPriceToVisible();
    }, { passive: false });
    timeAxis.addEventListener('dblclick', () => {
      if (fullVisible) v.set({ visible: { ...fullVisible } });
      refitPriceToVisible();
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
        refitPriceToVisible();
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
  // Symbol input accepts plain pairs (BTCUSD, BTC/USD) and TV-style
  // exchange-qualified forms (BITSTAMP:BTCUSD) — see js/url.js.
  const resetScale = () => {
    if (!rows.length) return;
    let mn = Infinity, mx = -Infinity;
    for (const r of rows) { if (r.l < mn) mn = r.l; if (r.h > mx) mx = r.h; }
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) return;
    if (!(mx > mn)) { mn -= 1; mx += 1; }
    const visible = { from: rows[0].t, to: rows[rows.length - 1].t };
    const price = priceBounds(mn, mx);
    if (!price) return;
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
      // Interval is committed here (not after) so startStream below
      // subscribes to the market+interval that was actually loaded — the
      // callers set it again afterwards, harmlessly.
      const patch = { symbol, interval: ccxtTf };
      if (nextTf) patch.timeframe = nextTf;
      v.set(patch);
      saveLayout();
      updateSymbolHead();
      startStream();
      return true;
    } catch (e) {
      showToast(`Live data unavailable — keeping ${v.get().symbol || 'current chart'}`);
      stopStream();
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
      const s = v.get();
      if (s.locked || s.lockedIndicators) { showToast('Indicators are locked', { label: 'Unlock', onAction: () => toggleLock() }); return; }
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
          // Same resolver the renderer uses: palette advances per instance of
          // this study, so a mesh shows distinct colors here too.
          try {
            const ord = instances().filter((x) => x.id === inst.id).findIndex((x) => x.uid === inst.uid);
            shown = autoColor(inst.id, ord < 0 ? 0 : ord, 0);
          } catch { shown = '#2962FF'; }
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
  // Alerts dialog: list price alerts with per-alert remove + clear-all.
  // Placement stays on the price-axis click; this dialog manages them.
  if (!document.querySelector('#alert-dialog')) {
    const dlg = document.createElement('dialog');
    dlg.id = 'alert-dialog';
    dlg.innerHTML = '<form method="dialog" style="display:flex;flex-direction:column;gap:8px;font:13px sans-serif;min-width:260px">'
      + '<strong>Price alerts</strong><div id="alert-list" style="display:flex;flex-direction:column;gap:4px;max-height:40vh;overflow:auto"></div>'
      + '<div style="color:#787b86;font-size:12px">Tip: click the price axis to place an alert at that price.</div>'
      + '<div style="display:flex;gap:8px"><button id="alert-clear" type="button">Clear all</button><button value="close">Close</button></div></form>';
    document.body.appendChild(dlg);
    const renderAlerts = () => {
      const host = dlg.querySelector('#alert-list');
      host.innerHTML = '';
      const alerts = v.get().alerts || [];
      if (!alerts.length) {
        const em = document.createElement('div');
        em.style.color = '#787b86';
        em.textContent = 'No alerts yet.';
        host.appendChild(em);
      }
      for (const a of alerts) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center';
        const lb = document.createElement('span');
        lb.style.flex = '1';
        lb.textContent = Number(a.price).toLocaleString('en-US', { maximumFractionDigits: 2 });
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.textContent = '✕';
        rm.setAttribute('aria-label', 'Remove alert');
        rm.addEventListener('click', (ev) => {
          ev.preventDefault();
          if (v.get().locked) { showToast('Drawings are locked', { label: 'Unlock', onAction: () => toggleLock() }); return; }
          pushHistory();
          v.set({ alerts: (v.get().alerts || []).filter(x => x.id !== a.id), selectedId: null });
          saveLayout();
          renderAlerts();
        });
        row.append(lb, rm);
        host.appendChild(row);
      }
    };
    dlg.querySelector('#alert-clear').addEventListener('click', (ev) => {
      ev.preventDefault();
      if (v.get().locked) { showToast('Drawings are locked', { label: 'Unlock', onAction: () => toggleLock() }); return; }
      if (!(v.get().alerts || []).length) return;
      pushHistory();
      v.set({ alerts: [], selectedId: null });
      saveLayout();
      renderAlerts();
    });
      dlg.querySelector('button[value="close"]').addEventListener('click', () => {
        try { dlg.close(); } catch { dlg.removeAttribute('open'); }
      });
    document.querySelector('#alert-btn')?.addEventListener('click', () => {
      renderAlerts();
      if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
      else dlg.setAttribute('open', '');
    });
  }
  // App menu (topbar ☰ + rail ⋯ overflow) + About dialog.
  function closeMenu() { try { document.querySelector('#app-menu')?.remove(); } catch {} }
  const openAbout = () => {
    let dlg = document.querySelector('#about-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'about-dialog';
      dlg.innerHTML = '<form method="dialog" style="display:flex;flex-direction:column;gap:8px;font:13px sans-serif;max-width:320px">'
        + '<strong>About Opentape</strong>'
        + '<div>Opentape is a clean-room vanilla HTML/JS/CSS chart terminal. Live public crypto data via CCXT; drawings, 85 studies, replay and layouts included.</div>'
        + '<div><button value="close">Close</button></div></form>';
      document.body.appendChild(dlg);
      dlg.querySelector('button[value="close"]').addEventListener('click', () => {
        try { dlg.close(); } catch { dlg.removeAttribute('open'); }
      });
    }
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
  };
  const openMenu = (anchor) => {
    closeMenu();
    const menu = document.createElement('div');
    menu.id = 'app-menu';
    const items = [
      ['Reset view', () => { if (fullVisible && fullPrice) v.set({ visible: { ...fullVisible }, price: { ...fullPrice } }); }],
      ['Clear drawings', () => {
        if (v.get().locked) { showToast('Drawings are locked', { label: 'Unlock', onAction: () => toggleLock() }); return; }
        if (!v.get().drawings.length) return;
        pushHistory();
        v.set({ drawings: [], selectedId: null });
        saveLayout();
      }],
      ['Toggle theme', () => v.toggleTheme()],
      ['Export PNG', () => exportPNG()],
      ['About', () => openAbout()],
    ];
    for (const [label, fn] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => { closeMenu(); fn(); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchor?.getBoundingClientRect?.() || { left: 8, bottom: 48 };
    menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 190)) + 'px';
    menu.style.top = Math.max(4, (r.bottom || 48) + 4) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function off(e) {
      if (!menu.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', off); }
    }), 0);
  };
  // Rail flyouts: the chevron on a group icon opens its tool menu, the way the
  // original sidebar does. Menus mirror the captured structure — section
  // headers, keyboard shortcuts on the right, switches at the bottom.
  function closeToolMenu() { try { document.querySelector('#tool-menu')?.remove(); } catch {} try { document.querySelectorAll('.rail-item.open').forEach((x) => x.classList.remove('open')); } catch {} }
  let toolMenuOpen = false;

  // Switches persist in ViewState + layout so they survive reload; the menu
  // reflects the stored value on open.
  const menuState = {
    snapIndicators: !!v.get().snapIndicators,
    valuesTooltip: !!v.get().valuesTooltip,
    removeLocked: !!v.get().removeLocked,
  };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const itemLabel = (item) => {
    if (!item.dynamic) return item.label;
    const s = v.get();
    const nD = (s.drawings || []).length;
    const nS = (s.studies || []).length;
    // Templates use %d (drawings) and %i (indicators); %n is the legacy alias
    // for the drawings count seen in older captures — expand it too so no
    // literal placeholder ever reaches the menu.
    return item.dynamic
      .replace(/%d|%n/g, plural(nD, 'drawing'))
      .replace('%i', plural(nS, 'indicator'));
  };

  const openToolMenu = (groupId, anchorBtn) => {
    const group = RAIL_GROUPS[groupId];
    if (!group) return;
    const existing = document.querySelector('#tool-menu');
    if (existing && existing.dataset.group === groupId) { closeToolMenu(); toolMenuOpen = false; return; }
    closeToolMenu();
    const menu = document.createElement('div');
    menu.id = 'tool-menu';
    menu.dataset.group = groupId;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', group.label);
    const head = document.createElement('div');
    head.className = 'tool-menu-head';
    head.textContent = group.label;
    menu.appendChild(head);

    const current = v.get().tool;
    for (const sec of group.sections) {
      if (!sec.items.length) continue;
      if (sec.title) {
        const h = document.createElement('div');
        h.className = 'tool-menu-sec';
        h.textContent = sec.title;
        menu.appendChild(h);
      }
      for (const item of sec.items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.item = item.id;
        b.setAttribute('role', 'menuitem');
        const isToggle = !!item.toggle;
        if (isToggle) {
          const on = menuState[item.toggle];
          b.classList.toggle('on', !!on);
          b.setAttribute('aria-pressed', String(!!on));
          b.innerHTML = `<span>${item.label}</span><span class="tool-menu-switch" aria-hidden="true"><i></i></span>`;
        } else {
          b.innerHTML = `<span class="tool-menu-icon">${iconSvg(railIconFor(item.id))}</span><span class="tool-menu-label">${itemLabel(item)}</span>`
            + (item.hotkey ? `<span class="tool-menu-hot">${item.hotkey}</span>` : '');
          if (item.id === current) b.classList.add('current');
        }
        b.addEventListener('click', () => {
          if (isToggle) {
            menuState[item.toggle] = !menuState[item.toggle];
            v.set({ [item.toggle]: menuState[item.toggle] });
            b.classList.toggle('on', menuState[item.toggle]);
            b.setAttribute('aria-pressed', String(menuState[item.toggle]));
            saveLayout();
            showToast(`${item.label} — ${menuState[item.toggle] ? 'on' : 'off'}`);
            return;
          }
          if (item.action && ACTIONS[item.action]) {
            closeToolMenu(); toolMenuOpen = false;
            ACTIONS[item.action]();
            return;
          }
          closeToolMenu(); toolMenuOpen = false;
          pending = null;
          armTool(item.id);
          const need = anchorCount(item.id);
          showToast(need > 1
            ? `${item.label} — click ${need} points on the chart`
            : `${item.label} — click the chart to place`);
        });
        menu.appendChild(b);
      }
    }
    document.body.appendChild(menu);
    const r = anchorBtn?.getBoundingClientRect?.() || { left: 48, top: 80 };
    const h = menu.offsetHeight || 300;
    menu.style.left = ((r.right || 48) + 2) + 'px';
    menu.style.top = Math.max(4, Math.min((r.top || 80), (window.innerHeight || 900) - h - 8)) + 'px';
    toolMenuOpen = true;
    try { anchorBtn?.classList?.add('open'); } catch {}
    setTimeout(() => document.addEventListener('mousedown', function off(e) {
      // A row click or Escape closes the menu without an outside mousedown,
      // leaving this closer stale: without the isConnected guard it would eat
      // the next menu's first row mousedown (menu vanishes, click lost).
      if (!menu.isConnected) { document.removeEventListener('mousedown', off); return; }
      if (!menu.contains(e.target) && e.target !== anchorBtn && !anchorBtn?.contains?.(e.target)) {
        closeToolMenu(); toolMenuOpen = false; document.removeEventListener('mousedown', off);
      }
    }), 0);
  };
  // Small glyph for a tool inside a menu (reuse the rail art per family).
  const railIconFor = (toolId) => {
    const g = groupOf(toolId);
    return g ? (RAIL_GROUPS[g]?.icon || 'trend') : 'trend';
  };

  // Emoji / icon picker (the Icons group opens a grid, like the original).
  const EMOJI = ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿','👹','👺','🤡','💩','👻','💀','👽','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🙈','🙉','🙊','💋','💌','💘','💝','💖','💗','💓','💞','💕','💟','❣️','💔','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','⭐','🌟','✨','⚡','🔥','💥','💯','✅','❌','❓','❗','💤','🚀','🏆','🥇','🎯','🎉','🎊'];
  // Text-tool picker: size slider (1–100x of the base), indicator-style
  // color swatch + Auto (inherit), and opacity. Shown while the text tool is
  // armed; the choice rides onto each placed drawing (see placement above).
  function closeTextPicker() { try { document.querySelector('#text-size-picker')?.remove(); } catch {} }
  function syncTextPicker() {
    try {
      if ((v.get().tool || 'cross') === 'text') openTextPicker();
      else closeTextPicker();
    } catch {}
  }
  function openTextPicker() {
    if (document.querySelector('#text-size-picker')) return;
    closeToolMenu(); toolMenuOpen = false;
    const wrap = document.createElement('div');
    wrap.id = 'text-size-picker';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Text style');
    const preview = document.createElement('span');
    preview.className = 'emoji-size-preview';
    preview.textContent = 'Ag';
    const syncUI = () => {
      wrap.querySelector('[data-tval]').textContent = `${textScale}x`;
      wrap.querySelector('[data-toval]').textContent = `${Math.round(textOpacity * 100)}%`;
      const hex = wrap.querySelector('[data-thex]');
      if (hex) hex.textContent = textColor || 'Auto';
      preview.style.fontSize = `${Math.min(TEXT_BASE * textScale, 56)}px`;
      preview.style.color = textColor || '';
      preview.style.opacity = String(textOpacity);
    };
    const persist = () => {
      try {
        localStorage.setItem(TEXT_SCALE_KEY, String(textScale));
        if (textColor) localStorage.setItem(TEXT_COLOR_KEY, textColor);
        else localStorage.removeItem(TEXT_COLOR_KEY);
        localStorage.setItem(TEXT_OPACITY_KEY, String(textOpacity));
      } catch {}
    };
    const sizeRow = document.createElement('div');
    sizeRow.className = 'emoji-size';
    const sizeLabel = document.createElement('span');
    sizeLabel.textContent = 'Size';
    const sizeInput = document.createElement('input');
    sizeInput.type = 'range';
    sizeInput.min = '1';
    sizeInput.max = '100';
    sizeInput.step = '1';
    sizeInput.value = String(textScale);
    sizeInput.setAttribute('aria-label', 'Text size (1 to 100 times)');
    const sizeVal = document.createElement('span');
    sizeVal.className = 'emoji-size-val';
    sizeVal.dataset.tval = '1';
    sizeInput.addEventListener('input', () => {
      textScale = clampTextScale(sizeInput.value);
      persist();
      syncUI();
    });
    sizeRow.append(sizeLabel, sizeInput, sizeVal, preview);
    const colorRow = document.createElement('div');
    colorRow.className = 'emoji-size';
    const colorLabel = document.createElement('span');
    colorLabel.textContent = 'Color';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = textColor || '#d1d4dc';
    colorInput.setAttribute('aria-label', 'Text color');
    colorInput.addEventListener('input', () => {
      const hex = String(colorInput.value || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
        textColor = hex;
        persist();
        syncUI();
      }
    });
    const autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = 'text-auto';
    autoBtn.textContent = 'Auto';
    autoBtn.title = 'Inherit the drawing color';
    autoBtn.addEventListener('click', () => {
      textColor = null;
      persist();
      syncUI();
    });
    const hexVal = document.createElement('span');
    hexVal.className = 'emoji-size-val';
    hexVal.dataset.thex = '1';
    colorRow.append(colorLabel, colorInput, autoBtn, hexVal);
    const opRow = document.createElement('div');
    opRow.className = 'emoji-size';
    const opLabel = document.createElement('span');
    opLabel.textContent = 'Opacity';
    const opInput = document.createElement('input');
    opInput.type = 'range';
    opInput.min = '0';
    opInput.max = '100';
    opInput.step = '1';
    opInput.value = String(Math.round(textOpacity * 100));
    opInput.setAttribute('aria-label', 'Text opacity percent');
    const opVal = document.createElement('span');
    opVal.className = 'emoji-size-val';
    opVal.dataset.toval = '1';
    opInput.addEventListener('input', () => {
      const n = Number(opInput.value);
      textOpacity = Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 1;
      persist();
      syncUI();
    });
    opRow.append(opLabel, opInput, opVal);
    wrap.append(sizeRow, colorRow, opRow);
    document.body.appendChild(wrap);
    syncUI();
    const r = railBtns.get('text')?.getBoundingClientRect?.() || { left: 48, top: 300 };
    wrap.style.left = ((r.right || 48) + 2) + 'px';
    wrap.style.top = Math.max(4, r.top || 300) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function off(e) {
      if (!wrap.contains(e.target)) { wrap.remove(); document.removeEventListener('mousedown', off); }
    }), 0);
  }
  function openEmojiPicker() {
    closeToolMenu(); toolMenuOpen = false;
    document.querySelector('#emoji-picker')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'emoji-picker';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Icons');
    // Icon size: 1x–10x the base 18px glyph. Persists across sessions; the
    // picked emoji carries the scale onto its drawing record.
    const ICON_SCALE_KEY = 'opentape-icon-scale';
    const clampScale = (n) => Math.min(10, Math.max(1, Math.round(Number(n) || 1)));
    let iconScale = 1;
    try { iconScale = clampScale(localStorage.getItem(ICON_SCALE_KEY)); } catch {}
    const sizeRow = document.createElement('div');
    sizeRow.className = 'emoji-size';
    const sizeLabel = document.createElement('span');
    sizeLabel.textContent = 'Size';
    const sizeInput = document.createElement('input');
    sizeInput.type = 'range';
    sizeInput.min = '1';
    sizeInput.max = '10';
    sizeInput.step = '1';
    sizeInput.value = String(iconScale);
    sizeInput.setAttribute('aria-label', 'Icon size (1 to 10 times)');
    const sizeVal = document.createElement('span');
    sizeVal.className = 'emoji-size-val';
    const sizePreview = document.createElement('span');
    sizePreview.className = 'emoji-size-preview';
    sizePreview.textContent = '⭐';
    const syncSizeUI = () => {
      sizeVal.textContent = `${iconScale}x`;
      sizePreview.style.fontSize = `${Math.min(18 * iconScale, 56)}px`;
    };
    sizeInput.addEventListener('input', () => {
      iconScale = clampScale(sizeInput.value);
      try { localStorage.setItem(ICON_SCALE_KEY, String(iconScale)); } catch {}
      syncSizeUI();
    });
    syncSizeUI();
    sizeRow.append(sizeLabel, sizeInput, sizeVal, sizePreview);
    wrap.appendChild(sizeRow);
    const grid = document.createElement('div');
    grid.className = 'emoji-grid';
    for (const e of EMOJI) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.title = e;
      b.addEventListener('click', () => {
        wrap.remove();
        setTool('icon');
        pending = { type: 'icon', points: [], glyph: e, scale: iconScale };
        showToast(`Icon armed (${iconScale}x) — click the chart to place it`);
      });
      grid.appendChild(b);
    }
    wrap.appendChild(grid);
    document.body.appendChild(wrap);
    const r = railBtns.get('icons')?.getBoundingClientRect?.() || { left: 48, top: 300 };
    wrap.style.left = ((r.right || 48) + 2) + 'px';
    wrap.style.top = Math.max(4, r.top || 300) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function off(e) {
      if (!wrap.contains(e.target)) { wrap.remove(); document.removeEventListener('mousedown', off); }
    }), 0);
  }

  // Chevrons open the menus; hovering another group switches the open menu.
  document.querySelectorAll('#rail button[data-chevron]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openToolMenu(btn.dataset.chevron, btn.parentElement); });
    btn.addEventListener('mouseenter', () => { if (toolMenuOpen) openToolMenu(btn.dataset.chevron, btn.parentElement); });
  });
  document.querySelector('#menu')?.addEventListener('click', (e) => openMenu(e.currentTarget));
  document.querySelector('#topbar button[title="Premium"]')?.addEventListener('click', () => openAbout());
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
  // Symbol modal: exchange + pair fields with autosuggest dropdowns.
  // Exchange list comes from the CCXT bundle (verified venues first);
  // pair lists come from per-exchange loadMarkets(), cached per session.
  // Failures degrade gracefully: type anything, apply attempts reload and
  // keeps last good data + toast on failure (existing reload contract).
  const VERIFIED_EX = ['binance'];
  const marketsCache = new Map();
  // True when the CCXT browser bundle actually loaded (exchange classes
  // present). When false the modal falls back to a single exchange and pair
  // lists cannot load — the UI says so explicitly instead of looking broken.
  const ccxtBundleOk = () => {
    try {
      const cc = globalThis.ccxt;
      return !!cc && Object.keys(cc).some((k) => typeof cc[k] === 'function'
        && k === k.toLowerCase() && /^[a-z][a-z0-9_]*$/.test(k));
    } catch { return false; }
  };
  const getExchanges = () => {
    let all = [];
    try {
      const cc = globalThis.ccxt;
      if (cc && Array.isArray(cc.exchanges)) all = cc.exchanges;
      else if (cc) {
        // The browser bundle exposes exchanges as lowercase classes and has no
        // `exchanges` array: error classes are PascalCase, exchanges lowercase.
        all = Object.keys(cc).filter((k) => typeof cc[k] === 'function' && k === k.toLowerCase() && /^[a-z][a-z0-9_]*$/.test(k));
      }
    } catch {}
    const ids = all.length ? [...all] : ['binance'];
    ids.sort((a, b) => (VERIFIED_EX.includes(b) ? 1 : 0) - (VERIFIED_EX.includes(a) ? 1 : 0));
    return ids.map((id) => ({ id, verified: VERIFIED_EX.includes(id) }));
  };
  const getMarkets = async (ex) => {
    if (marketsCache.has(ex)) return marketsCache.get(ex);
    const Lib = globalThis.ccxt;
    if (!Lib || typeof Lib[ex] !== 'function') throw new Error('exchange unavailable');
    const m = new Lib[ex]({ enableRateLimit: true });
    await m.loadMarkets();
    const syms = Object.keys(m.markets || {}).filter((s) => s.includes('/')).sort();
    marketsCache.set(ex, syms);
    return syms;
  };
  // --- Exchange-grade tiers: source (SDK) -> venue -> instrument ---------------
  // Sources come from the companion `/api/sources` when reachable; otherwise a
  // static fallback serves the ccxt tier live while companion tiers render
  // disabled with their reason (dead transports are never silently clickable).
  const COMPANION_BASE = 'http://127.0.0.1:8788';
  const CCXT_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1M'];
  const ALL_INTERVALS = ['1m', '2m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '5d', '24h', '1w', '1wk', '1mo', '3mo', '1M'];
  const STATIC_SOURCES = [
    { id: 'ccxt', label: 'Crypto · CCXT', intervals: CCXT_INTERVALS, stream: { mode: 'live', note: 'WS where supported, else poll' }, transport: 'ccxt' },
    { id: 'yahoo', label: 'Stocks & Indices', intervals: ['1m', '5m', '15m', '30m', '1h', '1d', '1wk', '1mo'], stream: { mode: 'poll', cadence: 60, note: 'polls ~60s; intraday ≤60d' }, transport: 'companion' },
    { id: 'india', label: 'India (NSE/BSE)', intervals: ['1d', '1wk', '1mo'], stream: { mode: 'snapshot', note: 'EOD snapshot' }, transport: 'companion' },
    { id: 'dex', label: 'DEX pools', intervals: ['5m', '15m', '1h', '4h', '1d', '1w'], stream: { mode: 'poll', cadence: 60, note: 'polls ~60s' }, transport: 'companion' },
    { id: 'bitshares', label: 'BitShares', intervals: ['5m', '15m', '1h', '4h', '1d'], stream: { mode: 'poll', cadence: 15, note: 'polls ~15s' }, transport: 'companion' },
    { id: 'macro', label: 'Macro & Rates', intervals: ['1d', '1w', '1M'], stream: { mode: 'snapshot', note: 'daily snapshot' }, transport: 'companion' },
    { id: 'china', label: 'China (CN-A)', intervals: ['1d', '1wk', '1mo'], stream: { mode: 'snapshot', note: 'T+1 snapshot' }, transport: 'companion' },
  ];
  let companionSources = null;
  let companionDownReason = '';
  let companionDownUntil = 0;
  const fetchCompanionSources = async () => {
    if (companionSources) return companionSources;
    // Negative-cache a refused companion briefly so each modal open doesn't
    // re-log the same refused fetch (the browser reports refused fetches as
    // console resource errors; one probe per 30s is enough).
    if (Date.now() < companionDownUntil) return null;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => { try { ctl.abort(); } catch {} }, 2500);
      let res;
      try {
        res = await fetch(`${COMPANION_BASE}/api/sources`, { signal: ctl.signal });
      } finally {
        clearTimeout(t);
      }
      if (!res.ok) throw new Error(`companion ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error('bad companion source list');
      companionSources = body;
      companionDownReason = '';
    } catch (e) {
      companionDownReason = 'companion offline (127.0.0.1:8788 unreachable)';
      companionSources = null;
      companionDownUntil = Date.now() + 30000;
    }
    return companionSources;
  };
  const normSource = (s) => ({
    id: String(s.id || s.source || ''),
    label: String(s.label || s.id || s.source || ''),
    intervals: Array.isArray(s.intervals || s.INTERVALS) ? (s.intervals || s.INTERVALS).map(String) : CCXT_INTERVALS.slice(),
    stream: s.stream || s.STREAM || { mode: 'poll', cadence: 60 },
    venues: Array.isArray(s.venues) ? s.venues : [],
  });
  const allSources = () => {
    const out = [normSource(STATIC_SOURCES[0])];
    if (companionSources) {
      for (const s of companionSources) {
        const n = normSource(s || {});
        if (n.id && n.id !== 'ccxt') out.push(n);
      }
    } else {
      for (const s of STATIC_SOURCES.slice(1)) out.push(normSource(s));
    }
    return out;
  };
  const sourceById = (id) => allSources().find((s) => s.id === id) || null;
  const sourceTransportOk = (src) => {
    if (!src || !src.id) return { ok: false, reason: 'unknown source' };
    if (src.id === 'ccxt') {
      return ccxtBundleOk()
        ? { ok: true }
        : { ok: false, reason: 'market data library not loaded — check connection/adblocker' };
    }
    if (companionSources) return { ok: true };
    return { ok: false, reason: companionDownReason || 'companion offline' };
  };
  // Streaming-tip badge text from the source STREAM meta.
  const streamBadge = (stream) => {
    try {
      const m = String(stream?.mode || '').toLowerCase();
      if (m === 'live') return 'LIVE';
      if (m === 'poll') {
        const c = Number(stream?.cadence);
        return Number.isFinite(c) && c > 0 ? `~${c}s poll` : 'poll';
      }
      if (m === 'snapshot') return 'snapshot';
    } catch {}
    return 'poll';
  };
  // Recents: click applies, updated on every successful switch (max 8).
  const RECENTS_KEY = 'opentape-recents';
  const getRecents = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((r) => r && r.symbol).slice(0, 8) : [];
    } catch { return []; }
  };
  const pushRecent = (entry) => {
    try {
      const list = getRecents().filter((r) => !(
        String(r.symbol) === String(entry.symbol)
        && String(r.venue || '') === String(entry.venue || '')
        && String(r.source || '') === String(entry.source || '')
      ));
      list.unshift({ source: entry.source || 'ccxt', venue: entry.venue || '', symbol: entry.symbol, label: entry.label || entry.symbol, ts: Date.now() });
      localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 8)));
    } catch {}
  };
  // Companion candle normalization (contract shape: ascending {t,o,h,l,c,v}).
  const normCompanionRows = (input) => {
    const list = Array.isArray(input) ? input : (input && Array.isArray(input.candles) ? input.candles : []);
    return list
      .map((r) => (Array.isArray(r)
        ? { t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }
        : { t: +r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +(r.v ?? 0) }))
      .filter((r) => r && Number.isFinite(r.t) && Number.isFinite(r.o) && Number.isFinite(r.h)
        && Number.isFinite(r.l) && Number.isFinite(r.c) && r.h >= r.l)
      .map((r) => ({ ...r, v: Number.isFinite(r.v) ? r.v : 0 }))
      .sort((a, b) => a.t - b.t);
  };
  // Companion-aware apply path. Mirrors reload's post-load steps (scale via
  // resetScale, fitCanvases, saveLayout, updateSymbolHead) and reuses the
  // onStreamCandle stream flow through a companion poll at the source cadence.
  // On failure it toasts the reason and keeps last good data (no state change).
  const loadCompanion = async (source, venue, symbol, interval) => {
    // Probe tiers first so restored layouts (boot path, no modal open yet)
    // route against live sources instead of the static fallback.
    try { await fetchCompanionSources(); } catch {}
    const src = sourceById(source) || normSource({ id: source });
    const gate = sourceTransportOk(src);
    if (!gate.ok) {
      showToast(`Companion unavailable — keeping ${v.get().symbol || 'current chart'} (${gate.reason})`);
      return false;
    }
    const cadence = Number(src.stream?.cadence) > 0 ? Number(src.stream.cadence) : 60;
    const urlFor = (limit) => `${COMPANION_BASE}/api/candles?source=${encodeURIComponent(source)}`
      + `&venue=${encodeURIComponent(venue || '')}&symbol=${encodeURIComponent(symbol)}`
      + `&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    try {
      const res = await fetch(urlFor(300));
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.reason || body?.error || `companion ${res.status}`);
      const data = normCompanionRows(body.candles ?? body);
      if (!data.length) throw new Error('companion returned no rows');
      rows = data;
      resetScale();
      fitCanvases();
      const qualified = `${source}:${symbol}`;
      v.set({ symbol: qualified, interval, source, venue: venue || '' });
      saveLayout();
      updateSymbolHead();
      stopStream();
      stream = watchCandles({
        symbol: qualified,
        timeframe: interval,
        pollMs: Math.max(5000, cadence * 1000),
        createExchange: async () => ({}),
        pollOnce: async () => {
          const r2 = await fetch(urlFor(2));
          const b2 = await r2.json().catch(() => ({}));
          if (!r2.ok) throw new Error(b2?.reason || b2?.error || `companion ${r2.status}`);
          return normCompanionRows(b2.candles ?? b2);
        },
        onCandle: onStreamCandle,
        onStatus: (st, detail) => {
          if (st === 'live' || st === 'polling') { lastStreamTs = Date.now(); setStreamState('live'); }
          else { setStreamState('offline'); if (detail) console.warn('Stream offline', detail); }
        },
      });
      lastStreamTs = Date.now();
      setStreamState('live');
      pushRecent({ source, venue: venue || '', symbol: qualified, label: `${src.label} · ${symbol}` });
      return true;
    } catch (e) {
      showToast(`Live data unavailable — keeping ${v.get().symbol || 'current chart'} (${String(e?.message || e).slice(0, 90)})`);
      return false;
    }
  };
  const openSymbolModal = () => {
    let dlg = document.querySelector('#sym-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'sym-dialog';
      dlg.innerHTML = '<form method="dialog" style="display:flex;flex-direction:column;gap:8px;font:13px sans-serif;min-width:300px">'
        + '<div class="sym-head"><strong>Switch market</strong><button type="button" id="sym-x" aria-label="Close">✕</button></div>'
        + '<div id="sym-tabs" role="tablist" aria-label="Market views"></div>'
        + '<div id="sym-recents"></div>'
        + '<div id="sym-pane-markets" style="display:flex;flex-direction:column;gap:8px">'
        + '<div id="sym-source-tabs" role="tablist" aria-label="Sources"></div>'
        + '<div id="sym-source-note" style="color:#787b86;font-size:12px"></div>'
        + '<label>Exchange<input id="sym-ex-input" autocomplete="off" placeholder="binance"></label>'
        + '<div id="sym-ex-list" class="suggest sym-deep"></div>'
        + '<label>Pair<input id="sym-pair-input" autocomplete="off" placeholder="BTC/USDT"></label>'
        + '<div id="sym-pair-list" class="suggest sym-deep"></div>'
        + '<div id="sym-note" style="color:#787b86;font-size:12px"></div>'
        + '<label>Interval<select id="sym-interval"></select></label>'
        + '<div id="sym-stream-note" style="color:#787b86;font-size:12px"></div>'
        + '</div>'
        + '<div id="sym-pane-split" style="display:none;flex-direction:column;gap:8px">'
        + '<div id="sym-split-dir" style="display:flex;gap:4px"></div>'
        + '<div id="sym-split-cols"></div>'
        + '</div>'
        + '<div id="sym-pane-plot" style="display:none;flex-direction:column;gap:8px">'
        + '<canvas id="sym-plot" width="620" height="300"></canvas>'
        + '<div id="sym-plot-note" style="color:#787b86;font-size:12px"></div>'
        + '</div>'
        + '<div style="display:flex;gap:8px"><button id="sym-apply" type="button">Switch</button><button value="close">Close</button></div></form>';
      document.body.appendChild(dlg);
      const exInput = dlg.querySelector('#sym-ex-input');
      const pairInput = dlg.querySelector('#sym-pair-input');
      const exList = dlg.querySelector('#sym-ex-list');
      const pairList = dlg.querySelector('#sym-pair-list');
      const note = dlg.querySelector('#sym-note');
      const sourceTabs = dlg.querySelector('#sym-source-tabs');
      const sourceNote = dlg.querySelector('#sym-source-note');
      const intSel = dlg.querySelector('#sym-interval');
      const streamNote = dlg.querySelector('#sym-stream-note');
      const recentsHost = dlg.querySelector('#sym-recents');
      const tabHost = dlg.querySelector('#sym-tabs');
      const panes = {
        markets: dlg.querySelector('#sym-pane-markets'),
        split: dlg.querySelector('#sym-pane-split'),
        plot: dlg.querySelector('#sym-pane-plot'),
      };
      let curSource = 'ccxt';
      let curPairs = [];
      let pairReq = 0;
      let venueReq = 0;
      const splitDir = { mode: 'base' };
      let plotNodes = [];
      // 120ms-debounced char-by-char autofill (one timer per field so the two
      // inputs never cancel each other).
      const debounceEach = () => {
        let t = null;
        return (fn) => { clearTimeout(t); t = setTimeout(fn, 120); };
      };
      const debounceEx = debounceEach();
      const debouncePair = debounceEach();
      const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      // Match highlight for the autofill lists.
      const hiHtml = (text, q) => {
        const t = String(text ?? '');
        if (!q) return escHtml(t);
        const i = t.toUpperCase().indexOf(String(q).toUpperCase());
        if (i < 0) return escHtml(t);
        return escHtml(t.slice(0, i)) + '<mark>' + escHtml(t.slice(i, i + String(q).length)) + '</mark>' + escHtml(t.slice(i + String(q).length));
      };
      // Full scrollable pulldowns with counts + sticky section headers (no row
      // cap). Every row carries its streaming-tip badge; host.dataset.first
      // feeds Enter-applies-first.
      const renderList = (host, items, onPick, emptyText, opts = {}) => {
        host.innerHTML = '';
        host.dataset.first = '';
        const head = document.createElement('div');
        head.className = 'sym-count';
        head.textContent = `${opts.title || 'Results'} (${items.length})`;
        host.appendChild(head);
        if (!items.length) {
          const d = document.createElement('div');
          d.className = 'suggest-empty';
          d.textContent = emptyText;
          host.appendChild(d);
          return;
        }
        const badge = streamBadge((sourceById(curSource) || {}).stream);
        let first = '';
        for (const it of items) {
          const id = typeof it === 'string' ? it : it.id;
          if (!id) continue;
          if (!first) first = id;
          const label = typeof it === 'string' ? it : `${it.id}${it.verified ? ' ✓' : ''}${(it.name || it.label) ? ` — ${it.name || it.label}` : ''}`;
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.pick = id;
          const live = badge === 'LIVE';
          b.innerHTML = `<span class="sym-label">${hiHtml(label, opts.q || '')}</span>`
            + `<span class="sym-badge${live ? ' live' : ''}">${escHtml(opts.badge === false ? '' : badge)}</span>`;
          b.addEventListener('click', () => onPick(id));
          host.appendChild(b);
        }
        host.dataset.first = first;
      };
      const bundleWarn = (host) => {
        if (ccxtBundleOk()) return;
        const w = document.createElement('div');
        w.className = 'suggest-warn';
        w.textContent = 'Market data library not loaded — check connection/adblocker and reopen. Falling back to binance.';
        host.prepend(w);
      };
        // Degraded transports boil up with a pointer to the setup docs: a dead
        // tier is fixed by starting the companion or installing a pip lib, both
        // covered under ## Installation in the GitHub README.
        const INSTALL_URL = 'https://github.com/litepresence/opentape#installation';
        const installLink = () => {
          const a = document.createElement('a');
          a.className = 'sym-install-link';
          a.href = INSTALL_URL;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = 'Installation →';
          return a;
        };
      const renderSourceTabs = () => {
        sourceTabs.innerHTML = '';
        for (const src of allSources()) {
          const gate = sourceTransportOk(src);
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.source = src.id;
          b.className = 'sym-tab' + (src.id === curSource ? ' on' : '');
          b.disabled = !gate.ok;
          b.title = gate.ok ? `${src.label} · ${streamBadge(src.stream)}` : `${src.label} — ${gate.reason}`;
          const live = gate.ok && streamBadge(src.stream) === 'LIVE';
          b.innerHTML = `<span class="sym-tab-label">${escHtml(src.label)}</span>`
            + `<span class="sym-badge${live ? ' live' : ''}">${escHtml(gate.ok ? streamBadge(src.stream) : 'off')}</span>`
            + (gate.ok ? '' : `<span class="sym-reason">${escHtml(gate.reason)}</span>`);
          b.addEventListener('click', () => {
            // A new tier means a new venue namespace: drop the stale venue
            // filter so the venue list isn't pre-filtered to empty.
            if (curSource !== src.id) exInput.value = '';
            curSource = src.id;
            renderSourceTabs();
            renderIntervals();
            refreshVenues(true);
          });
          sourceTabs.appendChild(b);
        }
        const cur = sourceById(curSource);
        const gate = cur ? sourceTransportOk(cur) : { ok: false, reason: 'unknown source' };
        if (!cur) sourceNote.textContent = 'Unknown source.';
        else if (!gate.ok) {
          // Companion-routed tiers are fixed via setup (companion running +
          // pip libs); the CCXT tier is a connection/adblocker issue instead.
          sourceNote.textContent = `${cur.label} disabled — ${gate.reason} `;
          if (cur.id !== 'ccxt') sourceNote.appendChild(installLink());
        }
        else sourceNote.textContent = `${cur.label} · intervals: ${cur.intervals.join(', ')} · ${cur.stream?.note || streamBadge(cur.stream)}`;
      };
      // Per-source interval select: supported sizes selectable, the rest
      // rendered unselectable (disabled). Sources advertise their own sets
      // (moex 10m, yahoo 2m/5d/3mo, dex 6h/12h/24h, …), so anything outside
      // the canonical list is appended verbatim — otherwise a supported
      // size would be unselectable.
      const renderIntervals = () => {
        const cur = sourceById(curSource) || { intervals: CCXT_INTERVALS, stream: {} };
        const supported = new Set(cur.intervals);
        const want = v.get().interval || curInterval();
        intSel.innerHTML = '';
        let marked = false;
        const list = [...ALL_INTERVALS, ...cur.intervals.filter((x) => !ALL_INTERVALS.includes(x))];
        for (const iv of list) {
          const op = document.createElement('option');
          op.value = iv;
          op.textContent = iv;
          if (!supported.has(iv)) op.disabled = true;
          else if (!marked && iv === want) { op.selected = true; marked = true; }
          intSel.appendChild(op);
        }
        if (!supported.has(intSel.value)) {
          const firstOk = cur.intervals.find((x) => supported.has(x)) || cur.intervals[0];
          if (firstOk) intSel.value = firstOk;
        }
        streamNote.textContent = `Streaming: ${streamBadge(cur.stream)}${cur.stream?.note ? ` — ${cur.stream.note}` : ''}`;
      };
      const renderRecents = () => {
        const list = getRecents();
        recentsHost.innerHTML = '';
        if (!list.length) return;
        const title = document.createElement('div');
        title.className = 'sym-count';
        title.textContent = `Recent (${list.length})`;
        recentsHost.appendChild(title);
        const row = document.createElement('div');
        row.className = 'sym-recents-row';
        for (const r of list) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'sym-recent';
          b.title = `${r.source || 'ccxt'} · ${r.symbol}`;
          b.textContent = r.label || r.symbol;
          b.addEventListener('click', async () => {
            if ((r.source || 'ccxt') !== 'ccxt') {
              const raw = String(r.symbol).includes(':') ? String(r.symbol).split(':').slice(1).join(':') : String(r.symbol);
              const ok = await loadCompanion(r.source, r.venue || '', raw, v.get().interval || curInterval());
              if (ok) { renderRecents(); try { dlg.close(); } catch { dlg.removeAttribute('open'); } }
            } else {
              const venue = r.venue || 'binance';
              const m = String(r.symbol).includes(':') ? String(r.symbol) : `${venue}:${r.symbol}`;
              const ok = await reload(m, v.get().interval || curInterval());
              if (ok) {
                try { v.set({ source: 'ccxt', venue }); saveLayout(); } catch {}
                pushRecent(r);
                renderRecents();
                try { dlg.close(); } catch { dlg.removeAttribute('open'); }
              }
            }
          });
          row.appendChild(b);
        }
        recentsHost.appendChild(row);
      };
      const venueListFor = async (srcId) => {
        if (srcId === 'ccxt') return getExchanges().map((e) => ({ id: e.id, verified: e.verified }));
        const src = sourceById(srcId);
        return (src?.venues || []).map((x) => (typeof x === 'string' ? { id: x } : { id: String(x.id), label: x.label }));
      };
      const instrumentsFor = async (srcId, venue, query) => {
        if (srcId === 'ccxt') return getMarkets(venue);
        if (!companionSources) throw new Error(companionDownReason || 'companion offline');
        // The companion requires a non-empty q: the typed filter doubles as
        // the query, and the venue id seeds the initial (unfiltered) listing.
        const q = String(query || '').trim() || venue || 'a';
        const res = await fetch(`${COMPANION_BASE}/api/search?source=${encodeURIComponent(srcId)}&venue=${encodeURIComponent(venue)}&q=${encodeURIComponent(q)}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.reason || body?.error || `companion ${res.status}`);
        const list = Array.isArray(body) ? body : (body.results || body.symbols || []);
        // Objects keep the picked symbol clean while the row can still show
        // the venue's display name (renderList labels `id — name`).
        return list.map((r) => {
          if (typeof r === 'string') return r;
          const s = String(r.symbol || r.id || '');
          const nm = String(r.name || '');
          if (!s) return '';
          return (nm && !s.toUpperCase().includes(nm.toUpperCase())) ? { id: s, name: nm } : s;
        }).filter((x) => (typeof x === 'string' ? x : x && x.id));
      };
      const refreshVenues = async (resetPairs) => {
        const myReq = ++venueReq;
        const q = exInput.value.trim().toLowerCase();
        let venues = [];
        try {
          venues = await venueListFor(curSource);
        } catch { venues = []; }
        if (myReq !== venueReq) return;
        renderList(exList, venues.filter((e) => !q || e.id.toLowerCase().includes(q)), (id) => {
          exInput.value = id;
          // Companion lists are server-filtered per venue: drop the stale
          // pair filter (same rule as tab switches above) so the list isn't
          // pre-filtered to empty, then hand over the cursor for type-to-search.
          // CCXT filters locally, so its filter is kept as-is.
          if (curSource !== 'ccxt') pairInput.value = '';
          try { pairInput.focus(); } catch {}
          refreshPairs();
        }, curSource === 'ccxt' ? 'No exchanges match.' : 'No venues for this source.', { title: curSource === 'ccxt' ? 'Exchanges' : 'Venues', q });
        bundleWarn(exList);
        if (resetPairs) refreshPairs();
      };
      const refreshPairs = async () => {
        const myReq = ++pairReq;
        // CCXT venue ids are lowercase; companion venue ids keep their listed
        // case (e.g. STUB, CN-A) — lowercasing them breaks venue routing.
        const venue = curSource === 'ccxt'
          ? (exInput.value || 'binance').trim().toLowerCase()
          : (exInput.value || '').trim();
        note.textContent = 'Loading markets…';
        try {
          const inputQ = pairInput.value.trim();
          const syms = await instrumentsFor(curSource, venue, inputQ);
          if (myReq !== pairReq) return;
          curPairs = syms.map((s) => (typeof s === 'string' ? s : s.id)).filter(Boolean);
          note.textContent = `${syms.length} pairs`;
          // CCXT lists filter locally; companion results arrive pre-filtered
          // by the server query, so they render as returned (highlighted).
          const q = inputQ.toUpperCase();
          const list = curSource === 'ccxt'
            ? syms.filter((s) => {
              const id = typeof s === 'string' ? s : s.id;
              return !q || id.toUpperCase().includes(q);
            })
            : syms;
          renderList(pairList, list, (s) => {
            pairInput.value = s;
            pairList.dataset.first = s;
          }, !inputQ && curSource !== 'ccxt' ? `Type to search ${venue || 'these'} markets.` : 'No pairs match.', { title: 'Pairs', q: inputQ });
          renderSplit();
          drawPlot();
        } catch (e) {
          if (myReq !== pairReq) return;
          curPairs = [];
          const reason = String(e?.message || e || 'unknown error').slice(0, 90);
          note.textContent = curSource === 'ccxt'
            ? (ccxtBundleOk()
              ? `Could not load market list (${reason}) — you can still type a pair manually.`
              : 'Market data library not loaded — type the pair manually (e.g. BTC/USDT).')
            : `Instrument list unavailable (${reason}). `;
          if (curSource !== 'ccxt') note.appendChild(installLink());
          renderList(pairList, [], curSource === 'ccxt' ? '' : `Companion offline — ${reason}`, { title: 'Pairs' });
        }
      };
      // Base/quote split view: pick a base to list all its quotes (or flip to
      // quote → all its bases). Clicking an instrument applies the switch.
      const renderSplit = () => {
        const cols = dlg.querySelector('#sym-split-cols');
        const dirHost = dlg.querySelector('#sym-split-dir');
        if (!cols || !dirHost) return;
        dirHost.innerHTML = '';
        cols.innerHTML = '';
        // Keep the switch-tab row in sync even though renderSplit also runs
        // from background refreshes while another pane is visible.
        for (const mode of ['base', 'quote']) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'sym-tab' + (splitDir.mode === mode ? ' on' : '');
          b.textContent = mode === 'base' ? 'Base → quotes' : 'Quote → bases';
          b.addEventListener('click', () => { splitDir.mode = mode; renderSplit(); });
          dirHost.appendChild(b);
        }
        const leftMap = new Map();
        for (const s of curPairs) {
          const i = s.indexOf('/');
          if (i < 0) continue;
          const a = s.slice(0, i), bq = s.slice(i + 1);
          const key = splitDir.mode === 'base' ? a : bq;
          const other = splitDir.mode === 'base' ? bq : a;
          if (!leftMap.has(key)) leftMap.set(key, new Set());
          leftMap.get(key).add(other);
        }
        const keys = [...leftMap.keys()].sort();
        const leftCol = document.createElement('div');
        leftCol.className = 'sym-split-col';
        const lh = document.createElement('div');
        lh.className = 'sym-count';
        lh.textContent = `${splitDir.mode === 'base' ? 'Bases' : 'Quotes'} (${keys.length})`;
        leftCol.appendChild(lh);
        const leftList = document.createElement('div');
        leftList.className = 'sym-split-list';
        leftCol.appendChild(leftList);
        const rightCol = document.createElement('div');
        rightCol.className = 'sym-split-col';
        cols.append(leftCol, rightCol);
        const showRight = (key) => {
          rightCol.innerHTML = '';
          const others = [...(leftMap.get(key) || [])].sort();
          const rh = document.createElement('div');
          rh.className = 'sym-count';
          rh.textContent = `${key} → ${splitDir.mode === 'base' ? 'quotes' : 'bases'} (${others.length})`;
          rightCol.appendChild(rh);
          const rl = document.createElement('div');
          rl.className = 'sym-split-list';
          for (const o of others) {
            const full = splitDir.mode === 'base' ? `${key}/${o}` : `${o}/${key}`;
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.inst = full;
            b.textContent = full;
            b.addEventListener('click', async () => {
              pairInput.value = full;
              pairList.dataset.first = full;
              await apply();
            });
            rl.appendChild(b);
          }
          rightCol.appendChild(rl);
        };
        for (const k of keys) {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.base = k;
          b.innerHTML = `<span class="sym-label">${escHtml(k)}</span><span class="sym-badge">${leftMap.get(k).size}</span>`;
          b.addEventListener('click', () => {
            leftList.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
            b.classList.add('on');
            showRight(k);
          });
          leftList.appendChild(b);
        }
        const pre = keys.includes('BTC') ? 'BTC' : keys[0];
        if (pre) {
          const btn = leftList.querySelector(`button[data-base="${CSS.escape(pre)}"]`);
          if (btn) btn.click();
        }
      };
      // Network-plot tab: own canvas mini-graph (vanilla 2D, no libs). The
      // venue sits at the center, top assets orbit sized by market counts,
      // edges = markets. Clicking an asset node filters the pair list.
      const drawPlot = () => {
        const cv = dlg.querySelector('#sym-plot');
        const pnote = dlg.querySelector('#sym-plot-note');
        if (!cv) return;
        let ctx = null;
        try { ctx = cv.getContext('2d'); } catch {}
        if (!ctx) return;
        const dark = (document.documentElement.dataset.theme || 'dark') === 'dark';
        const W = cv.width || 620, H = cv.height || 300;
        plotNodes = [];
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = dark ? '#131722' : '#ffffff';
        ctx.fillRect(0, 0, W, H);
        const venue = (exInput.value || (curSource === 'ccxt' ? 'binance' : curSource)).trim() || 'venue';
        const counts = new Map();
        for (const s of curPairs) {
          const i = s.indexOf('/');
          const base = i >= 0 ? s.slice(0, i) : s;
          if (base) counts.set(base, (counts.get(base) || 0) + 1);
        }
        const tops = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
        const cx = W / 2, cy = H / 2;
        const maxC = tops.length ? tops[0][1] : 1;
        const ink = dark ? '#d1d4dc' : '#0f0f0f';
        const accent = '#2962FF';
        const ringR = Math.min(W, H) / 2 - 46;
        tops.forEach(([base, c], i) => {
          const a = (i / Math.max(1, tops.length)) * Math.PI * 2 - Math.PI / 2;
          const x = cx + Math.cos(a) * ringR, y = cy + Math.sin(a) * ringR;
          const r = 10 + 18 * (c / maxC);
          ctx.strokeStyle = dark ? '#2a2e39' : '#e0e3eb';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.fillStyle = 'rgba(41,98,255,0.16)';
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = accent;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = ink;
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(base, x, y + r + 12);
          ctx.fillText(String(c), x, y + 4);
          plotNodes.push({ x, y, r: r + 6, kind: 'asset', id: base });
        });
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(cx, cy, 26, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(venue).slice(0, 10), cx, cy + 4);
        plotNodes.push({ x: cx, y: cy, r: 32, kind: 'venue', id: venue });
        try { cv._nodes = plotNodes.slice(); } catch {}
        if (pnote) {
          pnote.textContent = tops.length
            ? `${tops.length} assets · ${curPairs.length} markets · click an asset node to filter pairs`
            : 'No markets loaded yet — pick a venue on the Markets tab.';
        }
      };
      const switchTab = (name) => {
        for (const [k, el] of Object.entries(panes)) {
          if (el) el.style.display = k === name ? 'flex' : 'none';
        }
        tabHost.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
        if (name === 'plot') drawPlot();
        if (name === 'split') renderSplit();
      };
      const apply = async () => {
        // Companion tiers route to the companion loader; the ccxt path below
        // keeps the byte-identical reload call for ccxt symbols.
        if (curSource && curSource !== 'ccxt') {
          // Companion symbols travel verbatim: normalizeSymbol uppercases the
          // input and splits quotes, which corrupts case-sensitive ids
          // (dex network:address pools) and slash-joins BASE:QUOTE pairs
          // (bitshares BTS:bitUSD). The companion validates honestly.
          const raw = String(pairInput.value || '').trim();
          if (!raw) { pairInput.focus(); return; }
          // A pasted `source:SYM` qualifier would double up (`stub:stub:X`)
          // since loadCompanion qualifies itself — strip it to the raw symbol.
          const pre = `${curSource}:`.toLowerCase();
          let sym = raw;
          if (sym.toLowerCase().startsWith(pre)) sym = sym.slice(pre.length).trim();
          if (!sym) { pairInput.focus(); return; }
          const venue = (exInput.value || '').trim();
          const ok = await loadCompanion(curSource, venue, sym, intSel.value || curInterval());
          if (ok) { renderRecents(); try { dlg.close(); } catch { dlg.removeAttribute('open'); } }
          return;
        }
        const ex = (exInput.value || 'binance').trim().toLowerCase();
        const pair = normalizeSymbol(pairInput.value);
        if (!pair) { pairInput.focus(); return; }
        const ok = await reload(`${ex}:${pair}`, intSel.value || curInterval());
        if (ok) {
          try { v.set({ source: 'ccxt', venue: ex }); saveLayout(); } catch {}
          pushRecent({ source: 'ccxt', venue: ex, symbol: `${ex}:${pair}`, label: `${ex} · ${pair}` });
          renderRecents();
          try { dlg.close(); } catch { dlg.removeAttribute('open'); }
        }
      };
      exInput.addEventListener('input', () => debounceEx(() => refreshVenues(false)));
      exInput.addEventListener('focus', () => refreshVenues(false));
      exInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (exList.dataset.first) { exInput.value = exList.dataset.first; refreshPairs(); }
        }
      });
      pairInput.addEventListener('input', () => debouncePair(() => refreshPairs()));
      pairInput.addEventListener('focus', () => refreshPairs());
      dlg.querySelector('#sym-apply').addEventListener('click', apply);
      dlg.querySelector('#sym-x')?.addEventListener('click', () => {
        try { dlg.close(); } catch { dlg.removeAttribute('open'); }
      });
      pairInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (pairList.dataset.first) pairInput.value = pairList.dataset.first;
          apply();
        }
      });
      dlg.querySelector('button[value="close"]').addEventListener('click', () => {
        try { dlg.close(); } catch { dlg.removeAttribute('open'); }
      });
      // Plot clicks filter (asset node) or clear the filter (venue node).
      dlg.querySelector('#sym-plot')?.addEventListener('click', (e) => {
        const cv = dlg.querySelector('#sym-plot');
        if (!cv) return;
        const r = cv.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return;
        const x = (e.clientX - r.left) * (cv.width / r.width);
        const y = (e.clientY - r.top) * (cv.height / r.height);
        const hit = plotNodes.find((n) => (x - n.x) * (x - n.x) + (y - n.y) * (y - n.y) <= n.r * n.r);
        if (!hit) return;
        if (hit.kind === 'asset') {
          // CCXT nodes are bases, so the trailing slash scopes the quote list
          // to that base; companion nodes are bare symbols, filtered verbatim.
          pairInput.value = curSource === 'ccxt' ? `${hit.id}/` : hit.id;
          switchTab('markets');
          refreshPairs();
          showToast(`${hit.id} filter — pick a quote to switch`);
        } else {
          pairInput.value = '';
          switchTab('markets');
          refreshPairs();
        }
      });
      // Top-level view tabs.
      tabHost.innerHTML = '';
      for (const [id, label] of [['markets', 'Markets'], ['split', 'Bases/Quotes'], ['plot', 'Network']]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.tab = id;
        b.textContent = label;
        b.setAttribute('role', 'tab');
        b.addEventListener('click', () => switchTab(id));
        tabHost.appendChild(b);
      }
      // Per-open refresh (async: companion tiers resolve, then lists paint).
      dlg._api = {
        setSource: (id) => { if (sourceById(id)) curSource = id; },
        refreshAll: async () => {
          await fetchCompanionSources();
          try { renderSourceTabs(); } catch {}
          try { renderIntervals(); } catch {}
          try { renderRecents(); } catch {}
          try { switchTab('markets'); } catch {}
          try { await refreshVenues(false); } catch {}
          try { await refreshPairs(); } catch {}
        },
      };
    }
    // Prefill from the current market (tiers included), then show. Lists
    // refresh async per open so companion reachability is re-probed.
    try {
      const st = v.get();
      const m = resolveMarket(st.symbol || 'BTC/USD');
      if (st.source && dlg._api) dlg._api.setSource(st.source);
      dlg.querySelector('#sym-ex-input').value = st.venue || String(m.exchange || 'binance');
      dlg.querySelector('#sym-pair-input').value = m.ccxtSymbol || 'BTC/USDT';
      dlg.querySelector('#sym-pair-list').innerHTML = '';
      dlg.querySelector('#sym-note').textContent = '';
      if (dlg._api) dlg._api.refreshAll();
    } catch {}
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
  };
  // Symbol search: modal with exchange + pair autosuggest (label/state change
  // only on successful reload — see reload contract).
  const symBtn = document.querySelector('#sym');
  if (symBtn && !symBtn.dataset.bound) {
    symBtn.dataset.bound = '1';
    symBtn.addEventListener('click', () => openSymbolModal());
  }
  // Companion boot: a restored companion layout (source/venue/symbol) loads via
  // the companion path. The generic boot above already attempted the ccxt path,
  // which errors honestly for companion-qualified symbols (no mislabel).
  try {
    const st0 = v.get();
    if (st0.source && st0.source !== 'ccxt' && st0.symbol) {
      const raw = String(st0.symbol).includes(':') ? String(st0.symbol).split(':').slice(1).join(':') : String(st0.symbol);
      loadCompanion(st0.source, st0.venue || '', raw, st0.interval || '1d');
    }
  } catch {}
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
      }
      if (L.timeframe) patch.timeframe = L.timeframe;
      if (L.locked != null) patch.locked = !!L.locked;
      if (L.drawingsHidden != null) patch.drawingsHidden = !!L.drawingsHidden;
      if (L.priceAuto != null) patch.priceAuto = L.priceAuto !== false;
      if (L.stayMode != null) { patch.stayMode = L.stayMode !== false; stayMode = patch.stayMode; }
      void cur;
    }
    v.set(patch);
    saveLayout();
    updateSymbolHead();
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
  // Debug hook (audit tooling only): exposes view state + rows when ?debug
  // was present at import. Never used by production code paths.
  try {
    if (HAS_DEBUG && typeof window !== 'undefined') {
      window.__tv = {
        view: v,
        rows: () => rows,
        drag: () => ({ id: dragDrawingId, anchor: dragAnchorIdx, origin: !!dragOrigin }),
        stream: () => ({ state: streamState, active: !!stream, key: streamKey }),
      };
    }
  } catch {}
  syncScaleTip();
}
