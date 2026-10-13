// js/geometry.js — every rail tool reduced to a list of canvas primitives.
//
// Render and hit-test both consume `buildPrimitives`, so the selectable region
// always matches what is painted. Primitives are in chart pixel space; the
// caller supplies the projection.
//
//   line    { x1,y1,x2,y2, dash?, arrows? }
//   path    { pts:[{x,y}], close?, smooth?, dash? }
//   rect    { x,y,w,h, fill? }
//   ellipse { cx,cy,rx,ry }
//   arc     { cx,cy,r,a0,a1, dash? }
//   text    { x,y,text,align?,size?,color? }
//   box     { x,y,w,h, label?, align? }   // labelled range box (measurers)

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const lerp = (a, b, t) => a + (b - a) * t;
function lerpP(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }; }
function rot(p, c, a) {
  const s = Math.sin(a), co = Math.cos(a);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * co - dy * s, y: c.y + dx * s + dy * co };
}
function smoothPath(pts, closed = false) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i], b = pts[i + 1];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    out.push({ x: mx, y: my }, b);
  }
  return closed ? [...out, out[0]] : out;
}
// Sample a parametric function across [0,1] — sine lines, spirals, arcs.
function sample(f, steps = 48) {
  const out = [];
  for (let i = 0; i <= steps; i += 1) out.push(f(i / steps));
  return out;
}

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const EXT = [0, 0.618, 1, 1.618, 2, 2.618, 3.618, 4.236];

// --- line families ---------------------------------------------------------
function lines(d, c) {
  const a = c.xy(d.points[0]), b = c.xy(d.points[1]);
  const { left, right, top, bottom } = c.geom;
  switch (d.kind) {
    case 'ray':
      return [
        { op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y },
        { op: 'line', x1: a.x, y1: a.y, x2: a.x + (b.x - a.x) * 4, y2: a.y + (b.y - a.y) * 4 },
      ];
    case 'extended':
      return [
        { op: 'line', x1: left, y1: a.y, x2: right, y2: b.y, arrows: 'both' },
      ];
    case 'infoline':
      return [
        { op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y },
        { op: 'text', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 6, text: d.text || 'Info', align: 'center' },
      ];
    case 'angle': {
      const ang = (Math.atan2(a.y - b.y, a.x - b.x) * 180) / Math.PI;
      const r = Math.hypot(b.x - a.x, b.y - a.y);
      const a0 = Math.atan2(b.y - a.y, b.x - a.x);
      const a1 = Math.atan2(a.y - b.y, a.x - b.x);
      return [
        { op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y },
        { op: 'arc', cx: a.x, cy: a.y, r, a0, a1 },
        { op: 'text', x: a.x + 14, y: a.y - 8, text: `${Math.abs(ang).toFixed(1)}°`, align: 'left' },
      ];
    }
    case 'hline':
      return [{ op: 'line', x1: left, y1: a.y, x2: right, y2: a.y, arrows: 'both' }];
    case 'hray':
      return [{ op: 'line', x1: a.x, y1: a.y, x2: right, y2: a.y, arrows: 'end' }];
    case 'vline':
      return [{ op: 'line', x1: a.x, y1: top, x2: a.x, y2: bottom, arrows: 'both' }];
    case 'crossline':
      return [
        { op: 'line', x1: left, y1: a.y, x2: right, y2: a.y },
        { op: 'line', x1: a.x, y1: top, x2: a.x, y2: bottom },
      ];
    case 'arrow':
      return [{ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, arrows: d.variant === 'marker' ? 'dot' : 'end' }];
    default:
      return [{ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y }];
  }
}

