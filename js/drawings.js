// js/drawings.js
export function snapPrice(p, rows, tol = 2) {
  let best = null, bd = tol;
  for (const r of rows) for (const v of [r.o, r.h, r.l, r.c]) { const d = Math.abs(v - p); if (d <= bd) { bd = d; best = v; } }
  return best ?? p;
}
export function serialize(drawings) { return JSON.stringify(drawings); }
export function deserialize(s) { try { return JSON.parse(s) || []; } catch { return []; } }
export function addDrawing(view, d) {
  const cur = view.get().drawings; view.set({ drawings: [...cur, { id: 'd' + Date.now(), ...d }] });
  try { localStorage.setItem('tv-clone-layout-v1', serialize(view.get().drawings)); } catch {}
}
