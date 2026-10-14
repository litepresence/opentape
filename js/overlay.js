// js/overlay.js — crosshair, drawing rendering and hit-testing.
//
// Drawing shapes come from js/geometry.js as primitive lists; this module only
// paints them and hit-tests them, so the selectable region always matches what
// is painted.
import { xForTime, yForPrice, visibleRows, sliceOffset, xForRowTime } from './chart.js';
import { anchorCount } from './drawings.js';
import { buildPrimitives } from './geometry.js';

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 1];
const FONT = '11px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
const SEL = '#2962FF';
const IDLE = '#787b86';

export function hitTest(mx, vis, left, width, rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const sliced = visibleRows(rows, vis);
  const src = sliced.length ? sliced : rows;
  const off = sliced.length ? sliceOffset(rows, sliced) : 0;
  const step = width / Math.max(1, src.length);
  let best = 0, bd = 1e18;
  src.forEach((r, i) => { const x = left + i * step + step / 2; const d = Math.abs(x - mx); if (d < bd) { bd = d; best = i; } });
  return off + best;
}
// The Cursors menu offers three pointer shapes; all read the same OHLC.
export function drawCrosshair(ctx, mx, my, geom, pal, shape = 'cross') {
  ctx.save(); ctx.strokeStyle = pal.text; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(mx, geom.top); ctx.lineTo(mx, geom.top + geom.height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(geom.left, my); ctx.lineTo(geom.left + geom.width, my); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = '#2962FF';
  if (shape === 'dot') {
    ctx.beginPath(); ctx.arc(mx, my, 3, 0, Math.PI * 2); ctx.stroke();
  } else if (shape === 'arrow') {
    ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx + 13, my + 4); ctx.lineTo(mx + 5, my + 5); ctx.lineTo(mx + 4, my + 13); ctx.closePath(); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(mx, my, 6, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

// --- projection context handed to js/geometry.js ----------------------------
export function makeCtx(state, geom, rows) {
  // geom arrives as {left,top,width,height}; tools also want the derived edges.
  const box = {
    left: geom.left || 0,
    top: geom.top || 0,
    width: geom.width || 0,
    height: geom.height || 0,
    right: (geom.left || 0) + (geom.width || 0),
    bottom: (geom.top || 0) + (geom.height || 0),
  };
  geom = box;
  const sliced = Array.isArray(rows) && rows.length ? visibleRows(rows, state.visible) : null;
  const src = sliced && sliced.length ? sliced : null;
  const step = src && src.length ? geom.width / src.length : 8;
  const xy = (p) => {
    if (!p || !Number.isFinite(p.p)) return null;
    const x = Number.isFinite(p.t)
      ? (src && src.length ? xForRowTime(p.t, src, geom.left, geom.width) : xForTime(p.t, state.visible, geom.left, geom.width))
      : geom.left;
    return Number.isFinite(x) ? { x, y: yForPrice(p.p, state.price, geom.top, geom.height) } : null;
  };
  const indexOf = (t) => (src || []).findIndex((r) => r.t === t);
  return {
    geom,
    box,
    state,
    rows: src || rows || [],
    xy,
    barWidth: () => step,
    xForRow: (r) => {
      const i = indexOf(r.t);
      return i >= 0 ? geom.left + i * step + step / 2 : geom.left;
    },
    yForPrice: (p) => yForPrice(p, state.price, geom.top, geom.height),
    lastRow: () => (src && src.length ? src[src.length - 1] : null),
    window: (x0, x1) => {
      const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
      return (src || []).filter((r) => { const x = geom.left + indexOf(r.t) * step + step / 2; return x >= lo && x <= hi; });
    },
    // Anchored VWAP from the anchor bar to the right edge.
    vwap: (x0) => {
      const start = Math.max(0, Math.round((x0 - geom.left) / step));
      const seg = (src || []).slice(start);
      let pv = 0, vol = 0;
      const out = [];
      seg.forEach((r, i) => {
        const tp = (r.h + r.l + r.c) / 3;
        pv += tp * r.v; vol += r.v;
        out.push({ x: geom.left + (start + i) * step + step / 2, y: yForPrice(vol ? pv / vol : r.c, state.price, geom.top, geom.height) });
      });
      return out;
    },
    // Horizontal volume profile between two screen positions.
    volProfile: (x0, x1) => {
      const win = (src || []).filter((r) => { const x = geom.left + indexOf(r.t) * step + step / 2; return x >= Math.min(x0, x1) && x <= Math.max(x0, x1); });
      if (!win.length) return [];
      const lo = Math.min(...win.map((r) => r.l));
      const hi = Math.max(...win.map((r) => r.h));
      const bins = 24;
      const out = Array.from({ length: bins }, () => ({ v: 0, p: 0 }));
      for (const r of win) {
        const i = Math.min(bins - 1, Math.max(0, Math.floor(((r.c - lo) / Math.max(1e-9, hi - lo)) * bins)));
        out[i].v += r.v; out[i].p += r.c;
      }
      return out.map((b) => ({ v: b.v, y: yForPrice(b.p, state.price, geom.top, geom.height) }));
    },
    dateLabel: (t0, t1) => {
      const f = (t) => new Date(t).toISOString().slice(5, 10);
      return `${f(t0)} – ${f(t1)}`;
    },
  };
}

function drawable(d) {
  if (!d || !Array.isArray(d.points) || !d.points.length) return false;
  const need = anchorCount(d.type);
  if (!need) return false;
  return d.points.length >= need && d.points.slice(0, need).every((p) => p && Number.isFinite(p.p));
}
function handle(ctx, x, y, color) {
  ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
}

// --- primitive painting -----------------------------------------------------
function arrowHead(ctx, x, y, ax, ay, size = 7) {
  const a = Math.atan2(y - ay, x - ax);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(a - 0.4), y - size * Math.sin(a - 0.4));
  ctx.lineTo(x - size * Math.cos(a + 0.4), y - size * Math.sin(a + 0.4));
  ctx.closePath(); ctx.fill();
}

export function paintPrimitives(ctx, prims, d, gctx) {
  for (const p of prims) {
    switch (p.op) {
      case 'line': {
        ctx.setLineDash(p.dash || []);
        ctx.beginPath(); ctx.moveTo(p.x1, p.y1); ctx.lineTo(p.x2, p.y2); ctx.stroke();
        if (p.arrows === 'end') arrowHead(ctx, p.x2, p.y2, p.x1, p.y1);
        if (p.arrows === 'both') { arrowHead(ctx, p.x1, p.y1, p.x2, p.y2); arrowHead(ctx, p.x2, p.y2, p.x1, p.y1); }
        if (p.arrows === 'dot') { ctx.beginPath(); ctx.arc(p.x1, p.y1, 3, 0, Math.PI * 2); ctx.fill(); }
        ctx.setLineDash([]);
        break;
      }
      case 'path': {
        const pts = p.pts.filter(Boolean);
        if (pts.length < 2) break;
        if (p.fill != null) {
          ctx.save(); ctx.globalAlpha = p.fill;
          ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
          pts.slice(1).forEach((q) => ctx.lineTo(q.x, q.y));
          if (p.close) ctx.closePath();
          ctx.fillStyle = ctx.strokeStyle; ctx.fill(); ctx.restore();
        }
        ctx.save();
        if (p.thick) { ctx.lineWidth = p.thick; ctx.globalAlpha = p.thick > 4 ? 0.2 : 1; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; }
        ctx.setLineDash(p.dash || []);
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
        pts.slice(1).forEach((q) => ctx.lineTo(q.x, q.y));
        if (p.close) ctx.closePath();
        ctx.stroke(); ctx.restore();
        break;
      }
      case 'rect': {
        if (p.fill != null && (p.w > 0 || p.h > 0)) {
          ctx.save();
          let ralpha = p.fill;
          if (Number.isFinite(p.opacity)) ralpha *= Math.min(1, Math.max(0, p.opacity));
          ctx.globalAlpha = ralpha;
          ctx.fillStyle = p.bg || ctx.strokeStyle; ctx.fillRect(p.x, p.y, Math.max(0, p.w), Math.max(0, p.h)); ctx.restore();
        }
        if (p.w > 0 && p.h > 0 && !p.noStroke) {
          ctx.save();
          ctx.setLineDash(p.dash || []);
          if (p.border) ctx.strokeStyle = p.border;
          ctx.strokeRect(p.x, p.y, p.w, p.h);
          ctx.restore();
        }
        break;
      }
      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse(p.cx, p.cy, Math.abs(p.rx), Math.abs(p.ry), 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'arc':
        ctx.beginPath(); ctx.arc(p.cx, p.cy, Math.abs(p.r), p.a0, p.a1); ctx.stroke();
        break;
      case 'text': {
        ctx.save();
        const tparts = [];
        if (p.italic) tparts.push('italic');
        if (p.bold) tparts.push('700');
        const tsize = p.size || 11;
        ctx.font = `${tparts.length ? tparts.join(' ') + ' ' : ''}${tsize}px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif`;
        ctx.textAlign = p.align || 'left';
        if (p.color && d.id !== gctx?.selectedId) ctx.fillStyle = p.color;
        if (Number.isFinite(p.opacity)) ctx.globalAlpha *= Math.min(1, Math.max(0, p.opacity));
        ctx.fillText(p.text ?? '', p.x, p.y);
        ctx.restore();
        break;
      }
      case 'box': {
        const w = p.w, h = p.h;
        const isNote = p.variant === 'note' || p.variant === 'comment';
        if (p.image) {
          const img = gctx?.images?.get?.(p.image);
          if (img) {
            ctx.save();
            if (Number.isFinite(p.opacity)) ctx.globalAlpha *= Math.min(1, Math.max(0, p.opacity));
            ctx.drawImage(img, p.x, p.y, w, h);
            ctx.restore();
          }
          else ctx.strokeRect(p.x, p.y, w, h);
        } else {
          ctx.save(); ctx.globalAlpha = 0.92;
          if (isNote) {
            ctx.fillStyle = d.id === gctx?.selectedId ? '#2962FF'
              : (p.variant === 'comment' ? '#f5f5f0' : '#fff3c4');
          } else {
            ctx.fillStyle = d.id === gctx?.selectedId ? '#2962FF' : '#1e222d';
          }
          ctx.fillRect(p.x, p.y, w, h); ctx.restore();
          ctx.strokeRect(p.x, p.y, w, h);
        }
        ctx.save();
        const selected = d.id === gctx?.selectedId;
        ctx.fillStyle = (isNote && !selected) ? '#1a1a1a' : '#f0f3fa';
        ctx.textAlign = isNote ? 'left' : 'center';
        const lines = String(p.label || '').split('\n').slice(0, 4);
        const tx = isNote ? p.x + 8 : p.x + w / 2;
        lines.forEach((ln, i) => ctx.fillText(ln, tx, p.y + 18 + i * 14));
        ctx.restore();
        break;
      }
      default: break;
    }
  }
}

export function drawDrawings(ctx, drawings, state, geom, rows) {
  if (!drawings || !drawings.length || !state.visible || !state.price) return;
  const gctx = makeCtx(state, geom, rows);
  ctx.save();
  ctx.font = FONT;
  ctx.lineJoin = 'round';
  for (const d of drawings) {
    if (!drawable(d)) continue;
    const sel = d.id === state.selectedId;
    ctx.strokeStyle = sel ? SEL : IDLE;
    ctx.fillStyle = sel ? SEL : IDLE;
    ctx.lineWidth = sel ? 2 : 1;
    const prims = buildPrimitives({ ...d, kind: d.kind || d.type }, gctx);
    paintPrimitives(ctx, prims, d, gctx);
    if (sel) {
      for (let i = 0; i < d.points.length; i += 1) {
        if (!Number.isFinite(d.points[i]?.p)) continue;
        const h = gctx.xy(d.points[i]);
        if (h) handle(ctx, h.x, h.y, SEL);
      }
    }
  }
  ctx.restore();
}

// --- hit testing -----------------------------------------------------------
export function hitTestAnchor(drawings, state, geom, rows, mx, my, tol = 8) {
  const d = (drawings || []).find((x) => x && x.id === state.selectedId);
  if (!drawable(d)) return -1;
  const gctx = makeCtx(state, geom, rows);
  for (let i = 0; i < d.points.length; i += 1) {
    const p = d.points[i];
    if (!p || !Number.isFinite(p.p) || !Number.isFinite(p.t)) continue;
    const h = gctx.xy(p);
    if (h && Math.hypot(h.x - mx, h.y - my) <= tol) return i;
  }
  return -1;
}

function primDist(prims, mx, my) {
  let best = Infinity;
  for (const p of prims) {
    if (p.op === 'line') best = Math.min(best, segDist(mx, my, p.x1, p.y1, p.x2, p.y2));
    else if (p.op === 'path' && p.pts.length > 1) {
      for (let i = 0; i + 1 < p.pts.length; i += 1) {
        best = Math.min(best, segDist(mx, my, p.pts[i].x, p.pts[i].y, p.pts[i + 1].x, p.pts[i + 1].y));
      }
    } else if (p.op === 'rect' && p.w > 0 && p.h > 0) {
      const x = Math.min(p.x, p.x + p.w), y = Math.min(p.y, p.y + p.h);
      const w = Math.abs(p.w), h = Math.abs(p.h);
      const inside = mx >= x && mx <= x + w && my >= y && my <= y + h;
      if (inside) best = Math.min(best, 0.5);
      else {
        best = Math.min(best,
          segDist(mx, my, x, y, x + w, y),
          segDist(mx, my, x + w, y, x + w, y + h),
          segDist(mx, my, x + w, y + h, x, y + h),
          segDist(mx, my, x, y + h, x, y));
      }
    } else if (p.op === 'ellipse') {
      const dx = (mx - p.cx) / (Math.abs(p.rx) || 1), dy = (my - p.cy) / (Math.abs(p.ry) || 1);
      const r = Math.hypot(dx, dy);
      best = Math.min(best, Math.abs(r - 1) * Math.min(Math.abs(p.rx), Math.abs(p.ry)));
    } else if (p.op === 'arc') {
      const a = Math.atan2(my - p.cy, mx - p.cx);
      const lo = Math.min(p.a0, p.a1), hi = Math.max(p.a0, p.a1);
      if (a >= lo - 0.2 && a <= hi + 0.2) best = Math.min(best, Math.abs(Math.hypot(mx - p.cx, my - p.cy) - Math.abs(p.r)));
    } else if (p.op === 'box') {
      const inside = mx >= p.x && mx <= p.x + p.w && my >= p.y && my <= p.y + p.h;
      if (inside) best = Math.min(best, 0.5);
    } else if (p.op === 'text') {
      // Labels are body-selectable: estimated text bounds (builders have no
      // canvas measure hook). Selections still prefer nearer line/path hits.
      const s = p.size || 11;
      const tw = String(p.text ?? '').length * s * 0.6;
      let tx0 = p.x;
      if (p.align === 'center') tx0 = p.x - tw / 2;
      else if (p.align === 'right') tx0 = p.x - tw;
      if (mx >= tx0 - 4 && mx <= tx0 + tw + 4 && my >= p.y - s - 4 && my <= p.y + 4) {
        best = Math.min(best, 0.5);
      }
    }
  }
  return best;
}

export function hitTestDrawing(drawings, state, geom, rows, mx, my, tol = 6) {
  const gctx = makeCtx(state, geom, rows);
  let best = null, bd = tol;
  for (const d of drawings || []) {
    if (!drawable(d)) continue;
    const dist = primDist(buildPrimitives({ ...d, kind: d.kind || d.type }, gctx), mx, my);
    if (dist <= bd) { bd = dist; best = d; }
  }
  return best;
}
function segDist(px0, py0, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px0 - x1) * dx + (py0 - y1) * dy) / len2)) : 0;
  return Math.hypot(px0 - (x1 + t * dx), py0 - (y1 + t * dy));
}