// --- channels / forks ------------------------------------------------------
function channels(d, c) {
  const P = d.points.map((p) => c.xy(p));
  const [a, b] = P;
  if (d.kind === 'channel') {
    const off = P[2];
    return [
      { op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y },
      { op: 'line', x1: off.x, y1: off.y, x2: off.x + (b.x - a.x), y2: off.y + (b.y - a.y) },
      { op: 'path', pts: [a, b, { x: off.x + (b.x - a.x), y: off.y + (b.y - a.y) }, off], close: true, fill: 0.08 },
    ];
  }
  if (d.kind === 'disjoint') {
    return [
      { op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y },
      { op: 'line', x1: P[2].x, y1: P[2].y, x2: P[2].x + (b.x - a.x), y2: P[2].y + (b.y - a.y) },
    ];
  }
  if (d.kind === 'flattop') {
    const hi = Math.min(a.y, b.y), lo = Math.max(a.y, b.y);
    const e = P[2];
    return [
      { op: 'line', x1: a.x, y1: hi, x2: e.x, y2: hi },
      { op: 'line', x1: a.x, y1: lo, x2: e.x, y2: lo },
      { op: 'path', pts: [a, b, e], close: true, fill: 0.06 },
    ];
  }
  if (d.kind === 'regression') {
    const { mid, up, dn } = regression(c, a, b);
    return [
      { op: 'line', ...mid }, { op: 'line', ...up, dash: [5, 4] }, { op: 'line', ...dn, dash: [5, 4] },
    ];
  }
  // pitchfork family: median through p1 from the p0→p1 axis, plus parallels
  const axis = { x: b.x - a.x, y: b.y - a.y };
  const len = Math.hypot(axis.x, axis.y) || 1;
  const ux = axis.x / len, uy = axis.y / len;
  const nx = -uy, ny = ux; // normal
  const offs = d.variant === 'schiff' ? [-0.5, 0.5]
    : d.variant === 'modified' ? [-0.5, -1, 0.5]
      : d.variant === 'inside' ? [-0.25, 0.25] : [-1, -0.5, 0.5];
  const span = len * 2.2;
  const out = [{ op: 'line', x1: a.x, y1: a.y, x2: a.x + ux * span, y2: a.y + uy * span }];
  for (const o of offs) {
    const ox = a.x + nx * o * len, oy = a.y + ny * o * len;
    out.push({ op: 'line', x1: ox, y1: oy, x2: ox + ux * span, y2: oy + uy * span });
  }
  return out;
}

// Least-squares fit through the visible bars between two screen positions.
function regression(c, a, b) {
  const rows = c.window(a.x, b.x);
  const pts = rows.map((r) => ({ x: c.xForRow(r), y: c.yForPrice((r.h + r.l) / 2) }));
  if (pts.length < 2) return { mid: { x1: a.x, y1: a.y, x2: b.x, y2: b.y }, up: { x1: a.x, y1: a.y, x2: b.x, y2: b.y }, dn: { x1: a.x, y1: a.y, x2: b.x, y2: b.y } };
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxy = 0, sxx = 0;
  for (const p of pts) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; }
  const slope = sxx ? sxy / sxx : 0;
  const at = (x) => my + slope * (x - mx);
  let sd = 0;
  for (const p of pts) sd += (p.y - at(p.x)) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  return {
    mid: { x1: a.x, y1: at(a.x), x2: b.x, y2: at(b.x) },
    up: { x1: a.x, y1: at(a.x) - sd, x2: b.x, y2: at(b.x) - sd },
    dn: { x1: a.x, y1: at(a.x) + sd, x2: b.x, y2: at(b.x) + sd },
  };
}

