// js/drawings.js — drawing model: anchors, migration, geometry helpers.
// All drawings are stored in time/price coordinates so they survive pan/zoom.
import { ITEMS } from './tools.js';
export function snapPrice(p, rows, tol = 2) {
  let best = null, bd = tol;
  for (const r of rows) for (const v of [r.o, r.h, r.l, r.c]) { const d = Math.abs(v - p); if (d <= bd) { bd = d; best = v; } }
  return best ?? p;
}
export function serialize(drawings) { return JSON.stringify(drawings); }
export function deserialize(s) { try { return JSON.parse(s) || []; } catch { return []; } }

// Anchor count comes from the rail table: each tool declares how many clicks
// place it. Cursor/action tools declare 0 — they are modes, not drawings.
const LEGACY = { trend: 2, prediction: 2, fib: 2, ray: 2, rect: 2, ellipse: 2, horizontal: 1, text: 1, icon: 1, xabcd: 5 };
export const ANCHORS = Object.fromEntries([
  ...Object.entries(LEGACY),
  ...Object.entries(ITEMS).map(([id, it]) => [id, it.anchors || 0]),
]);
export const FREEFORM = new Set(['brush', 'highlighter']);

export function anchorCount(type) { return ANCHORS[type] ?? 2; }
export function isComplete(d) {
  if (!d || !d.type) return false;
  if (!Array.isArray(d.points)) return false;
  if (FREEFORM.has(d.type)) return d.points.length >= 2 && d.points.every(p => p && Number.isFinite(p.p));
  const need = anchorCount(d.type);
  if (d.points.length < need) return false;
  // Horizontal lines carry price only (their time anchor is null by design);
  // every other type needs both coordinates.
  return d.points.slice(0, need).every(p => p && Number.isFinite(p.p)
    && (d.type === 'horizontal' || Number.isFinite(p.t)));
}

// Migrate legacy records ({p1,p2,price,t,p,text}) to the points model so saved
// layouts keep working. Idempotent.
export function migrateDrawing(d) {
  if (!d || typeof d !== 'object') return null;
  if (Array.isArray(d.points)) return d;
  const pts = [];
  if (Number.isFinite(d.p1?.t)) pts.push({ t: d.p1.t, p: d.p1.p });
  if (Number.isFinite(d.p2?.t)) pts.push({ t: d.p2.t, p: d.p2.p });
  if (!pts.length && Number.isFinite(d.t) && Number.isFinite(d.p)) pts.push({ t: d.t, p: d.p });
  if (!pts.length && Number.isFinite(d.price)) {
    // Horizontal lines have no time anchor in the legacy shape; keep price-only.
    const t = Number.isFinite(d.t) ? d.t : null;
    return { id: d.id, type: 'horizontal', points: [{ t, p: d.price }], text: d.text };
  }
  return { id: d.id, type: d.type, points: pts, text: d.text };
}
export function migrateDrawings(list) { return (Array.isArray(list) ? list : []).map(migrateDrawing).filter(Boolean); }

let seq = 0;
export function makeDrawing(type, points, extra = {}) {
  return { id: 'd' + Date.now().toString(36) + (seq++).toString(36), type, points, ...extra };
}
export function addDrawing(view, d) {
  const cur = view.get().drawings; view.set({ drawings: [...cur, d] });
}

// Translate every anchor by (dt, dp) — used when dragging a whole drawing.
export function translateDrawing(d, dt, dp) {
  // null time = price-only anchor (horizontal lines): leave it null instead of
  // coercing it to 0, which would silently re-anchor the line in time.
  return { ...d, points: d.points.map(p => ({ t: p.t == null ? null : p.t + dt, p: p.p + dp })) };
}
// Replace one anchor — used when dragging a handle.
export function moveAnchor(d, i, p) {
  const points = d.points.slice();
  points[i] = p;
  return { ...d, points };
}
export function bounds(d) {
  const xs = d.points.map(p => p.t), ps = d.points.map(p => p.p);
  return {
    t0: Math.min(...xs), t1: Math.max(...xs),
    p0: Math.min(...ps), p1: Math.max(...ps),
  };
}