export function drawAlerts(ctx, alerts, state, geom) {
  if (!alerts || !alerts.length || !state.price) return;
  ctx.save();
  ctx.font = FONT;
  for (const a of alerts) {
    if (!Number.isFinite(a.price)) continue;
    const y = yForPrice(a.price, state.price, geom.top, geom.height);
    const sel = a.id === state.selectedId;
    ctx.strokeStyle = '#F23645';
    ctx.lineWidth = sel ? 2 : 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(geom.left, y); ctx.lineTo(geom.left + geom.width, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#F23645';
    const label = String(Math.round(a.price));
    const w = ctx.measureText ? ctx.measureText(label).width + 8 : 60;
    ctx.fillRect(geom.left + geom.width - w, y - 9, w, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, geom.left + geom.width - w + 4, y + 4);
  }
  ctx.restore();
}

export function drawPending(ctx, pending, cursor, state, geom, rows) {
  if (!pending || !Array.isArray(pending.points) || !pending.points.length) return;
  const gctx = makeCtx(state, geom, rows);
  const pts = pending.points.map((p) => gctx.xy(p)).filter(Boolean);
  if (!pts.length) return;
  const last = pts[pts.length - 1];
  const x2 = cursor && Number.isFinite(cursor.x) ? cursor.x : last.x;
  const y2 = cursor && Number.isFinite(cursor.y) ? cursor.y : last.y;
  ctx.save();
  ctx.strokeStyle = SEL;
  ctx.fillStyle = SEL;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.slice(1).forEach((q) => ctx.lineTo(q.x, q.y));
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
  pts.forEach((q) => handle(ctx, q.x, q.y, SEL));
  ctx.restore();
}