// --- fibonacci / gann ------------------------------------------------------
function fibs(d, c) {
  const [p0, p1] = d.points;
  const a = c.xy(p0), b = c.xy(p1);
  const { left, right } = c.geom;
  const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
  const at = (lv) => lo + (hi - lo) * lv;
  const out = [];
  switch (d.kind) {
    case 'fib':
    case 'fibext': {
      const levels = d.kind === 'fib' ? FIB : EXT;
      const x2 = d.kind === 'fib' ? Math.max(a.x, b.x) : right;
      out.push({ op: 'rect', x: Math.min(a.x, b.x), y: lo, w: Math.abs(b.x - a.x), h: hi - lo, fill: 0.07 });
      for (const lv of levels) {
        out.push({ op: 'line', x1: Math.min(a.x, b.x), y1: at(lv), x2, y2: at(lv) });
        out.push({ op: 'text', x: x2 + 4, y: at(lv) + 3, text: String(lv), align: 'left' });
      }
      break;
    }
    case 'fibchannel': {
      const o = c.xy(d.points[2]);
      for (const lv of FIB) {
        out.push({ op: 'line', x1: a.x, y1: at(lv), x2: o.x, y2: at(lv) });
      }
      out.push({ op: 'path', pts: [a, b, o], fill: 0.06 });
      break;
    }
    case 'fibtime':
    case 'timecycles': {
      for (const lv of FIB) {
        const x = lerp(a.x, b.x, lv);
        out.push({ op: 'line', x1: x, y1: c.geom.top, x2: x, y2: c.geom.top + c.geom.height });
      }
      break;
    }
    case 'fibtimebased': {
      for (const lv of FIB) {
        const x = lerp(a.x, b.x, lv), y = lerp(a.y, b.y, lv);
        out.push({ op: 'line', x1: x, y1: y, x2: x + (b.x - a.x) * 0.6, y2: y + (b.y - a.y) * 0.6, dash: [4, 3] });
      }
      break;
    }
    case 'fibfan':
    case 'gannfan': {
      const levels = d.kind === 'gannfan' ? [0, 0.25, 0.5, 0.75, 1] : FIB;
      for (const lv of levels) {
        const t = lerpP(a, b, lv);
        out.push({ op: 'line', x1: a.x, y1: a.y, x2: a.x + (t.x - a.x) * 3, y2: a.y + (t.y - a.y) * 3 });
      }
      break;
    }
    case 'fibcircles': {
      const r = Math.hypot(b.x - a.x, b.y - a.y);
      for (const lv of [0.382, 0.618, 1]) out.push({ op: 'ellipse', cx: a.x, cy: a.y, rx: r * lv, ry: r * lv });
      break;
    }
    case 'fibarcs':
    case 'fibspiral': {
      const r = Math.hypot(b.x - a.x, b.y - a.y);
      const turns = d.kind === 'fibspiral' ? 2.5 : 0.5;
      const pts = sample((t) => {
        const ang = -Math.PI / 2 + t * turns * Math.PI * 2;
        const rad = r * (0.15 + 0.85 * t);
        return { x: a.x + Math.cos(ang) * rad, y: a.y + Math.sin(ang) * rad };
      }, 64);
      out.push({ op: 'path', pts });
      break;
    }
    case 'fibwedge':
    case 'pitchfan': {
      const tip = d.kind === 'pitchfan' ? c.xy(d.points[2]) : a;
      for (const lv of [0.382, 0.618, 1]) {
        const t = lerpP(a, b, lv);
        out.push({ op: 'line', x1: tip.x, y1: tip.y, x2: a.x + (t.x - a.x) * 3, y2: a.y + (t.y - a.y) * 3 });
      }
      break;
    }
    case 'gannbox': {
      const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const parts = d.variant === 'square-fixed' ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
      out.push({ op: 'rect', x, y, w, h, fill: 0.05 });
      for (const lv of parts) {
        out.push({ op: 'line', x1: x + w * lv, y1: y, x2: x + w * lv, y2: y + h });
        out.push({ op: 'line', x1: x, y1: y + h * lv, x2: x + w, y2: y + h * lv });
      }
      out.push({ op: 'line', x1: x, y1: y, x2: x + w, y2: y + h, dash: [4, 3] });
      out.push({ op: 'line', x1: x + w, y1: y, x2: x, y2: y + h, dash: [4, 3] });
      break;
    }
    default:
      out.push({ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return out;
}

// --- patterns / cycles -----------------------------------------------------
function polys(d, c) {
  const P = d.points.map((p) => c.xy(p));
  if (d.kind === 'cyclic') {
    const step = P[1].x - P[0].x;
    const out = [];
    for (let x = P[0].x; x < c.geom.right; x += Math.abs(step) || 20) {
      out.push({ op: 'line', x1: x, y1: c.geom.top, x2: x, y2: c.geom.top + c.geom.height });
    }
    return out;
  }
  if (d.kind === 'sine') {
    const [a, b] = P;
    const amp = Math.abs(b.y - a.y) || 20;
    return [{ op: 'path', pts: sample((t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) + Math.sin(t * Math.PI * 4) * amp * 0.25 }), 64) }];
  }
  const pts = d.smooth ? smoothPath(P, d.close) : (d.close ? [...P, P[0]] : P);
  const out = [{ op: 'path', pts, close: !!d.close }];
  if (d.labels) d.labels.slice(0, P.length).forEach((L, i) => out.push({ op: 'text', x: P[i].x - 7, y: P[i].y - 7, text: L, align: 'right' }));
  return out;
}

// --- forecasting / volume / measurers -------------------------------------
function forecast(d, c) {
  const [p0, p1] = d.points;
  const a = c.xy(p0), b = c.xy(p1);
  const { left, right, top, height } = c.geom;
  switch (d.kind) {
    case 'position': {
      const long = d.variant === 'short' ? a.y > b.y : a.y < b.y;
      const entry = long ? a.y : b.y;
      const target = long ? b.y : a.y;
      const stop = entry + (long ? 1 : -1) * Math.abs(entry - target);
      const x = Math.min(a.x, b.x), w = Math.abs(b.x - a.x);
      const yTop = Math.min(target, entry), h = Math.abs(entry - target);
      return [
        { op: 'rect', x, y: yTop, w, h: Math.max(h, 2), fill: 0.08 },
        { op: 'line', x1: x, y1: entry, x2: x + w, y2: entry },
        { op: 'text', x: x + w / 2, y: yTop + 12, text: 'Target', align: 'center' },
        { op: 'text', x: x + w / 2, y: yTop + h + 12, text: 'Stop', align: 'center' },
      ];
    }
    case 'barspattern': {
      const o = c.xy(d.points[2]);
      return [
        { op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y },
        { op: 'text', x: o.x, y: o.y - 8, text: String(Math.max(1, Math.round(Math.abs((b.x - a.x) / (c.barWidth() || 8))))), align: 'center' },
      ];
    }
    case 'ghostfeed': {
      const last = c.lastRow();
      const lp = last ? c.xy({ t: last.t, p: last.c }) : b;
      const step = c.barWidth() || 8;
      const out = [{ op: 'line', x1: lp.x, y1: lp.y, x2: b.x, y2: b.y, dash: [4, 4] }];
      for (let i = 1; i <= 4; i += 1) {
        const x = lp.x + step * i;
        out.push({ op: 'line', x1: x, y1: b.y - 8, x2: x, y2: b.y + 8, dash: [3, 3] });
      }
      return out;
    }
    case 'sector': {
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const spread = 0.55;
      return [
        { op: 'arc', cx: a.x, cy: a.y, r: Math.hypot(b.x - a.x, b.y - a.y), a0: ang - spread, a1: ang + spread },
        { op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y },
        { op: 'text', x: a.x + 16, y: a.y - 10, text: `${((spread * 2 * 180) / Math.PI).toFixed(1)}°`, align: 'left' },
      ];
    }
    case 'vwap': {
      const acc = c.vwap(a.x);
      if (!acc.length) return [];
      return [{ op: 'path', pts: acc }, { op: 'line', x1: a.x, y1: top, x2: a.x, y2: top + height }];
    }
    case 'volprofile': {
      const bins = c.volProfile(a.x, b.x);
      if (!bins.length) return [];
      const max = Math.max(...bins.map((b2) => b2.v)) || 1;
      const w = Math.abs(b.x - a.x) || 40;
      return [
        { op: 'rect', x: Math.min(a.x, b.x), y: a.y, w: Math.min(Math.abs(b.y - a.y), c.geom.height), h: 0 },
        ...bins.map((b2) => ({ op: 'rect', x: Math.min(a.x, b.x), y: b2.y, w: (b2.v / max) * w, h: 2 })),
      ];
    }
    case 'pricerange': {
      const y = Math.min(a.y, b.y), h = Math.abs(b.y - a.y);
      const lo = Math.min(p0.p, p1.p), hi = Math.max(p0.p, p1.p);
      return [
        { op: 'rect', x: left, y, w: right - left, h, fill: 0.07 },
        { op: 'text', x: right - 6, y: y + h / 2 + 4, text: (hi - lo).toFixed(2), align: 'right' },
      ];
    }
    case 'daterange': {
      const x = Math.min(a.x, b.x), w = Math.abs(b.x - a.x);
      return [
        { op: 'rect', x, y: top, w, h: height, fill: 0.07 },
        { op: 'text', x: x + w / 2, y: top + 14, text: c.dateLabel(p0.t, p1.t), align: 'center' },
      ];
    }
    default:
      return [];
  }
}

// --- shapes ----------------------------------------------------------------
function shapes(d, c) {
  const [p0, p1] = d.points;
  const a = c.xy(p0), b = c.xy(p1);
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  switch (d.kind) {
    case 'rect':
      return [{ op: 'rect', x, y, w, h }];
    case 'rotrect': {
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const corners = [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]
        .map((q) => rot(q, { x: 0, y: 0 }, ang))
        .map((q) => ({ x: cx + q.x, y: cy + q.y }));
      return [{ op: 'path', pts: corners, close: true }];
    }
    case 'ellipse':
      return [{ op: 'ellipse', cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 }];
    case 'arc':
      return [{ op: 'arc', cx: a.x, cy: a.y, r: Math.hypot(b.x - a.x, b.y - a.y), a0: 0, a1: Math.PI }];
    default:
      return [];
  }
}

// --- annotations -----------------------------------------------------------
function annotations(d, c) {
  const a = c.xy(d.points[0]);
  const text = d.text || (d.kind === 'idea' ? 'Idea' : d.kind === 'post' ? 'Post' : 'Note');
  switch (d.kind) {
    case 'text':
      return [{ op: 'text', x: a.x, y: a.y, text, align: 'left', size: 13 }];
    case 'note':
      return [{ op: 'box', x: a.x, y: a.y, w: 150, h: 44, label: text, variant: d.variant || 'note' }];
    case 'pricenote':
    case 'pricelabel':
      return [
        { op: 'line', x1: a.x, y1: a.y, x2: a.x + 90, y2: a.y },
        { op: 'text', x: a.x + 94, y: a.y + 4, text, align: 'left' },
      ];
    case 'pin': {
      const b2 = c.xy(d.points[1] || d.points[0]);
      return [
        { op: 'line', x1: a.x, y1: a.y, x2: b2.x, y2: b2.y },
        { op: 'path', pts: [{ x: b2.x, y: b2.y - 9 }, { x: b2.x + 7, y: b2.y }, { x: b2.x, y: b2.y + 9 }, { x: b2.x - 7, y: b2.y }], close: true },
      ];
    }
    case 'table':
      return [{ op: 'box', x: a.x, y: a.y, w: 190, h: 90, label: 'Table', variant: 'table' }];
    case 'callout': {
      const b2 = c.xy(d.points[1] || d.points[0]);
      return [
        { op: 'box', x: b2.x, y: b2.y, w: 150, h: 40, label: text, variant: 'callout' },
        { op: 'line', x1: a.x, y1: a.y, x2: b2.x, y2: b2.y },
      ];
    }
    case 'signpost':
    case 'flag': {
      const tip = c.xy(d.points[1] || d.points[0]);
      return [
        { op: 'line', x1: a.x, y1: a.y, x2: tip.x, y2: tip.y },
        { op: 'path', pts: [{ x: tip.x, y: tip.y }, { x: tip.x + 46, y: tip.y + 9 }, { x: tip.x, y: tip.y + 18 }], close: true, fill: 0.2 },
      ];
    }
    case 'image':
      return [{ op: 'box', x: a.x, y: a.y, w: 200, h: 130, label: d.image ? '' : 'Image', variant: 'image', image: d.image }];
    case 'post':
      return [{ op: 'box', x: a.x, y: a.y, w: 200, h: 90, label: text, variant: d.variant || 'post' }];
    case 'icon':
      return [{ op: 'text', x: a.x, y: a.y, text: d.text || '⭐', align: 'left', size: 18 }];
    default:
      return [];
  }
}
// --- brush -----------------------------------------------------------------
function brush(d, c) {
  const P = d.points.map((p) => c.xy(p));
  return [{ op: 'path', pts: P, thick: d.variant === 'highlight' ? 14 : 2 }];
}

// legacy drawing ids (saved layouts) map onto the same builders
const ALIASES = {
  trend: 'segment', prediction: 'segment', horizontal: 'hline', xabcd: 'poly',
  brush: 'brush', icon: 'icon', text: 'text', rect: 'rect', ellipse: 'ellipse',
  fib: 'fib', ray: 'ray',
};

const BUILDERS = {
  segment: lines, ray: lines, infoline: lines, extended: lines, angle: lines, hline: lines,
  hray: lines, vline: lines, crossline: lines, arrow: lines,
  channel: channels, disjoint: channels, flattop: channels, regression: channels, pitchfork: channels,
  fib: fibs, fibext: fibs, fibchannel: fibs, fibtime: fibs, fibfan: fibs, fibtimebased: fibs,
  fibcircles: fibs, fibspiral: fibs, fibarcs: fibs, fibwedge: fibs, pitchfan: fibs,
  gannbox: fibs, gannfan: fibs,
  poly: polys, cyclic: polys, sine: polys,
  position: forecast, barspattern: forecast, ghostfeed: forecast, sector: forecast,
  vwap: forecast, volprofile: forecast, pricerange: forecast, daterange: forecast,
  rect: shapes, rotrect: shapes, ellipse: shapes, arc: shapes,
  text: annotations, note: annotations, pricenote: annotations, pricelabel: annotations,
  pin: annotations, table: annotations, callout: annotations, signpost: annotations,
  flag: annotations, image: annotations, post: annotations, icon: annotations,
  brush,
};

// Build the primitive list for one drawing. `ctx` supplies the projection.
export function buildPrimitives(d, ctx) {
  if (!d || !Array.isArray(d.points) || d.points.length < 1) return [];
  const key = d.kind || d.type;
  const build = BUILDERS[key] || BUILDERS[ALIASES[key]] || BUILDERS.segment;
  let out;
  try {
    out = build(d, ctx) || [];
  } catch {
    return [];
  }
  return out.filter((p) => p && Object.values(p).every((v) => v == null || typeof v !== 'number' || Number.isFinite(v)));
}

export const FIB_LEVELS = FIB;
export const _internals = { lerp, lerpP, rot, sample };
