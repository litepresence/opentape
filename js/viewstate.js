// js/viewstate.js
export function ViewState(initial = {}) {
  let s = { symbol: 'BTC/USD', timeframe: '1D', theme: 'light', visible: null, price: null, drawings: [], alerts: [], replayIndex: null, ...initial };
  const subs = new Set();
  let queued = false; let fn = null;
  return {
    get: () => ({ ...s }),
    set(patch) { s = { ...s, ...patch }; subs.forEach(cb => cb(this.get())); if (fn && !queued) { queued = true; const raf = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame : (cb) => setTimeout(cb, 0); raf(() => { queued = false; fn(this.get()); }); } },
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    onRender(f) { fn = f; },
    toggleTheme() { const next = s.theme === 'light' ? 'dark' : 'light'; this.set({ theme: next }); if (typeof document !== 'undefined' && document.documentElement) { document.documentElement.dataset.theme = next; } try { localStorage.setItem('tv-theme', next); } catch {} },
  };
}
function storedTheme() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem('tv-theme') || 'light';
  } catch { /* storage unavailable (private mode / SSR) — fall through */ }
  return 'light';
}
export const view = ViewState({ theme: storedTheme() });
