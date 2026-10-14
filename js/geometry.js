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
    case 'ray': {
      // One-directional ray-cast: parametric a + t*(b-a), t >= 0, clipped to
      // the chart rect. Forward rays end at the right edge (slope-projected);
      // backward rays at the left edge; steep rays at the top/bottom exit.
      if (!a || !b) return [];
      const rdx = b.x - a.x, rdy = b.y - a.y;
      if (!Number.isFinite(rdx) || !Number.isFinite(rdy) || (rdx === 0 && rdy === 0)) return [];
      const ts = [];
      if (rdx > 0) ts.push((right - a.x) / rdx);
      else if (rdx < 0) ts.push((left - a.x) / rdx);
      if (rdy > 0) ts.push((bottom - a.y) / rdy);
      else if (rdy < 0) ts.push((top - a.y) / rdy);
      const pos = ts.filter((t) => t > 0);
      if (!pos.length) return [];
      // Inside origin: nearest boundary is the exit. Outside origin (panned
      // anchor): farthest boundary, so the entry->exit span still paints.
      const inside = a.x >= left && a.x <= right && a.y >= top && a.y <= bottom;
      const t = inside ? Math.min(...pos) : Math.max(...pos);
      return [{ op: 'line', x1: a.x, y1: a.y, x2: a.x + rdx * t, y2: a.y + rdy * t }];
    }
    case 'extended': {
      // Infinite straight line through both anchors, both directions:
      // slope-project to both plot edges (never axis-aligned).
      if (!a || !b) return [];
      const edx = b.x - a.x, edy = b.y - a.y;
      if (!Number.isFinite(edx) || !Number.isFinite(edy)) return [];
      if (Math.hypot(edx, edy) < 1e-9) return [];
      // Vertical anchors (same bar): the infinite line is x = a.x.
      if (Math.abs(edx) < 1e-9) {
        return [{ op: 'line', x1: a.x, y1: top, x2: a.x, y2: bottom }];
      }
      const yL = a.y + (edy * (left - a.x)) / edx;
      const yR = a.y + (edy * (right - a.x)) / edx;
      return [{ op: 'line', x1: left, y1: yL, x2: right, y2: yR }];
    }
    case 'infoline': {
      // Info line: trendline segment plus a stats panel (price change,
      // percent, bars + time, screen angle).
      const p0 = d.points[0], p1 = d.points[1];
      if (!a || !b || !p0 || !p1) return [];
      const dp = p1.p - p0.p;
      const absStr = (dp < 0 ? '' : '+') + (Math.abs(dp) >= 100 ? dp.toFixed(0) : dp.toFixed(2));
      const pct = p0.p !== 0 ? (dp / p0.p) * 100 : 0;
      const pctStr = (pct < 0 ? '' : '+') + pct.toFixed(2) + '%';
      let bars = 0;
      const irows = c.rows || [];
      const vis = c.state && c.state.visible;
      if (irows.length > 1 && vis && Number.isFinite(vis.from) && Number.isFinite(vis.to)
        && Number.isFinite(p0.t) && Number.isFinite(p1.t)) {
        const barMs = (vis.to - vis.from) / irows.length;
        bars = barMs > 0 ? Math.round(Math.abs(p1.t - p0.t) / barMs) : 0;
      } else {
        bars = Math.abs(Math.round((b.x - a.x) / (c.barWidth() || 8)));
      }
      const ang = Math.abs((Math.atan2(a.y - b.y, b.x - a.x) * 180) / Math.PI);
      const label = [`${absStr} (${pctStr})`];
      const barLbl = bars === 1 ? '1 bar' : `${bars} bars`;
      label.push(p0.t === p1.t ? barLbl : `${barLbl} · ${c.dateLabel(p0.t, p1.t)}`);
      label.push(`${ang.toFixed(1)}°`);
      const txt = typeof d.text === 'string' ? d.text.trim() : '';
      if (txt && txt.toLowerCase() !== 'info line' && txt !== 'Info') label.unshift(txt);
      const rows4 = label.slice(0, 4);
      const W = 160, H = rows4.length > 3 ? 74 : 60;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const bx = Math.min(Math.max(mx - W / 2, left + 4), Math.max(left + 4, right - W - 4));
      let by = my - H - 12;
      if (by < top + 4) by = my + 12;
      if (by + H > bottom - 4) by = bottom - H - 4;
      return [
        { op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y },
        { op: 'box', x: bx, y: by, w: W, h: H, label: rows4.join('\n') },
      ];
    }
    case 'angle': {
      // Trend angle: segment plus a small fixed-radius vertex wedge against a
      // horizontal reference, an order-independent 0-90° label, and a slope
      // readout (data-space, zoom-independent).
      const R = 28;
      const ap0 = d.points[0], ap1 = d.points[1];
      if (!a || !b || !ap0 || !ap1) return [];
      if (!Number.isFinite(ap0.p) || !Number.isFinite(ap1.p)) return [];
      const adx = b.x - a.x, ady = b.y - a.y;
      if (!(Math.hypot(adx, ady) >= 2)) return [];
      const angDeg = (Math.atan2(Math.abs(ady), Math.abs(adx)) * 180) / Math.PI;
      const degLabel = (Math.abs(angDeg % 1) < 0.05 ? String(Math.round(angDeg)) : angDeg.toFixed(1)) + '°';
      let ax1 = a.x, ay1 = a.y, ax2 = b.x, ay2 = b.y;
      const ext = typeof d.extend === 'string' ? d.extend : 'none';
      if (ext === 'left' || ext === 'right' || ext === 'both') {
        const m = Math.abs(adx) < 1e-9 ? Infinity : ady / adx;
        if (!Number.isFinite(m)) {
          if (ext === 'left' || ext === 'both') { ax1 = a.x; ay1 = top; }
          if (ext === 'right' || ext === 'both') { ax2 = a.x; ay2 = top + c.geom.height; }
        } else {
          if (ext === 'left' || ext === 'both') { ax1 = left; ay1 = a.y + m * (left - a.x); }
          if (ext === 'right' || ext === 'both') { ax2 = right; ay2 = a.y + m * (right - a.x); }
        }
      }
      const out = [{ op: 'line', x1: ax1, y1: ay1, x2: ax2, y2: ay2 }];
      const dir = adx >= 0 ? 1 : -1;
      const hLen = Math.abs(adx) < 1e-9 ? 46 : Math.min(46, Math.abs(adx));
      out.push({ op: 'line', x1: a.x, y1: a.y, x2: a.x + dir * hLen, y2: a.y });
      const hAng = dir > 0 ? 0 : Math.PI;
      let tAng = Math.atan2(ady, adx);
      if (dir < 0 && tAng < 0) tAng += Math.PI * 2;
      const aa0 = Math.min(hAng, tAng), aa1 = Math.max(hAng, tAng);
      if (aa1 - aa0 > 1e-6) out.push({ op: 'arc', cx: a.x, cy: a.y, r: R, a0: aa0, a1: aa1 });
      const amid = (aa0 + aa1) / 2;
      const cMid = Math.cos(amid);
      out.push({
        op: 'text',
        x: a.x + Math.cos(amid) * (R + 12),
        y: a.y + Math.sin(amid) * (R + 12) + 4,
        text: degLabel,
        align: cMid > 0.3 ? 'left' : cMid < -0.3 ? 'right' : 'center',
      });
      const dP = ap1.p - ap0.p;
      const dPct = ap0.p ? (dP / Math.abs(ap0.p)) * 100 : 0;
      const nBars = Math.max(1, Math.round(Math.abs(adx) / (c.barWidth() || 8)));
      const perBar = dP / nBars;
      const sg = (v, s) => (v >= 0 ? '+' : '') + v.toFixed(2) + s;
      out.push({
        op: 'text',
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2 - 10,
        text: `${sg(dP, '')} (${sg(dPct, '%')}) · ${nBars} bars · ${sg(perBar, '/bar')}`,
        align: 'center',
      });
      return out;
    }
    case 'hline': {
      // Horizontal line: full-width plain line plus a price-axis tag pill
      // docked at the pane's right edge (Style -> Price label, default ON).
      if (!a) return [];
      const out = [
        { op: 'line', x1: left, y1: a.y, x2: right, y2: a.y },
      ];
      let tagW = 0;
      if (d.showPrice !== false) {
        const px = d.points[0]?.p;
        const hlabel = Number.isFinite(px) ? px.toLocaleString('en-US') : '';
        if (hlabel) {
          tagW = Math.max(48, hlabel.length * 7 + 12);
          out.push({ op: 'box', x: right - tagW, y: a.y - 9, w: tagW, h: 18, label: hlabel });
        }
      }
      if (typeof d.text === 'string' && d.text.trim() !== '') {
        const align = d.textAlign === 'left' || d.textAlign === 'right' ? d.textAlign : 'center';
        const hx = align === 'left' ? left + 6 : align === 'right' ? right - tagW - 8 : (left + right) / 2;
        out.push({ op: 'text', x: hx, y: a.y - 6, text: d.text, align });
      }
      return out;
    }
    case 'hray': {
      // Horizontal ray: plain solid line from the anchor to the right edge
      // (left-to-right only) plus a right-edge price tag (default ON).
      const hp0 = d.points[0];
      if (!hp0 || !Number.isFinite(hp0.p)) return [];
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const hx1 = Math.max(a.x, left);
      const out = [];
      if (hx1 < right) out.push({ op: 'line', x1: hx1, y1: a.y, x2: right, y2: a.y });
      else if (a.y < top || a.y > bottom) return [];
      out.push({ op: 'text', x: right - 6, y: a.y + 4, text: Number(hp0.p).toLocaleString('en-US', { maximumFractionDigits: 2 }), align: 'right' });
      if (d.text) out.push({ op: 'text', x: (Math.max(a.x, left) + right) / 2, y: a.y - 6, text: d.text, align: 'center' });
      return out.length ? out : [];
    }
    case 'vline': {
      // Vertical line: full-height plain line plus a time-axis date pill
      // pinned to the chart's bottom edge (Time Label, default ON).
      const vp0 = d.points[0];
      if (!a || !vp0 || !Number.isFinite(vp0.t)) return [];
      const out = [{ op: 'line', x1: a.x, y1: top, x2: a.x, y2: bottom }];
      const dt = new Date(vp0.t);
      if (Number.isFinite(dt.getTime()) && a.x >= left - 1 && a.x <= right + 1) {
        const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const pad = (n) => String(n).padStart(2, '0');
        let vlabel = `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} '${String(dt.getUTCFullYear()).slice(2)}`;
        if (dt.getUTCHours() || dt.getUTCMinutes()) vlabel += ` ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
        const vh = 20;
        const vw = Math.min(160, Math.max(48, vlabel.length * 7 + 16));
        const vbx = Math.min(Math.max(a.x - vw / 2, left + 1), Math.max(left + 1, right - vw - 1));
        out.push({ op: 'box', x: vbx, y: bottom - vh, w: vw, h: vh, label: vlabel });
      }
      const caption = typeof d.text === 'string' ? d.text.trim() : '';
      if (caption) {
        const flip = a.x + 8 + (caption.length * 7 + 8) > right;
        out.push({ op: 'text', x: flip ? a.x - 6 : a.x + 6, y: top + 14, text: caption, align: flip ? 'right' : 'left', size: 11 });
      }
      return out;
    }
    case 'crossline': {
      // Cross line: full-span perpendiculars, a reference ring at the
      // crossing, and price + time axis tags (default ON).
      const cp0 = d.points && d.points[0];
      if (!cp0 || !Number.isFinite(cp0.p) || !Number.isFinite(cp0.t)) return [];
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const cdash = Array.isArray(d.dash) ? d.dash : undefined;
      const clineDash = cdash ? { dash: cdash } : {};
      const out = [
        { op: 'line', x1: left, y1: a.y, x2: right, y2: a.y, ...clineDash },
        { op: 'line', x1: a.x, y1: top, x2: a.x, y2: bottom, ...clineDash },
        { op: 'ellipse', cx: a.x, cy: a.y, rx: 4, ry: 4 },
      ];
      if (d.showLabels === false) return out;
      const ap = Math.abs(cp0.p);
      let px = '';
      if (ap >= 1000) px = Math.round(cp0.p).toLocaleString('en-US');
      else if (ap >= 1) px = cp0.p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      else px = cp0.p.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
      let tm = '';
      const cdt = new Date(cp0.t);
      if (!Number.isNaN(cdt.getTime())) {
        const iso = cdt.toISOString();
        const md = iso.slice(5, 10);
        const hm = iso.slice(11, 16);
        tm = hm === '00:00' ? md : `${md} ${hm}`;
      }
      if (px && a.y >= top && a.y <= bottom) {
        const wP = Math.min(110, Math.max(52, px.length * 7 + 14));
        out.push({ op: 'box', x: right - wP, y: Math.min(Math.max(a.y - 9, top), bottom - 18), w: wP, h: 18, label: px });
      }
      if (tm && a.x >= left && a.x <= right) {
        const wT = Math.min(110, Math.max(56, tm.length * 7 + 14));
        out.push({ op: 'box', x: Math.min(Math.max(a.x - wT / 2, left), Math.max(left, right - wT)), y: bottom - 18, w: wT, h: 18, label: tm });
      }
      return out;
    }
    case 'arrow': {
      // Variants: default end-head | marker (directional head, no shaft) |
      // up / down (fixed-orientation triangle, no shaft). Heads are explicit
      // filled triangles so no `arrows` flag is emitted and the overlay's
      // generic head never double-paints.
      if (!a || !b || ![a.x, a.y, b.x, b.y].every(Number.isFinite)) return [];
      const v = d.variant || 'default';
      if (v === 'up' || v === 'down') {
        const S = 8, H = 12, s = v === 'up' ? 1 : -1;
        return [{
          op: 'path',
          pts: [{ x: b.x, y: b.y }, { x: b.x + S, y: b.y + s * H }, { x: b.x - S, y: b.y + s * H }],
          close: true, fill: 1,
        }];
      }
      const adx = b.x - a.x, ady = b.y - a.y;
      const alen = Math.hypot(adx, ady);
      if (!(alen >= 1)) return [];
      const ux = adx / alen, uy = ady / alen, nx = -uy, ny = ux;
      const L0 = v === 'marker' ? 16 : 14, W0 = v === 'marker' ? 7 : 6;
      const L = Math.min(L0, alen * 0.9), W = W0 * (L / L0);
      const amx = b.x - ux * L, amy = b.y - uy * L;
      const head = {
        op: 'path',
        pts: [{ x: b.x, y: b.y }, { x: amx + nx * W, y: amy + ny * W }, { x: amx - nx * W, y: amy - ny * W }],
        close: true, fill: 1,
      };
      if (v === 'marker') return [head];
      return [{ op: 'line', x1: a.x, y1: a.y, x2: amx, y2: amy }, head];
    }
    default: {
      // `segment` serves tool `trend` and legacy type `prediction`: solid leg,
      // optional slope-projected extension, caption, and (when selected)
      // midpoint dot plus a price/bars/angle/date stats panel.
      const sp0 = d.points[0], sp1 = d.points[1];
      if (!a || !b) return [];
      if (!sp0 || !sp1 || !Number.isFinite(sp0.p) || !Number.isFinite(sp1.p)) return [];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1) return [];
      const out = [];
      const g = c.geom;
      const isPred = d.type === 'prediction';
      const sdx = b.x - a.x, sdy = b.y - a.y;
      const atX = (x) => (Math.abs(sdx) < 1e-9 ? a.y : a.y + (sdy * (x - a.x)) / sdx);
      const sdash = Array.isArray(d.dash) ? d.dash : undefined;
      const sarrows = typeof d.arrows === 'string'
        ? d.arrows
        : (d.arrowRight && d.arrowLeft ? 'both' : (d.arrowRight ? 'end' : undefined));
      const sheaded = (!sdash && sarrows) ? { arrows: sarrows } : {};
      const sext = isPred
        ? (d.extend === 'both' || d.extend === 'left' ? 'both' : 'right')
        : (d.extend || 'none');
      if (isPred) {
        out.push({ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...(sdash ? { dash: sdash } : {}), ...sheaded });
        const cands = [];
        if (Math.abs(sdx) > 1e-9) {
          const t = (sdx > 0 ? (g.right - b.x) : (g.left - b.x)) / sdx;
          if (t > 0) cands.push(t);
        }
        if (Math.abs(sdy) > 1e-9) {
          const t = (sdy > 0 ? (g.bottom - b.y) : (g.top - b.y)) / sdy;
          if (t > 0) cands.push(t);
        }
        if (cands.length) {
          const t = Math.min(...cands);
          const ex = b.x + sdx * t, ey = b.y + sdy * t;
          if (ex >= g.left - 1 && ex <= g.right + 1 && ey >= g.top - 1 && ey <= g.bottom + 1) {
            out.push({ op: 'line', x1: b.x, y1: b.y, x2: ex, y2: ey, dash: [5, 4] });
          }
        }
        if (sext === 'both') out.push({ op: 'line', x1: g.left, y1: atX(g.left), x2: a.x, y2: a.y, ...(sdash ? { dash: sdash } : {}) });
      } else if (sext === 'none') {
        out.push({ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...(sdash ? { dash: sdash } : {}), ...sheaded });
      } else {
        let sx1 = a.x, sy1 = a.y, sx2 = b.x, sy2 = b.y;
        if (Math.abs(sdx) < 1e-9) { sx1 = a.x; sx2 = a.x; sy1 = g.top; sy2 = g.bottom; }
        else {
          if (sext === 'left' || sext === 'both') { sx1 = g.left; sy1 = atX(g.left); }
          if (sext === 'right' || sext === 'both') { sx2 = g.right; sy2 = atX(g.right); }
        }
        out.push({ op: 'line', x1: sx1, y1: sy1, x2: sx2, y2: sy2, ...(sdash ? { dash: sdash } : {}), ...sheaded });
      }
      if (typeof d.text === 'string' && d.text) {
        const smx = (a.x + b.x) / 2, smy = (a.y + b.y) / 2;
        out.push({
          op: 'text',
          x: Math.min(Math.max(smx, g.left + 4), g.right - 4),
          y: Math.min(Math.max(smy + 16, g.top + 12), g.bottom - 4),
          text: d.text, align: 'center',
        });
      }
      const sel = !!(c.state && c.state.selectedId === d.id);
      if (sel || d.alwaysShowStats === true) {
        const smx = (a.x + b.x) / 2, smy = (a.y + b.y) / 2;
        out.push({ op: 'ellipse', cx: smx, cy: smy, rx: 3, ry: 3 });
        const sdp = Math.abs(sp1.p - sp0.p), sbase = Math.abs(sp0.p);
        const sdec = sdp >= 100 ? 0 : 2;
        const ssgn = sp1.p > sp0.p ? '+' : (sp1.p < sp0.p ? '-' : '');
        const sfmt = (vv) => vv.toLocaleString('en-US', { minimumFractionDigits: sdec, maximumFractionDigits: sdec });
        const spct = sbase > 0 ? (sdp / sbase) * 100 : 0;
        const sL1 = `${ssgn}${sfmt(sdp)} (${ssgn}${spct.toFixed(2)}%)`;
        let sbars = 0;
        const srows = Array.isArray(c.rows) ? c.rows : [];
        if (Number.isFinite(sp0.t) && Number.isFinite(sp1.t) && srows.length) {
          const si0 = srows.findIndex((r) => r && r.t === sp0.t);
          const si1 = srows.findIndex((r) => r && r.t === sp1.t);
          if (si0 >= 0 && si1 >= 0) sbars = Math.abs(si1 - si0);
          else {
            const sts = srows.map((r) => r.t).filter(Number.isFinite).sort((x, y) => x - y);
            const step = sts.length > 1 ? (sts[sts.length - 1] - sts[0]) / Math.max(1, sts.length - 1) : 0;
            sbars = step > 0 ? Math.round(Math.abs(sp1.t - sp0.t) / step) : 0;
          }
        } else {
          const bw = (c.barWidth && c.barWidth()) || 8;
          sbars = Math.max(1, Math.round(Math.abs(b.x - a.x) / Math.max(1, bw)));
        }
        const sang = (Math.atan2(Math.abs(a.y - b.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
        const statLines = [sL1, `${sbars} bars, ${sang.toFixed(1)}°`];
        if (Number.isFinite(sp0.t) && Number.isFinite(sp1.t) && sp0.t !== sp1.t && c.dateLabel) {
          statLines.push(c.dateLabel(sp0.t, sp1.t));
        }
        const slabel = statLines.slice(0, 4).join('\n');
        const slongest = Math.max(...statLines.map((s) => s.length));
        const sw = Math.min(240, Math.max(120, Math.round(slongest * 6.8 + 20)));
        const sh = 18 + (statLines.length - 1) * 14 + 12;
        const sbx = Math.min(Math.max(smx - sw / 2, g.left + 4), g.right - sw - 4);
        let sby = smy - sh - 10;
        if (sby < g.top + 4) sby = smy + 12;
        sby = Math.min(Math.max(sby, g.top + 4), g.bottom - sh - 4);
        out.push({ op: 'box', x: Math.round(sbx), y: Math.round(sby), w: sw, h: sh, label: slabel });
      }
      return out;
    }
  }
}

// --- channels / forks ------------------------------------------------------
function channels(d, c) {
  const P = d.points.map((p) => c.xy(p));
  const [a, b] = P;
  if (d.kind === 'channel') {
    // Parallel Channel: P1->P2 is the base (level 0), P3 sets the parallel
    // offset (level 1). Both outers and the dashed median extend right to
    // the chart edge.
    const off = P[2];
    if (!a || !b || !off) return [];
    const cdx = b.x - a.x, cdy = b.y - a.y;
    if (Math.hypot(cdx, cdy) < 1e-9) return [];
    const q2 = { x: off.x + cdx, y: off.y + cdy };
    const cmid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    const m1 = cmid(a, off);
    const cright = c.geom.right;
    if (!Number.isFinite(cright) || Math.abs(cdx) < 1e-9) {
      const m2 = cmid(b, q2);
      return [
        { op: 'path', pts: [a, b, q2, off], close: true, fill: 0.1 },
        { op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y },
        { op: 'line', x1: off.x, y1: off.y, x2: q2.x, y2: q2.y },
        { op: 'line', x1: m1.x, y1: m1.y, x2: m2.x, y2: m2.y, dash: [5, 4] },
      ];
    }
    const e1 = { x: cright, y: a.y + ((cright - a.x) / cdx) * cdy };
    const e2 = { x: cright, y: off.y + ((cright - off.x) / cdx) * cdy };
    const m2 = cmid(e1, e2);
    return [
      { op: 'path', pts: [a, e1, e2, off], close: true, fill: 0.1 },
      { op: 'line', x1: a.x, y1: a.y, x2: e1.x, y2: e1.y },
      { op: 'line', x1: off.x, y1: off.y, x2: e2.x, y2: e2.y },
      { op: 'line', x1: m1.x, y1: m1.y, x2: m2.x, y2: m2.y, dash: [5, 4] },
    ];
  }
  if (d.kind === 'disjoint') {
    // Disjoint Channel: two parallel rails; rail 2 starts at P3's time and
    // runs the same vector as rail 1. Both rails slope-project right.
    if (!a || !b || !P[2]) return [];
    const o = P[2];
    if (![a.x, a.y, b.x, b.y, o.x, o.y].every(Number.isFinite)) return [];
    const ddx = b.x - a.x, ddy = b.y - a.y;
    if (Math.hypot(ddx, ddy) < 0.5) return [];
    const dright = c.geom && c.geom.right;
    if (Math.abs(ddx) <= 1e-9 || !Number.isFinite(dright)) {
      const oEnd = { x: o.x + ddx, y: o.y + ddy };
      return [
        { op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y },
        { op: 'line', x1: o.x, y1: o.y, x2: oEnd.x, y2: oEnd.y },
        { op: 'path', pts: [a, b, oEnd, o], close: true, fill: 0.08 },
      ];
    }
    const dm = ddy / ddx;
    const dyAt = (p, x) => p.y + dm * (x - p.x);
    const oEnd = { x: o.x + ddx, y: o.y + ddy };
    const l1 = a.x <= b.x ? a : b;
    const l2 = o.x <= oEnd.x ? o : oEnd;
    const r1 = { x: dright, y: dyAt(b, dright) };
    const r2 = { x: dright, y: dyAt(oEnd, dright) };
    return [
      { op: 'line', x1: l1.x, y1: l1.y, x2: r1.x, y2: r1.y },
      { op: 'line', x1: l2.x, y1: l2.y, x2: r2.x, y2: r2.y },
      { op: 'path', pts: [l1, r1, r2, l2], close: true, fill: 0.08 },
    ];
  }
  if (d.kind === 'flattop') {
    // Flat Top/Bottom: one flat boundary at the 3rd anchor's price plus one
    // slope-projected angled side, both running to the right chart edge,
    // with a wedge fill and both boundary price labels.
    const e = P[2];
    if (!a || !b || !e) return [];
    const { right } = c.geom;
    const fdx = b.x - a.x;
    const x0 = Math.min(a.x, b.x);
    const flatY = e.y;
    let yA0;
    let yA1;
    if (Math.abs(fdx) < 0.5) {
      yA0 = a.y;
      yA1 = b.y;
    } else {
      const slope = (b.y - a.y) / fdx;
      yA0 = a.y + slope * (x0 - a.x);
      yA1 = a.y + slope * (right - a.x);
    }
    const ffmt = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const out = [
      { op: 'line', x1: x0, y1: flatY, x2: right, y2: flatY },
      { op: 'line', x1: x0, y1: yA0, x2: right, y2: yA1 },
      {
        op: 'path',
        pts: [{ x: x0, y: yA0 }, { x: right, y: yA1 }, { x: right, y: flatY }, { x: x0, y: flatY }],
        close: true,
        fill: 0.08,
      },
      { op: 'text', x: right - 4, y: flatY - 4, text: ffmt(d.points[2].p), align: 'right' },
      { op: 'text', x: right - 4, y: yA1 + 12, text: ffmt(d.points[1].p), align: 'right' },
    ];
    if (d.text) {
      out.push({
        op: 'text',
        x: (Math.min(a.x, b.x) + Math.max(a.x, b.x)) / 2,
        y: ((a.y + b.y) / 2 + flatY) / 2,
        text: d.text,
        align: 'center',
      });
    }
    return out;
  }
  if (d.kind === 'regression') {
    // Regression Trend: least-squares base through the window's bars with
    // symmetric ±2σ dashed bands, all slope-projected across the full chart
    // width, plus σ tags and a Pearson-R readout.
    if (!a || !b) return [];
    const { left, right, top, height } = c.geom || {};
    if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) return [];
    const stats = regression(c, a, b, d.source);
    if (!stats) return [];
    const kUp = Number.isFinite(+d.upperDeviation) ? +d.upperDeviation
      : Number.isFinite(+d.upperDev) ? +d.upperDev : 2;
    const kDn = Number.isFinite(+d.lowerDeviation) ? +d.lowerDeviation
      : Number.isFinite(+d.lowerDev) ? +d.lowerDev : 2;
    const band = stats.sd > 0;
    const showBase = d.showBase !== false;
    const showUp = band && d.showUpper !== false && d.useUpper !== false && kUp > 0;
    const showDn = band && d.showLower !== false && d.useLower !== false && kDn > 0;
    const extend = d.extend !== false;
    const x0 = extend ? left : Math.min(a.x, b.x);
    const x1 = extend ? right : Math.max(a.x, b.x);
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return [];
    const { at, sd, r } = stats;
    const mid0 = at(x0), mid1 = at(x1);
    const up0 = mid0 - kUp * sd, up1 = mid1 - kUp * sd;
    const dn0 = mid0 + kDn * sd, dn1 = mid1 + kDn * sd;
    const rout = [];
    if (d.showBands !== false) {
      if (showUp) rout.push({ op: 'path', pts: [{ x: x0, y: mid0 }, { x: x1, y: mid1 }, { x: x1, y: up1 }, { x: x0, y: up0 }], close: true, fill: 0.06 });
      if (showDn) rout.push({ op: 'path', pts: [{ x: x0, y: mid0 }, { x: x1, y: mid1 }, { x: x1, y: dn1 }, { x: x0, y: dn0 }], close: true, fill: 0.06 });
    }
    if (showBase) rout.push({ op: 'line', x1: x0, y1: mid0, x2: x1, y2: mid1 });
    if (showUp) rout.push({ op: 'line', x1: x0, y1: up0, x2: x1, y2: up1, dash: [5, 4] });
    if (showDn) rout.push({ op: 'line', x1: x0, y1: dn0, x2: x1, y2: dn1, dash: [5, 4] });
    const pin = Number.isFinite(top) && Number.isFinite(height)
      ? (y) => Math.min(top + height - 8, Math.max(top + 10, y)) : (y) => y;
    if (showUp) rout.push({ op: 'text', x: x1 - 6, y: pin(up1) - 4, text: `+${kUp}σ`, align: 'right' });
    if (showDn) rout.push({ op: 'text', x: x1 - 6, y: pin(dn1) + 12, text: `-${kDn}σ`, align: 'right' });
    if (d.showR !== false && d.pearson !== false && Number.isFinite(r)) {
      const rmx = (a.x + b.x) / 2;
      rout.push({ op: 'text', x: rmx, y: pin(at(rmx)) - 8, text: `R ${r.toFixed(2)}`, align: 'center' });
    }
    return rout;
  }
  // pitchfork family (kind 'pitchfork', d.variant selects behavior):
  // median O->E plus two parallels sharing the exact direction vector,
  // all slope-projected to the right plot edge. Midpoints are screen-space
  // (pixel averages) so forks stay visually correct on any scale.
  //   standard: O=P0 -> M=mid(P1,P2), tines through P1,P2
  //   schiff:   O=(x0, mid_y(P0,P1)) -> M, tines through P1,P2
  //   modified: O=mid(P0,P1) -> M, tines through P1,P2
  //   inside:   O=mid(P0,P1) -> P2, tines through P0,P1 (symmetric)
  const p2 = P[2];
  if (!a || !b || !p2) return [];
  const { right, top, bottom } = c.geom;
  const mid2 = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  const M = mid2(b, p2);
  const O12 = mid2(a, b);
  let O, E, Q1, Q2;
  if (d.variant === 'schiff') {
    O = { x: a.x, y: (a.y + b.y) / 2 };
    E = M; Q1 = b; Q2 = p2;
  } else if (d.variant === 'modified') {
    O = O12;
    E = M; Q1 = b; Q2 = p2;
  } else if (d.variant === 'inside') {
    O = O12;
    E = p2; Q1 = a; Q2 = b;
  } else {
    O = a;
    E = M; Q1 = b; Q2 = p2;
  }
  const pdx = E.x - O.x, pdy = E.y - O.y;
  if (!Number.isFinite(pdx) || !Number.isFinite(pdy)) return [];
  if (Math.hypot(pdx, pdy) < 1e-9) return [];
  const EPS = 1e-6;
  if (Math.abs(pdx) < EPS) {
    // Vertical median: full-height parallel strokes + strip fill.
    const xs = [O.x, Q1.x, Q2.x];
    return [
      { op: 'path', pts: [{ x: Q1.x, y: top }, { x: Q2.x, y: top }, { x: Q2.x, y: bottom }, { x: Q1.x, y: bottom }], close: true, fill: 0.06 },
      ...xs.map((x) => ({ op: 'line', x1: x, y1: top, x2: x, y2: bottom })),
    ];
  }
  const projectRight = (S) => {
    const t = (right - S.x) / pdx;
    return { x: right, y: S.y + pdy * t };
  };
  const mEnd = projectRight(O);
  const q1End = projectRight(Q1);
  const q2End = projectRight(Q2);
  return [
    { op: 'path', pts: [Q1, q1End, q2End, Q2], close: true, fill: 0.06 },
    { op: 'line', x1: O.x, y1: O.y, x2: mEnd.x, y2: mEnd.y },
    { op: 'line', x1: Q1.x, y1: Q1.y, x2: q1End.x, y2: q1End.y },
    { op: 'line', x1: Q2.x, y1: Q2.y, x2: q2End.x, y2: q2End.y },
  ];
}

// Least-squares fit through the bars between two screen positions.
// Pixel-space fit (x = bar screen x, y = source-price screen y). Anchor prices
// are ignored — only anchor times (screen x) define the window. Returns the
// line evaluator, population residual sd (px), Pearson r, and bar count;
// null when the window holds fewer than 2 fittable bars.
function regression(c, a, b, source) {
  const rows = c.window(a.x, b.x);
  if (!rows || rows.length < 2) return null;
  const src = source || 'close';
  const priceOf = (r) => {
    switch (src) {
      case 'open': return r.o;
      case 'high': return r.h;
      case 'low': return r.l;
      case 'hl2': return (r.h + r.l) / 2;
      case 'hlc3': return (r.h + r.l + r.c) / 3;
      case 'ohlc4': return (r.o + r.h + r.l + r.c) / 4;
      case 'close':
      default: return Number.isFinite(r.c) ? r.c : (r.h + r.l) / 2;
    }
  };
  const pts = [];
  for (const r of rows) {
    const p = priceOf(r);
    if (!Number.isFinite(p)) continue;
    pts.push({ x: c.xForRow(r), y: c.yForPrice(p) });
  }
  if (pts.length < 2) return null;
  const n = pts.length;
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) {
    const pdx = p.x - mx, pdy = p.y - my;
    sxy += pdx * pdy; sxx += pdx * pdx; syy += pdy * pdy;
  }
  const slope = sxx ? sxy / sxx : 0;
  const at = (x) => my + slope * (x - mx);
  let se = 0;
  for (const p of pts) se += (p.y - at(p.x)) ** 2;
  const sd = Math.sqrt(se / n);
  if (!Number.isFinite(sd)) return null;
  const r = (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : 0;
  return { at, sd, r: Number.isFinite(r) ? r : 0, n };
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
    case 'fib': {
      // Fib Retracement: trend segment plus direction-aware levels with
      // ratio + price labels, extended right to the chart edge. Level 0
      // sits at the END anchor, level 1 at the START anchor.
      const rev = d.reverse === true || d.variant === 'reverse';
      const fpA = d.points[0] && d.points[0].p;
      const fpB = d.points[1] && d.points[1].p;
      if (!Number.isFinite(fpA) || !Number.isFinite(fpB)) break;
      if (!a || !b) break;
      const fxL = Math.min(a.x, b.x);
      const fmtPx = (p) => {
        if (!Number.isFinite(p)) return '';
        const m = Math.abs(p);
        if (m >= 1000) return Math.round(p).toLocaleString('en-US');
        if (m >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return p.toLocaleString('en-US', { maximumFractionDigits: 4 });
      };
      out.push({ op: 'rect', x: Math.min(a.x, b.x), y: lo, w: Math.abs(b.x - a.x), h: hi - lo, fill: 0.07 });
      for (const lv of FIB) {
        const eff = rev ? 1 - lv : lv;
        const price = fpB + (fpA - fpB) * eff;
        const yLv = b.y + (a.y - b.y) * eff;
        out.push({ op: 'line', x1: fxL, y1: yLv, x2: right, y2: yLv });
        out.push({ op: 'text', x: right - 4, y: yLv + 3, text: `${String(lv)} (${fmtPx(price)})`, align: 'right' });
      }
      out.push({ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      break;
    }
    case 'fibext': {
      // Trend-Based Fib Extension (TV: A=start, B=end of impulse, C=end of
      // retracement; price = C + (B - A) * ratio, signed so downtrends project
      // downward). This rail places 2 anchors (A,B); an optional third anchor
      // is honoured as C when present, else C=B. Level 0 sits on C.
      const rev = d.reverse === true || d.variant === 'reverse';
      const fpA = d.points[0] && d.points[0].p;
      const fpB = d.points[1] && d.points[1].p;
      const hasC = d.points.length > 2 && d.points[2] && Number.isFinite(d.points[2].p);
      const fpC = hasC ? d.points[2].p : fpB;
      if (!Number.isFinite(fpA) || !Number.isFinite(fpB) || !Number.isFinite(fpC)) break;
      if (!a || !b) break;
      const o = hasC ? c.xy(d.points[2]) : null;
      const impulse = (rev ? -1 : 1) * (fpB - fpA);
      const fmtPx = (p) => {
        if (!Number.isFinite(p)) return '';
        const m = Math.abs(p);
        if (m >= 1000) return Math.round(p).toLocaleString('en-US');
        if (m >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return p.toLocaleString('en-US', { maximumFractionDigits: 4 });
      };
      const pxImpulse = (rev ? -1 : 1) * (b.y - a.y);
      const baseY = o ? o.y : b.y;
      const yOf = (lv) => {
        const price = fpC + impulse * lv;
        if (typeof c.yForPrice === 'function') {
          const y = c.yForPrice(price);
          if (Number.isFinite(y)) return y;
        }
        return baseY + pxImpulse * lv;
      };
      const xs = o ? [a.x, b.x, o.x] : [a.x, b.x];
      const ys = o ? [a.y, b.y, o.y] : [a.y, b.y];
      if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) break;
      const ex0 = Math.min(...xs), ex1 = Math.max(...xs);
      const eyT = Math.min(...ys), eyB = Math.max(...ys);
      if (ex1 > ex0 && eyB > eyT) out.push({ op: 'rect', x: ex0, y: eyT, w: ex1 - ex0, h: eyB - eyT, fill: 0.07 });
      for (const lv of EXT) {
        const price = fpC + impulse * lv;
        const yLv = yOf(lv);
        if (!Number.isFinite(yLv) || !Number.isFinite(price)) continue;
        out.push({ op: 'line', x1: ex0, y1: yLv, x2: right, y2: yLv });
        out.push({ op: 'text', x: right - 4, y: yLv + 3, text: `${String(lv)} (${fmtPx(price)})`, align: 'right' });
      }
      out.push({ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      if (o) out.push({ op: 'line', x1: b.x, y1: b.y, x2: o.x, y2: o.y, dash: [4, 3] });
      break;
    }
    case 'fibchannel': {
      // Fib Channel: P0->P1 is the base trendline (level 0); P2 sets the
      // parallel offset (level 1). Every level is a slope-projected parallel
      // of the base through S(lv) = A + lv*(O-A), extended per d.extend
      // ('right' default), with a base-band fill and ratio + price labels.
      const p2 = d.points[2];
      const o = p2 ? c.xy(p2) : null;
      if (!a || !b || !o) break;
      if (![a.x, a.y, b.x, b.y, o.x, o.y].every(Number.isFinite)) break;
      const fcdx = b.x - a.x, fcdy = b.y - a.y;
      if (Math.hypot(fcdx, fcdy) < 1e-9) break;
      const fg = c.geom;
      const fgtop = fg.top, fgbottom = fg.top + fg.height;
      const CH = FIB.concat([1.618, 2.618]);
      const lvSet = Array.isArray(d.levels)
        ? d.levels.filter((vv) => typeof vv === 'number' && Number.isFinite(vv))
        : null;
      const fclevels = lvSet && lvSet.length ? lvSet : CH;
      const vx = o.x - a.x, vy = o.y - a.y;
      const S = (lv) => ({ x: a.x + vx * lv, y: a.y + vy * lv });
      const ext = typeof d.extend === 'string' ? d.extend : 'right';
      const fdash = Array.isArray(d.dash) ? { dash: d.dash } : {};
      const pr = c.state && c.state.price;
      const canPrice = pr && Number.isFinite(pr.min) && Number.isFinite(pr.max)
        && pr.max > pr.min && Number.isFinite(fg.height) && fg.height > 0;
      const priceForY = (y) => pr.max - (((y - fg.top) / fg.height) * (pr.max - pr.min));
      const fmtPx = (p) => {
        if (!Number.isFinite(p)) return '';
        const mm = Math.abs(p);
        if (mm >= 1000) return Math.round(p).toLocaleString('en-US');
        if (mm >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return p.toLocaleString('en-US', { maximumFractionDigits: 4 });
      };
      const usePct = d.percent === true || d.levelMode === 'percent';
      const fmtLv = (lv) => {
        if (!usePct) return String(lv);
        return `${Math.round(lv * 1000) / 10}%`;
      };
      const showLv = d.showLevels !== false;
      const showPx = d.showPrices !== false;
      const assemble = (lv, yRef) => {
        if (!showLv && !showPx) return '';
        if (showLv && showPx) {
          const s = canPrice ? fmtPx(priceForY(yRef)) : '';
          return s ? `${fmtLv(lv)} (${s})` : fmtLv(lv);
        }
        if (showLv) return fmtLv(lv);
        return canPrice ? fmtPx(priceForY(yRef)) : '';
      };
      const pin = (y) => Math.min(fgbottom - 8, Math.max(fgtop + 10, y));
      const widthPx = Math.abs(fcdx * vy - fcdy * vx) / Math.hypot(fcdx, fcdy);
      if (!(widthPx >= 0.5)) {
        if (Math.abs(fcdx) < 1e-9) {
          out.push({ op: 'line', x1: a.x, y1: Math.min(a.y, b.y), x2: a.x, y2: Math.max(a.y, b.y), ...fdash });
        } else {
          let zx0 = Math.min(a.x, b.x), zx1 = Math.max(a.x, b.x);
          if (ext === 'left' || ext === 'both') zx0 = left;
          if (ext === 'right' || ext === 'both') zx1 = right;
          if (zx1 > zx0) {
            out.push({
              op: 'line',
              x1: zx0, y1: a.y + (((zx0 - a.x) / fcdx) * fcdy),
              x2: zx1, y2: a.y + (((zx1 - a.x) / fcdx) * fcdy),
              ...fdash,
            });
          }
        }
        break;
      }
      if (Math.abs(fcdx) < 1e-9) {
        const full = ext === 'left' || ext === 'right' || ext === 'both';
        const s0 = S(0), s1 = S(1);
        const bandY = [s0.y, s0.y + fcdy, s1.y, s1.y + fcdy].filter(Number.isFinite);
        if (d.showBackground !== false && bandY.length === 4) {
          const fx0 = Math.min(s0.x, s1.x), fx1 = Math.max(s0.x, s1.x);
          const fy0 = full ? fgtop : Math.min(...bandY);
          const fy1 = full ? fgbottom : Math.max(...bandY);
          if (fx1 > fx0 && fy1 > fy0) {
            out.push({ op: 'path', pts: [{ x: fx0, y: fy0 }, { x: fx1, y: fy0 }, { x: fx1, y: fy1 }, { x: fx0, y: fy1 }], close: true, fill: 0.08 });
          }
        }
        for (const lv of fclevels) {
          const s = S(lv);
          if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
          const ya = full ? fgtop : Math.min(s.y, s.y + fcdy);
          const yb = full ? fgbottom : Math.max(s.y, s.y + fcdy);
          if (!(yb > ya)) continue;
          out.push({ op: 'line', x1: s.x, y1: ya, x2: s.x, y2: yb, ...fdash });
          const vlabel = assemble(lv, ya);
          if (!vlabel) continue;
          const estW = vlabel.length * 7 + 4;
          const ltr = s.x + 4 + estW <= right;
          out.push({ op: 'text', x: ltr ? s.x + 4 : s.x - 4, y: Math.min(ya + 12, fgbottom - 4), text: vlabel, align: ltr ? 'left' : 'right' });
        }
        break;
      }
      let fx0 = Math.min(a.x, b.x, o.x), fx1 = Math.max(a.x, b.x, o.x);
      if (ext === 'left' || ext === 'both') fx0 = left;
      if (ext === 'right' || ext === 'both') fx1 = right;
      if (!(fx1 > fx0)) break;
      const fm = fcdy / fcdx;
      const yAt = (lv, x) => { const s = S(lv); return s.y + fm * (x - s.x); };
      if (d.showBackground !== false) {
        const f0a = { x: fx0, y: yAt(0, fx0) }, f0b = { x: fx1, y: yAt(0, fx1) };
        const f1b = { x: fx1, y: yAt(1, fx1) }, f1a = { x: fx0, y: yAt(1, fx0) };
        if ([f0a.y, f0b.y, f1b.y, f1a.y].every(Number.isFinite)) {
          out.push({ op: 'path', pts: [f0a, f0b, f1b, f1a], close: true, fill: 0.08 });
        }
      }
      for (const lv of fclevels) {
        const ya = yAt(lv, fx0), yb = yAt(lv, fx1);
        if (!Number.isFinite(ya) || !Number.isFinite(yb)) continue;
        out.push({ op: 'line', x1: fx0, y1: ya, x2: fx1, y2: yb, ...fdash });
      }
      if (showLv || showPx) {
        const falign = d.labelAlign === 'left' ? 'left' : d.labelAlign === 'center' ? 'center' : 'right';
        for (const lv of fclevels) {
          const lx = falign === 'left' ? fx0 + 4 : falign === 'center' ? (fx0 + fx1) / 2 : fx1 - 4;
          const ly = yAt(lv, lx);
          if (!Number.isFinite(ly)) continue;
          const flabel = assemble(lv, ly);
          if (!flabel) continue;
          out.push({ op: 'text', x: lx, y: pin(ly) + 3, text: flabel, align: falign });
        }
      }
      if (typeof d.text === 'string' && d.text.trim() !== '') {
        const fmx = (fx0 + fx1) / 2;
        out.push({ op: 'text', x: fmx, y: (yAt(0, fmx) + yAt(1, fmx)) / 2, text: d.text.trim(), align: 'center' });
      }
      break;
    }
    case 'fibtime': {
      // Fib Time Zone: the anchor gap is one time unit; full-height verticals
      // fan forward at Fibonacci integers x = a.x + (b.x - a.x) * N.
      // Time-only tool: sequence labels, no prices. Dashed base trend shown.
      if (!a || !b) break;
      const fTop = c.geom.top, fBottom = c.geom.bottom ?? (c.geom.top + c.geom.height);
      if (![a.x, a.y, b.x, b.y, fTop, fBottom].every(Number.isFinite)) break;
      const fDx = b.x - a.x;
      if (!Number.isFinite(fDx)) break;
      const normLevel = (lv) => {
        if (typeof lv === 'number') return Number.isFinite(lv) ? { v: lv, show: true } : null;
        if (lv && typeof lv === 'object') {
          const v = lv.value ?? lv.v ?? lv.coeff ?? lv.level;
          if (!Number.isFinite(v)) return null;
          return { v, show: lv.visible !== false && lv.hidden !== true };
        }
        return null;
      };
      const rawLevels = Array.isArray(d.levels) && d.levels.length
        ? d.levels
        : [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
      const showLabels = d.showLabels !== false;
      if (Math.abs(fDx) < 1e-9) {
        out.push({ op: 'line', x1: a.x, y1: fTop, x2: a.x, y2: fBottom });
        if (showLabels) out.push({ op: 'text', x: a.x + 4, y: fBottom - 6, text: '0', align: 'left' });
        out.push({ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, dash: [4, 3] });
        break;
      }
      for (const lv of rawLevels) {
        const n = normLevel(lv);
        if (!n || !n.show) continue;
        const x = lerp(a.x, b.x, n.v);
        if (!Number.isFinite(x)) continue;
        out.push({ op: 'line', x1: x, y1: fTop, x2: x, y2: fBottom });
        if (showLabels) out.push({ op: 'text', x: x + 4, y: fBottom - 6, text: String(n.v), align: 'left' });
      }
      if (d.trendlineVisible !== false) {
        out.push({ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, dash: [4, 3] });
      }
      break;
    }
    case 'timecycles': {
      for (const lv of FIB) {
        const x = lerp(a.x, b.x, lv);
        out.push({ op: 'line', x1: x, y1: c.geom.top, x2: x, y2: c.geom.top + c.geom.height });
      }
      break;
    }
    case 'fibtimebased': {
      // Trend-Based Fib Time: the A->B trend defines one time unit
      // (dx = b.x - a.x, signed). Verticals project forward from an origin:
      // the 3rd anchor's time when present, else the trend end B.
      // Time-only tool: ratio labels, no prices.
      if (!a || !b) break;
      const tbDx = b.x - a.x;
      if (!Number.isFinite(tbDx)) break;
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) break;
      const ftop = c.geom.top, fbottom = c.geom.top + c.geom.height;
      const p3 = d.points[2];
      const fox = (p3 && Number.isFinite(p3.t) && c.xy(p3) ? c.xy(p3).x : b.x);
      if (!Number.isFinite(fox)) break;
      out.push({ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      if (Math.abs(tbDx) < 1e-9) break;
      const TLV = [0, 0.382, 0.5, 0.618, 1, 1.618, 2.618, 4.236];
      const txs = TLV.map((lv) => ({ lv, x: fox + tbDx * lv }));
      out.push({
        op: 'rect',
        x: Math.min(txs[0].x, txs[4].x), y: ftop,
        w: Math.abs(txs[4].x - txs[0].x), h: fbottom - ftop, fill: 0.05,
      });
      for (const { lv, x } of txs) {
        out.push({ op: 'line', x1: x, y1: ftop, x2: x, y2: fbottom });
        if (x >= left && x <= right) {
          out.push({ op: 'text', x, y: ftop + 12, text: String(lv), align: 'center' });
        }
      }
      break;
    }
    case 'fibfan': {
      // Fib Speed Resistance Fan: origin A=P0, invisible vertical through
      // B=P1. Blade lv runs A -> V(lv)=(B.x, lerp(A.y,B.y,lv)), slope-
      // projected to the plot-rect edge (ray-style clip), with a ratio
      // label inset at the exit. Level 0 is horizontal, 1 is the trend.
      if (!a || !b) break;
      const ffP0 = d.points[0], ffP1 = d.points[1];
      if (!ffP0 || !ffP1 || !Number.isFinite(ffP0.p) || !Number.isFinite(ffP1.p)) break;
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) break;
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) break;
      const { top: ffTop, bottom: ffBottom } = c.geom;
      if (!Number.isFinite(ffTop) || !Number.isFinite(ffBottom) || ffBottom <= ffTop) break;
      const rev = d.reverse === true || d.variant === 'reverse';
      if (Math.abs(b.x - a.x) < 1e-9) {
        out.push({ op: 'line', x1: a.x, y1: ffTop, x2: a.x, y2: ffBottom });
        for (const lv of FIB) {
          const vy = lerp(a.y, b.y, rev ? 1 - lv : lv);
          out.push({
            op: 'text',
            x: Math.min(right - 4, Math.max(left + 4, a.x + 6)),
            y: Math.min(ffBottom - 4, Math.max(ffTop + 12, vy)),
            text: String(lv),
            align: 'left',
          });
        }
        break;
      }
      const ffInside = a.x >= left && a.x <= right && a.y >= ffTop && a.y <= ffBottom;
      for (const lv of FIB) {
        const eff = rev ? 1 - lv : lv;
        const vx = b.x, vy = lerp(a.y, b.y, eff);
        const rdx = vx - a.x, rdy = vy - a.y;
        if (!Number.isFinite(rdx) || !Number.isFinite(rdy)) continue;
        if (Math.hypot(rdx, rdy) < 1e-9) continue;
        const ts = [];
        if (rdx > 0) ts.push((right - a.x) / rdx);
        else if (rdx < 0) ts.push((left - a.x) / rdx);
        if (rdy > 0) ts.push((ffBottom - a.y) / rdy);
        else if (rdy < 0) ts.push((ffTop - a.y) / rdy);
        const pos = ts.filter((t) => Number.isFinite(t) && t > 0);
        if (!pos.length) continue;
        const t = ffInside ? Math.min(...pos) : Math.max(...pos);
        if (!Number.isFinite(t)) continue;
        const ex = a.x + rdx * t, ey = a.y + rdy * t;
        out.push({ op: 'line', x1: a.x, y1: a.y, x2: ex, y2: ey });
        let lx, ly, align;
        if (Math.abs(ex - right) < 1e-6 && rdx > 0) { lx = right - 4; ly = ey - 4; align = 'right'; }
        else if (Math.abs(ex - left) < 1e-6 && rdx < 0) { lx = left + 4; ly = ey - 4; align = 'left'; }
        else if (Math.abs(ey - ffTop) < 1e-6 && rdy < 0) { lx = ex; ly = ffTop + 12; align = 'center'; }
        else if (Math.abs(ey - ffBottom) < 1e-6 && rdy > 0) { lx = ex; ly = ffBottom - 4; align = 'center'; }
        else { lx = ex - 6; ly = ey - 4; align = 'right'; }
        out.push({
          op: 'text',
          x: Math.min(right - 4, Math.max(left + 4, lx)),
          y: Math.min(ffBottom - 4, Math.max(ffTop + 12, ly)),
          text: String(lv),
          align,
        });
      }
      break;
    }
    case 'gannfan': {
      // Gann Fan: nine price/time rays from the origin anchor. The second
      // anchor fixes the 1x1 (1 price unit per 1 time unit); each other ray
      // scales its price component. Rays clip to the chart rect with a
      // ratio label at the exit point.
      if (!a || !b) break;
      const gdx = b.x - a.x, gdy = b.y - a.y;
      if (!Number.isFinite(gdx) || !Number.isFinite(gdy)) break;
      if (Math.abs(gdx) < 1e-9) break;
      const { top, bottom } = c.geom;
      const FAN = [
        { label: '8x1', m: 8 },
        { label: '4x1', m: 4 },
        { label: '3x1', m: 3 },
        { label: '2x1', m: 2 },
        { label: '1x1', m: 1 },
        { label: '1x2', m: 1 / 2 },
        { label: '1x3', m: 1 / 3 },
        { label: '1x4', m: 1 / 4 },
        { label: '1x8', m: 1 / 8 },
      ];
      const ginside = a.x >= left && a.x <= right && a.y >= top && a.y <= bottom;
      for (const { label, m } of FAN) {
        const rdx = gdx, rdy = gdy * m;
        const ts = [];
        if (rdx > 0) ts.push((right - a.x) / rdx);
        else if (rdx < 0) ts.push((left - a.x) / rdx);
        if (rdy > 0) ts.push((bottom - a.y) / rdy);
        else if (rdy < 0) ts.push((top - a.y) / rdy);
        const pos = ts.filter((t) => t > 0);
        if (!pos.length) continue;
        const t = ginside ? Math.min(...pos) : Math.max(...pos);
        const ex = a.x + rdx * t, ey = a.y + rdy * t;
        out.push({ op: 'line', x1: a.x, y1: a.y, x2: ex, y2: ey });
        if (Math.abs(ex - right) < 0.5) {
          out.push({ op: 'text', x: right - 4, y: Math.min(Math.max(ey + 3, top + 12), bottom - 2), text: label, align: 'right' });
        } else if (Math.abs(ex - left) < 0.5) {
          out.push({ op: 'text', x: left + 4, y: Math.min(Math.max(ey + 3, top + 12), bottom - 2), text: label, align: 'left' });
        } else if (Math.abs(ey - top) < 0.5) {
          out.push({ op: 'text', x: Math.min(Math.max(ex, left + 20), right - 20), y: top + 12, text: label, align: 'center' });
        } else {
          out.push({ op: 'text', x: Math.min(Math.max(ex, left + 20), right - 20), y: bottom - 4, text: label, align: 'center' });
        }
      }
      break;
    }
    case 'fibcircles': {
      // Fib Circles: concentric screen-space rings centered at the A-B
      // midpoint; base radius = half the vertical pixel span, scaled by the
      // 11 default coeffs. Dashed A-B trendline, coeff labels at each ring's
      // 6 o'clock, translucent annulus fills.
      if (!a || !b) break;
      const CIRC = [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236, 4.618];
      const ccx = (a.x + b.x) / 2, ccy = (a.y + b.y) / 2;
      const base = Math.abs(b.y - a.y) / 2;
      if (!Number.isFinite(ccx) || !Number.isFinite(ccy) || !Number.isFinite(base)) break;
      const asPct = d.coeffsAsPercents === true;
      const tag = (lv) => (asPct ? `${String(Math.round(lv * 1000) / 10)}%` : String(lv));
      const TAU = Math.PI * 2, SEG = 72;
      const ringPts = (r) => {
        const pts = [];
        for (let i = 0; i <= SEG; i += 1) {
          const t = (i / SEG) * TAU;
          pts.push({ x: ccx + Math.cos(t) * r, y: ccy + Math.sin(t) * r });
        }
        return pts;
      };
      if (base > 1e-9) {
        for (let k = CIRC.length - 1; k >= 0; k -= 1) {
          const rOut = base * CIRC[k];
          const rIn = k > 0 ? base * CIRC[k - 1] : 0;
          if (rOut - rIn < 1) continue;
          const pts = ringPts(rOut);
          if (rIn > 0) {
            for (let i = SEG; i >= 0; i -= 1) {
              const t = (i / SEG) * TAU;
              pts.push({ x: ccx + Math.cos(t) * rIn, y: ccy + Math.sin(t) * rIn });
            }
          }
          out.push({ op: 'path', pts, close: true, fill: 0.08 });
        }
        for (const lv of CIRC) out.push({ op: 'ellipse', cx: ccx, cy: ccy, rx: base * lv, ry: base * lv });
        for (const lv of CIRC) {
          out.push({ op: 'text', x: ccx, y: ccy + base * lv + 13, text: tag(lv), align: 'center' });
        }
      }
      out.push({ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, dash: [5, 4] });
      break;
    }
    case 'fibarcs': {
      // Fib Speed Resistance Arcs: concentric level ARCS centered on the
      // first anchor. Radius R = |B-A| in px; level lv has radius R*lv and
      // meets the A->B trend line at lerpP(A,B,lv). Each level is the
      // forward half-circle so its apex sits on the trend line.
      if (!a || !b) break;
      const adx = b.x - a.x, ady = b.y - a.y;
      const R = Math.hypot(adx, ady);
      if (!Number.isFinite(R) || R < 1e-9) break;
      const custom = Array.isArray(d.levels)
        ? d.levels.filter((v) => Number.isFinite(v) && v > 0 && v <= 3)
        : null;
      const alevels = custom && custom.length ? custom : [0.382, 0.5, 0.618, 1];
      const full = d.variant === 'full' || d.fullCircles === true;
      const theta = Math.atan2(ady, adx);
      out.push({ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      for (const lv of alevels) {
        const r = R * lv;
        if (!Number.isFinite(r) || r < 0.5) continue;
        if (full) {
          out.push({ op: 'ellipse', cx: a.x, cy: a.y, rx: r, ry: r });
        } else {
          const a0 = theta - Math.PI / 2, a1 = theta + Math.PI / 2;
          if (a1 > Math.PI) {
            out.push({ op: 'arc', cx: a.x, cy: a.y, r, a0, a1: Math.PI });
            out.push({ op: 'arc', cx: a.x, cy: a.y, r, a0: -Math.PI, a1: a1 - Math.PI * 2 });
          } else if (a0 < -Math.PI) {
            out.push({ op: 'arc', cx: a.x, cy: a.y, r, a0: a0 + Math.PI * 2, a1: Math.PI });
            out.push({ op: 'arc', cx: a.x, cy: a.y, r, a0: -Math.PI, a1 });
          } else {
            out.push({ op: 'arc', cx: a.x, cy: a.y, r, a0, a1 });
          }
        }
        const ap = lerpP(a, b, lv);
        out.push({ op: 'text', x: ap.x + 6, y: ap.y - 6, text: String(lv), align: 'left' });
      }
      break;
    }
    case 'fibspiral': {
      // Fib spiral: golden (logarithmic) spiral through both anchors.
      // Center = points[0]; radius/orientation = points[0]->points[1].
      // r(s) = r0 * PHI^(s/(PI/2)); th(s) = th0 + dir*s. Quarter-turn
      // marks sit at r0*PHI^k with ratio labels.
      if (!a || !b) break;
      const sdx = b.x - a.x, sdy = b.y - a.y;
      const r0 = Math.hypot(sdx, sdy);
      if (!(r0 >= 1)) break;
      const PHI = (1 + Math.sqrt(5)) / 2;
      const B = Math.log(PHI) / (Math.PI / 2);
      const th0 = Math.atan2(sdy, sdx);
      const dir = (d.counterclockwise === true
        || d.variant === 'ccw'
        || d.variant === 'counterclockwise'
        || d.reverse === true) ? -1 : 1;
      const sW = (c.geom && c.geom.width) || 0;
      const sH = (c.geom && c.geom.height) || 0;
      const maxR = Math.hypot(sW, sH) * 1.5 + r0;
      let sMax = Math.log(maxR / r0) / B;
      if (!Number.isFinite(sMax)) sMax = 4 * Math.PI;
      sMax = Math.min(8 * Math.PI, Math.max(Math.PI / 2, sMax));
      let sMin = Math.log(0.5 / r0) / B;
      if (!Number.isFinite(sMin)) sMin = -4 * Math.PI;
      sMin = Math.max(-4 * Math.PI, sMin);
      if (!(sMax > sMin)) break;
      const dd = Array.isArray(d.dash) ? { dash: d.dash } : {};
      const spts = sample((t) => {
        const s = sMin + (sMax - sMin) * t;
        const r = r0 * Math.exp(B * s);
        const th = th0 + dir * s;
        return { x: a.x + Math.cos(th) * r, y: a.y + Math.sin(th) * r };
      }, 320);
      out.push({ op: 'path', pts: spts, ...dd });
      const kMin = Math.ceil(sMin / (Math.PI / 2));
      const kMax = Math.floor(sMax / (Math.PI / 2));
      const sleft = (c.geom && c.geom.left) || 0;
      const stop = (c.geom && c.geom.top) || 0;
      const sright = sleft + sW, sbottom = stop + sH;
      const showTxt = d.showLabels !== false;
      for (let k = kMin; k <= kMax; k += 1) {
        const s = k * (Math.PI / 2);
        const r = r0 * Math.pow(PHI, k);
        if (!Number.isFinite(r)) continue;
        const th = th0 + dir * s;
        const x = a.x + Math.cos(th) * r;
        const y = a.y + Math.sin(th) * r;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        out.push({ op: 'ellipse', cx: x, cy: y, rx: 3, ry: 3 });
        if (showTxt && x >= sleft - 40 && x <= sright + 40 && y >= stop - 40 && y <= sbottom + 40) {
          const slbl = k === 0 ? '1' : Math.pow(PHI, k).toFixed(3);
          out.push({ op: 'text', x: x + 6, y: y - 6, text: slbl, align: 'left', size: 11 });
        }
      }
      break;
    }
    case 'fibwedge': {
      // Fib Wedge: concentric sector arcs centered on the trend origin (P0),
      // radii = |P1-P0| x fib level, spanning a fixed half-angle about the
      // P0->P1 axis. Two border rays converge at P0 and end on the outer arc.
      if (!a || !b) break;
      const ox = a.x, oy = a.y;
      const wdx = b.x - ox, wdy = b.y - oy;
      const R = Math.hypot(wdx, wdy);
      if (!(R >= 2)) break;
      const phi = Math.atan2(wdy, wdx);
      const HALF = 0.2;
      const WEDGE_LEVELS = [0.236, 0.382, 0.5, 0.618, 0.786, 1];
      let LV = WEDGE_LEVELS;
      if (Array.isArray(d.levels) && d.levels.length) {
        const wcustom = d.levels.map(Number).filter((v) => Number.isFinite(v) && v > 0 && v <= 5);
        if (wcustom.length) LV = wcustom.slice(0, 12);
      }
      const outer = Math.max(...LV);
      const a0 = phi - HALF, a1 = phi + HALF;
      if (d.trendLine !== false && d.showTrend !== false) {
        out.push({ op: 'line', x1: ox, y1: oy, x2: ox + Math.cos(a0) * R * outer, y2: oy + Math.sin(a0) * R * outer });
        out.push({ op: 'line', x1: ox, y1: oy, x2: ox + Math.cos(a1) * R * outer, y2: oy + Math.sin(a1) * R * outer });
      }
      if (d.showBackground !== false) {
        let prev = 0;
        for (const lv of LV) {
          const rO = R * lv, rI = R * prev;
          const span = (t, r, from) => ({ x: ox + Math.cos(from + (a1 - a0) * t) * r, y: oy + Math.sin(from + (a1 - a0) * t) * r });
          const wpts = rI <= 0
            ? [{ x: ox, y: oy }, ...sample((t) => span(t, rO, a0), 24)]
            : [...sample((t) => span(t, rO, a0), 24), ...sample((t) => span(1 - t, rI, a0), 24)];
          out.push({ op: 'path', pts: wpts, close: true, fill: 0.08 });
          prev = lv;
        }
      }
      for (const lv of LV) {
        out.push({ op: 'arc', cx: ox, cy: oy, r: R * lv, a0, a1 });
      }
      if (d.showLevels !== false) {
        for (const lv of LV) {
          const rr = R * lv, ri = Math.max(0, rr - 10);
          out.push({
            op: 'text',
            x: ox + Math.cos(phi) * ri,
            y: oy + Math.sin(phi) * ri + 4,
            text: String(lv),
            align: 'center',
          });
        }
      }
      break;
    }
    case 'pitchfan': {
      // Pitchfan: rays from the trend origin P0 through Fibonacci divisions
      // of the P1-P2 shoulder segment, slope-projected to the right edge.
      const s2 = c.xy(d.points[2]);
      if (!a || !b || !s2) break;
      const O = a, S1 = b, S2 = s2;
      const rEdge = c.geom.right, tEdge = c.geom.top, bEdge = c.geom.bottom;
      if (![O.x, O.y, S1.x, S1.y, S2.x, S2.y, rEdge, tEdge, bEdge].every(Number.isFinite)) break;
      const EPS = 1e-6;
      const endFor = (Q) => {
        const pdx = Q.x - O.x, pdy = Q.y - O.y;
        if (!Number.isFinite(pdx) || !Number.isFinite(pdy)) return null;
        if (Math.hypot(pdx, pdy) < 1e-9) return null;
        if (Math.abs(pdx) < EPS) return { x: O.x, y: pdy > 0 ? bEdge : tEdge };
        return { x: rEdge, y: O.y + (pdy * (rEdge - O.x)) / pdx };
      };
      const e0 = endFor(lerpP(S1, S2, 0));
      const e1 = endFor(lerpP(S1, S2, 1));
      if (e0 && e1) out.push({ op: 'path', pts: [O, e0, e1], close: true, fill: 0.06 });
      for (const lv of FIB) {
        const E = endFor(lerpP(S1, S2, lv));
        if (!E) continue;
        out.push({ op: 'line', x1: O.x, y1: O.y, x2: E.x, y2: E.y });
        out.push({ op: 'text', x: rEdge - 4, y: E.y + 3, text: String(lv), align: 'right' });
      }
      break;
    }
    case 'gannbox': {
      // Gann box / square / square-fixed (2 anchors = opposite box corners):
      // quarter grid + X diagonals + 9-angle origin fan + price/time labels.
      // Square adds arcs + ranges-and-ratio box; square-fixed uses a fifths
      // grid with level numbers. Reverse swaps the fan/arc origin corner.
      if (!p0 || !p1) break;
      if (!Number.isFinite(p0.p) || !Number.isFinite(p1.p)) break;
      if (!Number.isFinite(p0.t) || !Number.isFinite(p1.t)) break;
      if (!a || !b) break;
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) break;
      if (Math.hypot(b.x - a.x, b.y - a.y) < 2) break;
      const gx0 = Math.min(a.x, b.x), gx1 = Math.max(a.x, b.x);
      const gy0 = Math.min(a.y, b.y), gy1 = Math.max(a.y, b.y);
      const gw = gx1 - gx0, gh = gy1 - gy0;
      if (!(gw >= 2 && gh >= 2)) break;
      if (!Number.isFinite(gw) || !Number.isFinite(gh)) break;
      const grev = d.reverse === true;
      const gvar = d.variant || 'box';
      const gfixed = gvar === 'square-fixed';
      const gsquare = gvar === 'square' || gfixed;
      const gparts = gfixed ? [0, 0.2, 0.4, 0.6, 0.8, 1] : [0, 0.25, 0.5, 0.75, 1];
      const gfmtPx = (p) => {
        if (!Number.isFinite(p)) return '';
        const m = Math.abs(p);
        if (m >= 1000) return Math.round(p).toLocaleString('en-US');
        if (m >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return p.toLocaleString('en-US', { maximumFractionDigits: 4 });
      };
      const gfmtDate = (t) => {
        const gdt = new Date(t);
        if (Number.isNaN(gdt.getTime())) return '';
        const iso = gdt.toISOString();
        const md = iso.slice(5, 10), hm = iso.slice(11, 16);
        return hm === '00:00' ? md : `${md} ${hm}`;
      };
      const gpriceTop = a.y <= b.y ? p0.p : p1.p;
      const gpriceBot = a.y <= b.y ? p1.p : p0.p;
      const gtLeft = a.x <= b.x ? p0.t : p1.t;
      const gtRight = a.x <= b.x ? p1.t : p0.t;
      out.push({ op: 'rect', x: gx0, y: gy0, w: gw, h: gh, fill: 0.05 });
      for (const lv of gparts) {
        const vx = gx0 + gw * lv, hy = gy0 + gh * lv;
        out.push({ op: 'line', x1: vx, y1: gy0, x2: vx, y2: gy1 });
        out.push({ op: 'line', x1: gx0, y1: hy, x2: gx1, y2: hy });
      }
      out.push({ op: 'line', x1: gx0, y1: gy0, x2: gx1, y2: gy1, dash: [4, 3] });
      out.push({ op: 'line', x1: gx1, y1: gy0, x2: gx0, y2: gy1, dash: [4, 3] });
      const gO = grev ? b : a, gF = grev ? a : b;
      const gsx = Math.sign(gF.x - gO.x) || 1, gsy = Math.sign(gF.y - gO.y) || 1;
      const GFANS = [['8x1', 8], ['4x1', 4], ['3x1', 3], ['2x1', 2], ['1x1', 1], ['1x2', 0.5], ['1x3', 1 / 3], ['1x4', 0.25], ['1x8', 0.125]];
      for (const [glabel, gk] of GFANS) {
        if (!(gk > 0 && Number.isFinite(gk))) continue;
        const gt = Math.min(1, 1 / gk);
        const gex = gO.x + gsx * gw * gt, gey = gO.y + gsy * gh * gk * gt;
        if (!Number.isFinite(gex) || !Number.isFinite(gey)) continue;
        if (glabel !== '1x1') out.push({ op: 'line', x1: gO.x, y1: gO.y, x2: gex, y2: gey });
        out.push({ op: 'text', x: gex - gsx * 5, y: gey - gsy * 6 + 3, text: glabel, align: gsx > 0 ? 'right' : 'left', size: 11 });
      }
      if (d.showLabels !== false) {
        for (const lv of gparts) {
          const gpr = gpriceTop + (gpriceBot - gpriceTop) * lv;
          const gtm = gtLeft + (gtRight - gtLeft) * lv;
          out.push({ op: 'text', x: gx1 - 4, y: gy0 + gh * lv - 3, text: gfmtPx(gpr), align: 'right', size: 11 });
          out.push({ op: 'text', x: gx0 + gw * lv, y: gy1 - 4, text: gfmtDate(gtm), align: 'center', size: 11 });
        }
      }
      if (gsquare) {
        const gR = Math.hypot(gw, gh);
        const garcLv = gfixed ? [0.2, 0.4, 0.6, 0.8, 1] : [0.5, 1];
        let ga0, ga1;
        if (gsx > 0 && gsy > 0) { ga0 = 0; ga1 = Math.PI / 2; }
        else if (gsx > 0 && gsy < 0) { ga0 = -Math.PI / 2; ga1 = 0; }
        else if (gsx < 0 && gsy > 0) { ga0 = Math.PI / 2; ga1 = Math.PI; }
        else { ga0 = Math.PI; ga1 = Math.PI * 1.5; }
        for (const lv of garcLv) {
          const gr = gR * lv;
          if (!(gr >= 2 && Number.isFinite(gr))) continue;
          out.push({ op: 'arc', cx: gO.x, cy: gO.y, r: gr, a0: ga0, a1: ga1 });
        }
        if (gfixed) {
          gparts.forEach((lv, i) => {
            out.push({ op: 'text', x: gx0 + gw * lv + 3, y: gy0 + 11, text: String(i), align: 'left', size: 11 });
          });
        }
        const gbw = c.barWidth() || 8;
        const gbars = Math.max(1, Math.round(gw / gbw));
        const grange = Math.abs(p1.p - p0.p);
        const gpct = p0.p ? `${((grange / Math.abs(p0.p)) * 100).toFixed(2)}%` : '—';
        const gratio = gbars ? grange / gbars : 0;
        const gstats = `${gbars} bars · ${gfmtPx(grange)} (${gpct}) · ${Number.isFinite(gratio) ? gratio.toFixed(2) : '—'}/bar`;
        const gG = c.geom;
        out.push({ op: 'box', x: Math.min(Math.max(gx0 + gw / 2 - 95, gG.left + 2), Math.max(gG.left + 2, gG.right - 192)), y: gy0 + 4, w: 190, h: 20, label: gstats });
      }
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
    // Cyclic Lines: two user verticals a fixed bar-distance apart, then
    // equidistant full-height verticals repeating into the future.
    const p0 = d.points[0], p1 = d.points[1];
    const A = P[0], B = P[1];
    if (!A || !B) return [];
    if (!Number.isFinite(A.x) || !Number.isFinite(B.x)) return [];
    if (!p0 || !p1 || !Number.isFinite(p0.t) || !Number.isFinite(p1.t)) return [];
    if (!(Math.abs(p1.t - p0.t) > 0)) return [];
    const stepPx = Math.abs(B.x - A.x);
    if (!(stepPx > 0.5)) return [];
    const { left, right, top } = c.geom;
    const h = c.geom.height;
    if (!Number.isFinite(left) || !Number.isFinite(right) || !(right > left)) return [];
    if (!Number.isFinite(top) || !Number.isFinite(h) || !(h > 0)) return [];
    const xBase = Math.min(A.x, B.x);
    let k0 = 0;
    if (xBase < left) k0 = Math.ceil((left - xBase) / stepPx);
    const cdash = Array.isArray(d.dash) ? d.dash : undefined;
    const out = [];
    for (let k = k0, x = xBase + k * stepPx; x <= right + 0.5; k += 1, x = xBase + k * stepPx) {
      if (!Number.isFinite(x)) break;
      const prim = { op: 'line', x1: x, y1: top, x2: x, y2: top + h };
      if (cdash) prim.dash = cdash;
      out.push(prim);
      if (out.length >= 500) break;
    }
    return out;
  }
  if (d.kind === 'sine') {
    // Sine Line: both anchors are opposite extrema (trough<->peak); the
    // anchor span is a half wavelength, projected forward to the right edge.
    const [a, b] = P;
    const sp0 = d.points && d.points[0], sp1 = d.points && d.points[1];
    if (!a || !b || !sp0 || !sp1) return [];
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return [];
    if (!Number.isFinite(sp0.t) || !Number.isFinite(sp1.t)) return [];
    if (!Number.isFinite(sp0.p) || !Number.isFinite(sp1.p)) return [];
    const { left, right, top, bottom } = c.geom || {};
    if (!Number.isFinite(left) || !Number.isFinite(right) || !(right > left)) return [];
    const sdx = b.x - a.x;
    if (!(Math.abs(sdx) >= 2)) return [];
    const lambda = Math.abs(sdx) * 2;
    if (!Number.isFinite(lambda) || lambda <= 0) return [];
    const center = (a.y + b.y) / 2;
    const A0 = a.y - center;
    if (![center, A0].every(Number.isFinite)) return [];
    const x0 = Math.max(Math.min(a.x, b.x), left);
    if (!(x0 < right)) return [];
    const sout = [];
    const sdash = Array.isArray(d.dash) ? { dash: d.dash } : {};
    if (Math.abs(A0) < 0.5) {
      sout.push({ op: 'line', x1: x0, y1: center, x2: right, y2: center, ...sdash });
    } else {
      const span = right - x0;
      const steps = Math.min(480, Math.max(96, Math.ceil((span / lambda) * 32)));
      const w = (2 * Math.PI) / lambda;
      sout.push({
        op: 'path',
        pts: sample((t) => ({ x: x0 + t * span, y: center + A0 * Math.cos(w * (x0 + t * span - a.x)) }), steps),
        ...sdash,
      });
    }
    if (d.showLabels !== false) {
      const bw = (c.barWidth && c.barWidth()) || 8;
      const bars = bw > 0 ? Math.max(1, Math.round(lambda / bw)) : 0;
      const ampP = Math.abs(sp1.p - sp0.p) / 2;
      const ap = Math.abs(ampP);
      const fmtA = !Number.isFinite(ampP) ? ''
        : ap >= 1000 ? Math.round(ampP).toLocaleString('en-US')
        : ap >= 1 ? ampP.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : ampP.toLocaleString('en-US', { maximumFractionDigits: 4 });
      const slbl = `λ ${bars} bars · A ${fmtA}`;
      const slx = Math.min(Math.max((a.x + b.x) / 2, left + 60), Math.max(left + 60, right - 60));
      let sly = center - Math.abs(A0) - 8;
      if (!Number.isFinite(sly)) sly = top + 14;
      sly = Math.min(Math.max(sly, top + 12), bottom - 6);
      if (Number.isFinite(slx) && Number.isFinite(sly)) {
        sout.push({ op: 'text', x: slx, y: sly, text: slbl, align: 'center' });
      }
    }
    if (typeof d.text === 'string' && d.text.trim() !== '') {
      const scx = Math.min(Math.max((a.x + b.x) / 2, left + 4), right - 4);
      const scy = Math.min(Math.max(center + Math.abs(A0) + 16, top + 12), bottom - 4);
      sout.push({ op: 'text', x: scx, y: scy, text: d.text, align: 'center' });
    }
    return sout;
  }
  const type = d.type || d.kind;
  if (type === 'path' || type === 'polyline' || type === 'triangle'
    || type === 'curve' || type === 'doublecurve') {
    // Poly-draw: straight-segment shapes plus Bezier curves bent by control
    // handle(s). Curves sample into dense polylines; no shared helper change.
    const ok = (q) => q && Number.isFinite(q.x) && Number.isFinite(q.y);
    if (!P.length || P.some((q) => !ok(q))) return [];
    const ddash = Array.isArray(d.dash) ? d.dash : undefined;
    const ds = ddash ? { dash: ddash } : {};
    const rawFill = Number(d.fill);
    const explicitFill = Number.isFinite(rawFill) && rawFill > 0
      ? Math.min(1, rawFill) : undefined;
    const wantFill = d.showFill !== false && d.background !== false;
    const CLOSED_FILL = 0.08;
    const CLOSE_TOL = 12;
    const plen = (qs) => {
      let L = 0;
      for (let i = 1; i < qs.length; i += 1) L += Math.hypot(qs[i].x - qs[i - 1].x, qs[i].y - qs[i - 1].y);
      return L;
    };
    const rayToEdge = (O, D) => {
      const g = c.geom;
      const len = Math.hypot(D.x, D.y);
      if (!(len > 1e-9) || !Number.isFinite(g.left) || !Number.isFinite(g.right)
        || !Number.isFinite(g.top) || !Number.isFinite(g.bottom)) return null;
      const rdx = D.x / len, rdy = D.y / len;
      const ts = [];
      if (rdx > 1e-12) ts.push((g.right - O.x) / rdx);
      else if (rdx < -1e-12) ts.push((g.left - O.x) / rdx);
      if (rdy > 1e-12) ts.push((g.bottom - O.y) / rdy);
      else if (rdy < -1e-12) ts.push((g.top - O.y) / rdy);
      const pos = ts.filter((t) => t > 1);
      if (!pos.length) return null;
      const t = Math.min(...pos);
      return { x: O.x + rdx * t, y: O.y + rdy * t };
    };
    if (type === 'path') {
      if (P.length < 2 || !(plen(P) >= 1)) return [];
      return [{ op: 'path', pts: P.slice(), ...ds }];
    }
    if (type === 'polyline') {
      if (P.length < 2 || !(plen(P) >= 1)) return [];
      const first = P[0], last = P[P.length - 1];
      const shut = !!d.close
        || (P.length > 2 && Math.hypot(last.x - first.x, last.y - first.y) <= CLOSE_TOL);
      const prim = { op: 'path', pts: shut ? [...P, P[0]] : P.slice(), close: shut, ...ds };
      const f = wantFill
        ? (explicitFill !== undefined ? explicitFill : (shut ? CLOSED_FILL : undefined))
        : undefined;
      if (f) prim.fill = f;
      return [prim];
    }
    if (type === 'triangle') {
      if (P.length < 3 || !(plen(P) >= 1)) return [];
      const prim = { op: 'path', pts: [P[0], P[1], P[2], P[0]], close: true, ...ds };
      const f = wantFill
        ? (explicitFill !== undefined ? explicitFill : CLOSED_FILL)
        : undefined;
      if (f) prim.fill = f;
      return [prim];
    }
    const ext = typeof d.extend === 'string' ? d.extend : 'none';
    const wantExt = (side) => ext === 'both' || ext === side;
    const finishCurve = (pts, T0, T1) => {
      const prim = { op: 'path', pts, ...ds };
      if (wantFill && explicitFill) prim.fill = explicitFill;
      const cout = [prim];
      if (wantExt('left')) {
        const hit = rayToEdge(pts[0], { x: -T0.x, y: -T0.y });
        if (hit) cout.push({ op: 'line', x1: pts[0].x, y1: pts[0].y, x2: hit.x, y2: hit.y, ...ds });
      }
      if (wantExt('right')) {
        const hit = rayToEdge(pts[pts.length - 1], T1);
        if (hit) cout.push({ op: 'line', x1: pts[pts.length - 1].x, y1: pts[pts.length - 1].y, x2: hit.x, y2: hit.y, ...ds });
      }
      return cout;
    };
    if (type === 'curve') {
      if (P.length < 3) return [];
      const S = P[0], E = P[1], C = P[2];
      if (!(plen([S, C, E]) >= 1)) return [];
      const at = (t) => {
        const u = 1 - t;
        return {
          x: u * u * S.x + 2 * u * t * C.x + t * t * E.x,
          y: u * u * S.y + 2 * u * t * C.y + t * t * E.y,
        };
      };
      const pts = sample(at, 48);
      let T0 = { x: C.x - S.x, y: C.y - S.y };
      let T1 = { x: E.x - C.x, y: E.y - C.y };
      if (!(Math.hypot(T0.x, T0.y) > 1e-9)) T0 = { x: E.x - S.x, y: E.y - S.y };
      if (!(Math.hypot(T1.x, T1.y) > 1e-9)) T1 = { x: E.x - S.x, y: E.y - S.y };
      return finishCurve(pts, T0, T1);
    }
    if (P.length < 4) return [];
    const S = P[0], E = P[1], C1 = P[2], C2 = P[3];
    if (!(plen([S, C1, C2, E]) >= 1)) return [];
    const at = (t) => {
      const u = 1 - t;
      const q0 = u * u * u, q1 = 3 * u * u * t, q2 = 3 * u * t * t, q3 = t * t * t;
      return {
        x: q0 * S.x + q1 * C1.x + q2 * C2.x + q3 * E.x,
        y: q0 * S.y + q1 * C1.y + q2 * C2.y + q3 * E.y,
      };
    };
    const pts = sample(at, 64);
    let T0 = { x: C1.x - S.x, y: C1.y - S.y };
    let T1 = { x: E.x - C2.x, y: E.y - C2.y };
    if (!(Math.hypot(T0.x, T0.y) > 1e-9)) T0 = { x: E.x - S.x, y: E.y - S.y };
    if (!(Math.hypot(T1.x, T1.y) > 1e-9)) T1 = { x: E.x - S.x, y: E.y - S.y };
    return finishCurve(pts, T0, T1);
  }
  const PATTERNS = new Set(['xabcd', 'cypher', 'headshoulders', 'abcd', 'trianglepattern',
    'threedrives', 'elliott12345', 'elliottABC', 'elliottABCDE', 'elliottWXY', 'elliottWXYXZ']);
  if (PATTERNS.has(type)) {
    // Harmonic / Elliott patterns: zigzag legs with a dashed completion leg,
    // joint letters, price-range leg ratios, and fills where TV shows them.
    const DP = d.points;
    const PP = P;
    if (PP.length < 2) return [];
    if (PP.some((q) => !q || !Number.isFinite(q.x) || !Number.isFinite(q.y))) return [];
    const pout = [];
    const isFin = (v) => Number.isFinite(v);
    const pmid = (m1, m2) => ({ x: (m1.x + m2.x) / 2, y: (m1.y + m2.y) / 2 });
    const ratio = (num, den) => (isFin(num) && isFin(den) && Math.abs(den) > 1e-9 ? Math.abs(num / den) : NaN);
    const px = (i) => (DP[i] && isFin(DP[i].p) ? DP[i].p : NaN);
    const legAt = (i, r) => {
      if (i < 0 || i + 1 >= PP.length) return;
      if (!isFin(r)) return;
      const m = pmid(PP[i], PP[i + 1]);
      if (!isFin(m.x) || !isFin(m.y)) return;
      pout.push({ op: 'text', x: m.x, y: m.y - 8, text: r.toFixed(3), align: 'center' });
    };
    const joints = (names, startAt) => {
      (names || []).forEach((L, i) => {
        const q = PP[i + (startAt || 0)];
        if (!q || typeof L !== 'string') return;
        pout.push({ op: 'text', x: q.x - 7, y: q.y - 7, text: L, align: 'right' });
      });
    };
    const legs = () => {
      if (PP.length >= 3) {
        pout.push({ op: 'path', pts: PP.slice(0, -1) });
        pout.push({ op: 'path', pts: [PP[PP.length - 2], PP[PP.length - 1]], dash: [5, 4] });
      } else {
        pout.push({ op: 'path', pts: PP.slice() });
      }
    };
    const wash = () => {
      if (d.showBackground === false || PP.length < 3) return;
      pout.push({ op: 'path', pts: PP.slice(), dash: [5, 4], fill: 0.08 });
    };
    const EW = {
      elliott12345: ['1', '2', '3', '4', '5'],
      elliottABC: ['A', 'B', 'C'],
      elliottABCDE: ['A', 'B', 'C', 'D', 'E'],
      elliottWXY: ['W', 'X', 'Y'],
      elliottWXYXZ: ['W', 'X', 'Y', 'X', 'Z'],
    };
    switch (type) {
      case 'xabcd': {
        wash();
        legs();
        joints(d.labels || ['X', 'A', 'B', 'C', 'D'], 0);
        legAt(1, ratio(px(2) - px(1), px(1) - px(0)));
        legAt(2, ratio(px(3) - px(2), px(2) - px(1)));
        legAt(3, ratio(px(4) - px(3), px(3) - px(2)));
        break;
      }
      case 'cypher': {
        wash();
        legs();
        joints(d.labels || ['X', 'A', 'B', 'C', 'D'], 0);
        legAt(1, ratio(px(2) - px(1), px(1) - px(0)));
        legAt(2, ratio(px(3) - px(0), px(1) - px(0)));
        legAt(3, ratio(px(4) - px(0), px(3) - px(0)));
        break;
      }
      case 'abcd': {
        legs();
        joints(d.labels || ['A', 'B', 'C', 'D'], 0);
        legAt(1, ratio(px(2) - px(1), px(1) - px(0)));
        legAt(2, ratio(px(3) - px(2), px(1) - px(0)));
        break;
      }
      case 'trianglepattern': {
        if (PP.length >= 4) {
          const quad = [PP[0], PP[1], PP[3], PP[2]];
          const fill = { op: 'path', pts: quad, close: true };
          if (d.showBackground !== false) fill.fill = 0.08;
          pout.push(fill);
        } else {
          pout.push({ op: 'path', pts: PP.slice() });
        }
        joints(d.labels || ['A', 'B', 'C', 'D'], 0);
        break;
      }
      case 'threedrives': {
        legs();
        joints(d.labels || ['0', '1', 'A', '2', 'C', '3'], 0);
        for (let i = 1; i < PP.length; i += 1) {
          legAt(i, ratio(px(i + 1) - px(i), px(i) - px(i - 1)));
        }
        break;
      }
      case 'headshoulders': {
        legs();
        if (PP.length >= 4) {
          const v0 = PP[1], v1 = PP[3];
          const hdx = v1.x - v0.x;
          if (Math.abs(hdx) > 1e-9) {
            const hm = (v1.y - v0.y) / hdx;
            pout.push({ op: 'line', x1: v0.x, y1: v0.y, x2: c.geom.right, y2: v0.y + hm * (c.geom.right - v0.x) });
          } else {
            pout.push({ op: 'line', x1: v0.x, y1: c.geom.top, x2: v0.x, y2: c.geom.top + c.geom.height });
          }
        }
        break;
      }
      default: {
        legs();
        joints(d.labels || EW[type] || [], 1);
        const bbase = px(1) - px(0);
        for (let i = 2; i < PP.length; i += 1) legAt(i - 1, ratio(px(i) - px(i - 1), bbase));
        break;
      }
    }
    return pout;
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
      // Risk box: entry (points[0]) + target/stop rows with qty, risk/reward
      // and P&L, fills, center stats panel and right-edge price pills.
      const pts = d.points || [];
      const pp0 = pts[0], pp1 = pts[1], pp2 = pts[2];
      if (!pp0 || !Number.isFinite(pp0.p)) return [];
      if (!pp1 || !Number.isFinite(pp1.p)) return [];
      const A = c.xy(pp0), B = c.xy(pp1);
      if (!A || !B) return [];
      if (![A.x, A.y, B.x, B.y].every(Number.isFinite)) return [];
      const hasP2 = !!(pp2 && Number.isFinite(pp2.p));
      const C = hasP2 ? c.xy(pp2) : null;
      const has3 = !!(hasP2 && C && Number.isFinite(C.x) && Number.isFinite(C.y));
      const ptype = d.type || d.id || '';
      const pv = d.variant;
      const explicitShort = pv === 'short' || ptype === 'shortpos';
      const explicitLong = pv === 'long' || ptype === 'longpos';
      let isShort;
      if (explicitShort) isShort = true;
      else if (explicitLong) isShort = false;
      else isShort = pp1.p < pp0.p;
      const entry = pp0.p;
      let target, stop, targetIsQ1 = true;
      if (has3) {
        const q1 = pp1.p, q2 = pp2.p;
        if (explicitShort || explicitLong) {
          const side = isShort ? -1 : 1;
          const s1 = Math.sign(q1 - entry), s2 = Math.sign(q2 - entry);
          if (s1 === side && s2 !== side) { target = q1; stop = q2; targetIsQ1 = true; }
          else if (s2 === side && s1 !== side) { target = q2; stop = q1; targetIsQ1 = false; }
          else if (Math.abs(q1 - entry) >= Math.abs(q2 - entry)) { target = q1; stop = q2; targetIsQ1 = true; }
          else { target = q2; stop = q1; targetIsQ1 = false; }
        } else {
          if (Math.abs(q1 - entry) >= Math.abs(q2 - entry)) { target = q1; stop = q2; targetIsQ1 = true; }
          else { target = q2; stop = q1; targetIsQ1 = false; }
          isShort = target < entry;
        }
      } else {
        target = pp1.p;
        stop = 2 * entry - target;
        targetIsQ1 = true;
      }
      if (!Number.isFinite(target) || !Number.isFinite(stop)) return [];
      const yFor = (p) => (typeof c.yForPrice === 'function' ? c.yForPrice(p) : null);
      let yE = yFor(entry);
      if (!Number.isFinite(yE)) yE = A.y;
      let yT = yFor(target);
      if (!Number.isFinite(yT)) yT = has3 ? (targetIsQ1 ? B.y : C.y) : B.y;
      let yS = yFor(stop);
      if (!Number.isFinite(yS)) {
        if (has3) yS = targetIsQ1 ? C.y : B.y;
        else yS = yE + (yE - yT);
      }
      if (![yE, yT, yS].every(Number.isFinite)) return [];
      const pxs = has3 ? [A.x, B.x, C.x] : [A.x, B.x];
      if (!pxs.every(Number.isFinite)) return [];
      let x0 = Math.min(...pxs), x1 = Math.max(...pxs);
      const { left: pl, right: prr, top: pt, bottom: pb } = c.geom;
      const minW = Math.max(12, c.barWidth() || 8);
      if (!(x1 - x0 >= minW)) { const m = (x0 + x1) / 2; x0 = m - minW / 2; x1 = m + minW / 2; }
      const pw = x1 - x0;
      if (!(pw > 0) || !Number.isFinite(x0) || !Number.isFinite(x1)) return [];
      const hP = Math.abs(yT - yE), hL = Math.abs(yS - yE);
      if (hP < 1 && hL < 1) return [];
      const tpOff = isShort ? entry - target : target - entry;
      const slOff = isShort ? stop - entry : entry - stop;
      const tpPct = entry !== 0 && Number.isFinite(tpOff) ? (tpOff / entry) * 100 : NaN;
      const slPct = entry !== 0 && Number.isFinite(slOff) ? (slOff / entry) * 100 : NaN;
      const rr = slOff > 0 && Number.isFinite(tpOff) ? tpOff / slOff : NaN;
      const fmtPx = (p) => {
        if (!Number.isFinite(p)) return '—';
        const m = Math.abs(p);
        if (m >= 1000) return Math.round(p).toLocaleString('en-US');
        if (m >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return p.toLocaleString('en-US', { maximumFractionDigits: 4 });
      };
      const fmtSg = (p) => `${p < 0 ? '-' : '+'}${fmtPx(Math.abs(p))}`;
      const fmtPc = (p) => (Number.isFinite(p) ? `${p < 0 ? '-' : '+'}${Math.abs(p).toFixed(2)}%` : '—');
      const numD = (val) => { const n = Number(val); return Number.isFinite(n) ? n : NaN; };
      const account = Number.isFinite(numD(d.accountSize)) ? numD(d.accountSize) : 1000;
      const levRaw = numD(d.leverage);
      const lev = Number.isFinite(levRaw) ? Math.max(0, levRaw) : 1;
      const lotRaw = numD(d.lotSize);
      const lot = Number.isFinite(lotRaw) && lotRaw > 0 ? lotRaw : 1;
      const pvRaw = numD(d.pointValue);
      const ptVal = Number.isFinite(pvRaw) && pvRaw > 0 ? pvRaw : 1;
      let riskSize;
      if (Number.isFinite(numD(d.riskSize))) riskSize = numD(d.riskSize);
      else if (Number.isFinite(numD(d.riskPct))) riskSize = (account * numD(d.riskPct)) / 100;
      else if (Number.isFinite(numD(d.risk))) riskSize = numD(d.risk);
      else riskSize = account * 0.01;
      const slMag = Math.abs(entry - stop);
      const qtyRisk = slMag > 1e-12 && Number.isFinite(riskSize) ? riskSize / (slMag * ptVal) / lot : NaN;
      const qtyLvg = Math.abs(entry) > 1e-12 ? ((account * lev) / Math.abs(entry)) * ptVal / lot : NaN;
      let qty = NaN;
      if (Number.isFinite(qtyRisk) && Number.isFinite(qtyLvg)) qty = Math.min(qtyRisk, qtyLvg);
      else if (Number.isFinite(qtyRisk)) qty = qtyRisk;
      else if (Number.isFinite(qtyLvg)) qty = qtyLvg;
      const qpRaw = numD(d.qtyPrecision);
      const qp = Number.isFinite(qpRaw)
        ? Math.max(0, Math.min(8, Math.round(qpRaw)))
        : !(Number.isFinite(qty)) ? 2 : qty < 1 ? 4 : qty < 10 ? 3 : qty < 1000 ? 2 : 0;
      const qtyStr = Number.isFinite(qty) ? qty.toFixed(qp) : '—';
      const rrStr = Number.isFinite(rr) ? `1:${rr.toFixed(2)}` : '—';
      const profitPnL = Number.isFinite(qty) && Number.isFinite(tpOff) ? tpOff * qty * ptVal * lot : NaN;
      const lossPnL = Number.isFinite(qty) && Number.isFinite(slOff) ? -(slOff * qty * ptVal * lot) : NaN;
      const fmtMoney = (m) => (Number.isFinite(m) ? `${m < 0 ? '-' : '+'}${fmtPx(Math.abs(m))}` : '—');
      const pout = [];
      const yPT = Math.min(yE, yT), yST = Math.min(yE, yS);
      pout.push({ op: 'rect', x: x0, y: yST, w: pw, h: Math.max(hL, 2), fill: 0.18 });
      pout.push({ op: 'rect', x: x0, y: yPT, w: pw, h: Math.max(hP, 2), fill: 0.15 });
      pout.push({ op: 'line', x1: x0, y1: yT, x2: x1, y2: yT });
      pout.push({ op: 'line', x1: x0, y1: yS, x2: x1, y2: yS });
      pout.push({ op: 'path', pts: [{ x: x0, y: yE }, { x: x1, y: yE }], thick: 2 });
      const showStats = d.showStats !== false;
      const compact = d.compact === true;
      const clampY = (y) => Math.min(Math.max(y, pt + 8), pb - 8);
      const pcx = (x0 + x1) / 2;
      if (showStats && !compact) {
        const tpLbl = `${fmtSg(tpOff)} (${fmtPc(tpPct)})`;
        const slLbl = `${fmtSg(slOff >= 0 ? -slOff : slOff)} (${fmtPc(slOff >= 0 ? -Math.abs(slPct) : slPct)})`;
        if (hP >= 30) {
          pout.push({ op: 'text', x: pcx, y: clampY((yE + yT) / 2 - 3), text: tpLbl, align: 'center', size: 11 });
          if (Number.isFinite(profitPnL)) pout.push({ op: 'text', x: pcx, y: clampY((yE + yT) / 2 + 11), text: fmtMoney(profitPnL), align: 'center', size: 11 });
        } else if (hP >= 14) {
          pout.push({ op: 'text', x: pcx, y: clampY((yE + yT) / 2 + 4), text: tpLbl, align: 'center', size: 11 });
        } else {
          const yo = yPT < yE ? yPT - 6 : yPT + Math.max(hP, 2) + 12;
          pout.push({ op: 'text', x: pcx, y: clampY(yo), text: tpLbl, align: 'center', size: 11 });
        }
        if (hL >= 30) {
          pout.push({ op: 'text', x: pcx, y: clampY((yE + yS) / 2 - 3), text: slLbl, align: 'center', size: 11 });
          if (Number.isFinite(lossPnL)) pout.push({ op: 'text', x: pcx, y: clampY((yE + yS) / 2 + 11), text: fmtMoney(lossPnL), align: 'center', size: 11 });
        } else if (hL >= 14) {
          pout.push({ op: 'text', x: pcx, y: clampY((yE + yS) / 2 + 4), text: slLbl, align: 'center', size: 11 });
        } else {
          const yo = yST + Math.max(hL, 2) + 12;
          pout.push({ op: 'text', x: pcx, y: clampY(yo), text: slLbl, align: 'center', size: 11 });
        }
      } else if (showStats && compact) {
        const midP = (yE + yT) / 2, midL = (yE + yS) / 2;
        pout.push({ op: 'text', x: pcx, y: clampY(midP + 4), text: fmtPc(tpPct), align: 'center', size: 11 });
        pout.push({ op: 'text', x: pcx, y: clampY(midL + 4), text: fmtPc(slPct >= 0 ? -Math.abs(slPct) : slPct), align: 'center', size: 11 });
        pout.push({ op: 'text', x: pcx, y: clampY(yE - 8), text: rrStr, align: 'center', size: 11 });
      }
      const wantPanel = showStats && !compact
        && (d.alwaysShowStats !== false || !c.state || d.id == null || c.state.selectedId === d.id);
      if (wantPanel) {
        const dir = isShort ? 'Short' : 'Long';
        const rows4 = [
          `${dir} · Qty ${qtyStr} · R:R ${rrStr}`,
          `Entry ${fmtPx(entry)}`,
          `Target ${fmtPx(target)}  ${fmtSg(tpOff)} (${fmtPc(tpPct)})`,
          `Stop ${fmtPx(stop)}  ${fmtSg(slOff >= 0 ? -slOff : slOff)} (${fmtPc(slOff >= 0 ? -Math.abs(slPct) : slPct)})`,
        ];
        const W = 210, H = 76;
        const yLo = Math.min(yE, yT, yS), yHi = Math.max(yE, yT, yS);
        const bx = Math.min(Math.max((x0 + x1) / 2 - W / 2, pl + 4), Math.max(pl + 4, prr - W - 4));
        let by = (yLo + yHi) / 2 - H / 2;
        by = Math.min(Math.max(by, pt + 4), Math.max(pt + 4, pb - H - 4));
        if (Number.isFinite(bx) && Number.isFinite(by)) pout.push({ op: 'box', x: bx, y: by, w: W, h: H, label: rows4.join('\n') });
      }
      if (d.showPriceLabels !== false && d.showPrice !== false) {
        const tags = [[entry, yE], [target, yT], [stop, yS]];
        for (const [pvv, yy] of tags) {
          if (!Number.isFinite(pvv) || !Number.isFinite(yy)) continue;
          const plbl = fmtPx(pvv);
          if (!plbl || plbl === '—') continue;
          const tagW = Math.min(110, Math.max(52, plbl.length * 7 + 14));
          const ty = Math.min(Math.max(yy - 9, pt + 1), Math.max(pt + 1, pb - 19));
          pout.push({ op: 'box', x: prr - tagW, y: ty, w: tagW, h: 18, label: plbl });
        }
      }
      return pout;
    }
    case 'barspattern': {
      // Bars Pattern: clone the source bars forward as a ghost projection.
      // P0/P1 define the SOURCE time range (prices ignored); P2 is the
      // placement anchor (ghost[0] time = P2 time, ghost[0].close = P2 price).
      const o = d.points[2] ? c.xy(d.points[2]) : null;
      if (!a || !b || !o) return [];
      if (![a.x, a.y, b.x, b.y, o.x, o.y].every(Number.isFinite)) return [];
      const win = (typeof c.window === 'function' ? c.window(a.x, b.x) : (c.rows || [])) || [];
      const bars = (Array.isArray(win) ? win : [])
        .filter((r) => r && Number.isFinite(r.o) && Number.isFinite(r.h) && Number.isFinite(r.l) && Number.isFinite(r.c))
        .sort((x, y) => x.t - y.t);
      if (!bars.length) return [];
      const rawMode = d.mode ?? d.barMode ?? d.style ?? 0;
      let bmode = 0;
      if (Number.isFinite(+rawMode)) bmode = Math.trunc(+rawMode);
      else {
        const s = String(rawMode).toLowerCase();
        if (s.includes('hl2')) bmode = 6;
        else if (s.includes('openclose') || s.includes('openc')) bmode = 2;
        else if (s.includes('open')) bmode = 3;
        else if (s.includes('high')) bmode = 4;
        else if (s.includes('low')) bmode = 5;
        else if (s.includes('line')) bmode = 1;
        else bmode = 0;
      }
      if (!Number.isFinite(bmode) || bmode < 0 || bmode > 6) bmode = 0;
      const mirrored = !!((d.mirrored ?? d.mirror ?? d.reverse ?? false));
      const flipped = !!((d.flipped ?? d.flip ?? d.invert ?? false));
      const ordered = mirrored ? bars.slice().reverse() : bars;
      const anchorBar = ordered[0];
      if (!anchorBar || !Number.isFinite(anchorBar.c)) return [];
      const bstep = (c.barWidth && c.barWidth()) || 8;
      if (!Number.isFinite(bstep) || !(bstep > 0)) return [];
      const bbw = Math.max(2, bstep * 0.6);
      const bhalf = bbw / 2;
      const bp2 = d.points[2];
      const baseP = Number.isFinite(bp2?.p) ? bp2.p : anchorBar.c;
      const priceOf = (r) => {
        if (bmode === 3) return r.o;
        if (bmode === 4) return r.h;
        if (bmode === 5) return r.l;
        if (bmode === 6) return (r.h + r.l) / 2;
        return r.c;
      };
      const yP = (gp) => (typeof c.yForPrice === 'function' ? c.yForPrice(gp) : NaN);
      const bout = [];
      if (bmode === 1 || bmode >= 3) {
        const refLine = priceOf(anchorBar);
        const bpts = [];
        for (let i = 0; i < ordered.length; i += 1) {
          const pv = priceOf(ordered[i]);
          if (!Number.isFinite(pv)) continue;
          const gp = flipped ? baseP - (pv - refLine) : baseP + (pv - refLine);
          const x = o.x + bstep * i;
          const y = yP(gp);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          bpts.push({ x, y });
        }
        if (bpts.length >= 2) bout.push({ op: 'path', pts: bpts });
        else if (bpts.length === 1) bout.push({ op: 'line', x1: bpts[0].x - 3, y1: bpts[0].y, x2: bpts[0].x + 3, y2: bpts[0].y });
      } else if (bmode === 2) {
        const ref = anchorBar.c;
        for (let i = 0; i < ordered.length; i += 1) {
          const r = ordered[i];
          let gO = baseP + (r.o - ref);
          let gC = baseP + (r.c - ref);
          if (flipped) { gO = baseP - (r.o - ref); gC = baseP - (r.c - ref); }
          const x = o.x + bstep * i;
          const yO = yP(gO), yC = yP(gC);
          if (![x, yO, yC].every(Number.isFinite)) continue;
          bout.push({ op: 'line', x1: x - bhalf, y1: yO, x2: x, y2: yO });
          bout.push({ op: 'line', x1: x, y1: yC, x2: x + bhalf, y2: yC });
          bout.push({ op: 'line', x1: x, y1: yO, x2: x, y2: yC });
        }
      } else {
        const ref = anchorBar.c;
        for (let i = 0; i < ordered.length; i += 1) {
          const r = ordered[i];
          let gO = baseP + (r.o - ref);
          let gH = baseP + (r.h - ref);
          let gL = baseP + (r.l - ref);
          let gC = baseP + (r.c - ref);
          if (flipped) { gO = baseP - (r.o - ref); gH = baseP - (r.l - ref); gL = baseP - (r.h - ref); gC = baseP - (r.c - ref); }
          const x = o.x + bstep * i;
          const yO = yP(gO), yH = yP(gH), yL = yP(gL), yC = yP(gC);
          if (![x, yO, yH, yL, yC].every(Number.isFinite)) continue;
          bout.push({ op: 'line', x1: x, y1: yH, x2: x, y2: yL });
          bout.push({ op: 'line', x1: x - bhalf, y1: yO, x2: x, y2: yO });
          bout.push({ op: 'line', x1: x, y1: yC, x2: x + bhalf, y2: yC });
        }
      }
      if (d.showCount !== false && ordered.length) {
        const n = ordered.length;
        const blabel = n === 1 ? '1 bar' : `${n} bars`;
        const gx = Math.min(Math.max(o.x, left + 30), right - 30);
        let gy = o.y - 10;
        const gtop = c.geom.top, gbot = c.geom.top + (c.geom.height || 0);
        if (Number.isFinite(gtop) && Number.isFinite(gbot)) gy = Math.min(Math.max(gy, gtop + 12), gbot - 4);
        bout.push({ op: 'text', x: gx, y: gy, text: blabel, align: 'center' });
        if (typeof d.text === 'string' && d.text.trim() !== '') {
          bout.push({ op: 'text', x: gx, y: gy + 12, text: d.text.trim(), align: 'center' });
        }
      } else if (typeof d.text === 'string' && d.text.trim() !== '') {
        bout.push({ op: 'text', x: o.x, y: o.y - 8, text: d.text.trim(), align: 'center' });
      }
      return bout;
    }
    case 'ghostfeed': {
      // Ghost Feed: N chained translucent standard candles along the user
      // vector a->b (any direction, incl. backwards). Deterministic
      // data-seeded jitter; range calibrated from recent bars.
      if (!a || !b) return [];
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return [];
      const step0 = (c.barWidth && c.barWidth()) || 8;
      const gstep = Number.isFinite(step0) && step0 > 0 ? step0 : 8;
      const gdx = b.x - a.x, gdy = b.y - a.y;
      const dist = Math.hypot(gdx, gdy);
      if (!(dist >= 2)) return [];
      let n = Math.round(Math.abs(gdx) / gstep);
      if (!(n >= 2)) n = Math.round(dist / gstep);
      if (!Number.isFinite(n)) return [];
      n = Math.max(2, Math.min(30, n));
      let hlPx = NaN;
      try {
        const gwin = c.window ? c.window(a.x, b.x) : [];
        if (gwin && gwin.length) {
          let s = 0, k = 0;
          for (const r of gwin) {
            if (!r || !Number.isFinite(r.h) || !Number.isFinite(r.l)) continue;
            const yh = c.yForPrice(r.h), yl = c.yForPrice(r.l);
            if (!Number.isFinite(yh) || !Number.isFinite(yl)) continue;
            s += Math.abs(yl - yh); k += 1;
          }
          if (k > 0) hlPx = s / k;
        }
        if (!Number.isFinite(hlPx) && c.lastRow) {
          const lr = c.lastRow();
          if (lr && Number.isFinite(lr.h) && Number.isFinite(lr.l)) {
            const yh = c.yForPrice(lr.h), yl = c.yForPrice(lr.l);
            if (Number.isFinite(yh) && Number.isFinite(yl)) hlPx = Math.abs(yl - yh);
          }
        }
      } catch { hlPx = NaN; }
      const driftPer = Math.abs(gdy) / n;
      if (!Number.isFinite(hlPx) || hlPx <= 0) hlPx = Math.max(10, driftPer * 1.6);
      hlPx = Math.min(80, Math.max(6, Math.max(hlPx, driftPer * 1.4 + 4)));
      const bodyW = Math.max(2, Math.min(20, gstep * 0.6));
      const gp0 = d.points[0], gp1 = d.points[1];
      const seed = ((gp0 && Number.isFinite(gp0.t) ? (gp0.t % 100000) / 100000 : 0)
        + (gp1 && Number.isFinite(gp1.t) ? (gp1.t % 100000) / 100000 : 0)
        + (gp0 && Number.isFinite(gp0.p) ? gp0.p * 0.001 : 0)
        + (gp1 && Number.isFinite(gp1.p) ? gp1.p * 0.001 : 0)) || 0;
      const fract = (v) => v - Math.floor(v);
      const j1 = (i) => fract(Math.sin(i * 127.1 + seed * 311.7) * 43758.5453) * 2 - 1;
      const j2 = (i) => fract(Math.sin(i * 269.5 + seed * 183.3) * 28001.8384) * 2 - 1;
      const gout = [{ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, dash: [4, 4] }];
      const xSpan = Math.abs(gdx);
      const xDir = gdx !== 0 ? Math.sign(gdx) : 1;
      let prevClose = a.y;
      for (let i = 0; i < n; i += 1) {
        const f = (i + 0.5) / n;
        const cx = xSpan >= gstep ? a.x + gdx * f : a.x + xDir * (i + 0.5) * gstep;
        const gtarget = a.y + gdy * ((i + 1) / n);
        const closeY = gtarget + j1(i) * hlPx * 0.18;
        const openY = prevClose;
        prevClose = closeY;
        let bTop = Math.min(openY, closeY), bH = Math.abs(closeY - openY);
        if (!(bH >= 2)) { bTop -= (2 - bH) / 2; bH = 2; }
        const wUp = hlPx * 0.22 + Math.abs(j2(i)) * hlPx * 0.22;
        const wDn = hlPx * 0.22 + Math.abs(j1(i + 57)) * hlPx * 0.22;
        const hiY = Math.min(openY, closeY) - wUp;
        const loY = Math.max(openY, closeY) + wDn;
        if (![cx, hiY, loY, bTop, bH].every(Number.isFinite)) continue;
        gout.push({ op: 'line', x1: cx, y1: hiY, x2: cx, y2: loY });
        gout.push({ op: 'rect', x: cx - bodyW / 2, y: bTop, w: bodyW, h: bH, fill: 0.12 });
      }
      return gout;
    }
    case 'sector': {
      // Sector: filled pie-slice projection cone from the origin O.
      // 3-anchor mode uses both edges; 2-anchor mode uses the horizontal
      // through O as the baseline edge and OA as the angled edge.
      const p2 = d.points[2];
      const cc = p2 ? c.xy(p2) : null;
      if (!a || !b) return [];
      const ox = a.x, oy = a.y;
      const R = Math.hypot(b.x - ox, b.y - oy);
      if (!Number.isFinite(R) || !(R >= 2)) return [];
      let t0, t1;
      if (cc && Number.isFinite(cc.x) && Number.isFinite(cc.y)
        && Math.hypot(cc.x - ox, cc.y - oy) >= 2) {
        t0 = Math.atan2(b.y - oy, b.x - ox);
        t1 = Math.atan2(cc.y - oy, cc.x - ox);
      } else {
        t0 = (b.x - ox) >= 0 ? 0 : Math.PI;
        t1 = Math.atan2(b.y - oy, b.x - ox);
      }
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) return [];
      let delta = ((t1 - t0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      if (!Number.isFinite(delta)) return [];
      if (Math.abs(Math.abs(delta) - Math.PI) < 1e-9) delta = Math.PI;
      const sweep = Math.abs(delta);
      if (!(sweep >= 0)) return [];
      const sa0 = delta >= 0 ? t0 : t0 + delta;
      const sa1 = delta >= 0 ? t0 + delta : t0;
      const sout = [];
      const showFill = d.showBackground !== false;
      const showEdge = d.showBorder !== false;
      const ex = (t) => ({ x: ox + Math.cos(t) * R, y: oy + Math.sin(t) * R });
      if (sweep < 1e-6) {
        if (showEdge) {
          const e = ex(t1);
          sout.push({ op: 'line', x1: ox, y1: oy, x2: e.x, y2: e.y });
        }
        return sout;
      }
      if (showFill) {
        const rim = sample((t) => {
          const tt = sa0 + (sa1 - sa0) * t;
          return { x: ox + Math.cos(tt) * R, y: oy + Math.sin(tt) * R };
        }, 32);
        sout.push({ op: 'path', pts: [{ x: ox, y: oy }, ...rim], close: true, fill: 0.08 });
      }
      if (showEdge) {
        const e0 = ex(sa0), e1 = ex(sa1);
        sout.push({ op: 'line', x1: ox, y1: oy, x2: e0.x, y2: e0.y });
        sout.push({ op: 'line', x1: ox, y1: oy, x2: e1.x, y2: e1.y });
        sout.push({ op: 'arc', cx: ox, cy: oy, r: R, a0: sa0, a1: sa1 });
      }
      if (d.showLabels !== false) {
        const deg = (sweep * 180) / Math.PI;
        const degLabel = (Math.abs(deg % 1) < 0.05 ? String(Math.round(deg)) : deg.toFixed(1)) + '°';
        const smid = (sa0 + sa1) / 2;
        const rLab = R >= 44 ? R - 16 : R + 16;
        sout.push({
          op: 'text',
          x: ox + Math.cos(smid) * rLab,
          y: oy + Math.sin(smid) * rLab + 4,
          text: degLabel,
          align: 'center',
        });
      }
      return sout;
    }
    case 'vwap': {
      // Anchored VWAP: single-pass cumulative VWAP from the anchor bar plus
      // TV-style volume-weighted standard-deviation bands (opt-in).
      if (!a) return [];
      const srcOf = (r) => {
        switch (d.source) {
          case 'open': return r.o;
          case 'high': return r.h;
          case 'low': return r.l;
          case 'close': return r.c;
          case 'hl2': return (r.h + r.l) / 2;
          case 'ohlc4': return (r.o + r.h + r.l + r.c) / 4;
          case 'hlc3': default: return (r.h + r.l + r.c) / 3;
        }
      };
      const all = Array.isArray(c.rows) ? c.rows : [];
      const vrows = (p0 && Number.isFinite(p0.t))
        ? all.filter((r) => r && Number.isFinite(r.t) && r.t >= p0.t)
        : (c.window ? c.window(a.x, right) : []);
      const session = d.reset === 'session' || d.variant === 'session';
      const acc = [];
      let pv = 0, vv = 0, q = 0, prevDay = null;
      for (const r of vrows) {
        const s = srcOf(r), v = +r.v;
        if (!Number.isFinite(s) || !Number.isFinite(v) || v < 0) continue;
        if (session) {
          const g = new Date(r.t);
          const day = g.getUTCFullYear() * 10000 + (g.getUTCMonth() + 1) * 100 + g.getUTCDate();
          if (prevDay !== null && day !== prevDay) { pv = 0; vv = 0; q = 0; }
          prevDay = day;
        }
        pv += s * v; vv += v; q += s * s * v;
        const m = vv > 0 ? pv / vv : s;
        const sd = vv > 0 ? Math.sqrt(Math.max(0, q / vv - m * m)) : 0;
        const x = c.xForRow ? c.xForRow(r) : a.x;
        if (!Number.isFinite(x)) continue;
        acc.push({ x, v: m, sd });
      }
      if (!acc.length) return [];
      const ctr = acc.map((pp) => ({ x: pp.x, y: c.yForPrice(pp.v) }));
      let ks = [];
      if (Array.isArray(d.bands)) ks = d.bands.map((k) => +k).filter((k) => Number.isFinite(k) && k > 0).slice(0, 3);
      else if (Number.isFinite(+d.mult) && +d.mult > 0) ks = [+d.mult];
      else if (Number.isFinite(+d.multiplier) && +d.multiplier > 0) ks = [+d.multiplier];
      else if (d.showBands === true) ks = [1, 2, 3];
      const pct = /^(percent|percentage|pct)$/i.test(String(d.bandsMode || d.bandMode || ''));
      if (!pct && !acc.some((pp) => pp.sd > 0)) ks = [];
      const showUp = d.showUpper !== false && d.useUpper !== false;
      const showDn = d.showLower !== false && d.useLower !== false;
      const off = (pp, k, side) => (pct ? pp.v * (1 + (side * k) / 100) : pp.v + side * k * pp.sd);
      const vout = [];
      if (d.showBands !== false) {
        [...ks].sort((x, y) => y - x).forEach((k) => {
          if (showUp) vout.push({ op: 'path', pts: [...ctr, ...acc.map((pp) => ({ x: pp.x, y: c.yForPrice(off(pp, k, 1)) })).reverse()], close: true, fill: 0.06 });
          if (showDn) vout.push({ op: 'path', pts: [...ctr, ...acc.map((pp) => ({ x: pp.x, y: c.yForPrice(off(pp, k, -1)) })).reverse()], close: true, fill: 0.06 });
        });
      }
      if (d.showBase !== false) vout.push({ op: 'path', pts: ctr });
      ks.forEach((k) => {
        if (showUp) vout.push({ op: 'path', pts: acc.map((pp) => ({ x: pp.x, y: c.yForPrice(off(pp, k, 1)) })), dash: [5, 4] });
        if (showDn) vout.push({ op: 'path', pts: acc.map((pp) => ({ x: pp.x, y: c.yForPrice(off(pp, k, -1)) })), dash: [5, 4] });
      });
      const pin = (y) => Math.min(top + height - 8, Math.max(top + 10, y));
      const vlast = acc[acc.length - 1];
      ks.forEach((k) => {
        const tag = pct ? `${k}%` : `${k}σ`;
        if (showUp) vout.push({ op: 'text', x: right - 6, y: pin(c.yForPrice(off(vlast, k, 1))) - 4, text: `+${tag}`, align: 'right' });
        if (showDn) vout.push({ op: 'text', x: right - 6, y: pin(c.yForPrice(off(vlast, k, -1))) + 12, text: `-${tag}`, align: 'right' });
      });
      vout.push({ op: 'line', x1: a.x, y1: top, x2: a.x, y2: top + height });
      return vout;
    }
    case 'volprofile': {
      // Volume Profile: side histogram with POC line, 70% value-area band
      // and POC/VAH/VAL labels. Fixed uses the anchor span; anchored runs
      // from the first anchor to the right edge.
      if (!a || !b) return [];
      if (!Number.isFinite(a.x) || !Number.isFinite(b.x)) return [];
      const anchored = d.variant === 'anchored';
      const step0 = (typeof c.barWidth === 'function' ? (c.barWidth() || 8) : 8) || 8;
      let xL = anchored ? a.x : Math.min(a.x, b.x);
      let xR = anchored ? c.geom.right : Math.max(a.x, b.x);
      if (!Number.isFinite(xL) || !Number.isFinite(xR)) return [];
      let queryL = xL, queryR = xR;
      if (xR - xL < step0) {
        if (anchored) { queryL = xL; queryR = xL + step0; xR = c.geom.right; }
        else { const vmid = (xL + xR) / 2; queryL = vmid - step0 / 2; queryR = vmid + step0 / 2; xL = vmid - 20; xR = vmid + 20; }
      }
      const vwin = (typeof c.window === 'function') ? (c.window(queryL, queryR) || []) : [];
      let lo = Infinity, hi = -Infinity;
      for (const r of vwin) {
        if (!r) continue;
        if (Number.isFinite(r.l)) lo = Math.min(lo, r.l);
        if (Number.isFinite(r.h)) hi = Math.max(hi, r.h);
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        const ps = [p0 && p0.p, p1 && p1.p].filter(Number.isFinite);
        if (!ps.length) return [];
        lo = Math.min(...ps); hi = Math.max(...ps);
        if (!(hi > lo)) { const e = Math.max(1, Math.abs(lo) * 0.001); lo -= e; hi += e; }
      }
      if (!(hi > lo)) {
        const e = Math.max(1, Math.abs(lo || hi || 1) * 0.002);
        const m = Number.isFinite(lo) ? lo : 0;
        lo = m - e; hi = m + e;
      }
      let vols = null;
      try {
        const raw = c.volProfile(queryL, queryR);
        if (Array.isArray(raw) && raw.length) vols = raw.map((qq) => Math.max(0, Number((qq && qq.v)) || 0));
      } catch { vols = null; }
      const N = (vols && vols.length) ? vols.length : 24;
      if (!vols || !vols.length || !vols.some((vv) => vv > 0)) {
        vols = new Array(N).fill(0);
        const span = (hi - lo) || 1;
        for (const r of vwin) {
          if (!r || !Number.isFinite(r.c) || !Number.isFinite(r.v)) continue;
          let i = Math.floor(((r.c - lo) / span) * N);
          if (!Number.isFinite(i)) continue;
          i = Math.min(N - 1, Math.max(0, i));
          vols[i] += r.v;
        }
      }
      const n = vols.length;
      const total = vols.reduce((s, vv) => s + (Number.isFinite(vv) ? vv : 0), 0);
      const yP = (p) => c.yForPrice(p);
      const yHi = yP(hi), yLo = yP(lo);
      if (!Number.isFinite(yHi) || !Number.isFinite(yLo)) return [];
      const yTop = Math.min(yHi, yLo), yBot = Math.max(yHi, yLo);
      if (!(yBot > yTop)) return [];
      const W = Math.max(8, xR - xL);
      const volout = [{ op: 'rect', x: xL, y: yTop, w: W, h: Math.max(2, yBot - yTop), fill: 0.07 }];
      if (!(total > 0)) return volout;
      const maxV = Math.max(...vols) || 1;
      let poc = 0;
      for (let i = 1; i < n; i += 1) if (vols[i] > vols[poc]) poc = i;
      const fracRaw = Number.isFinite(d.vaFrac) ? d.vaFrac : (Number.isFinite(d.vaPct) ? d.vaPct / 100 : 0.7);
      const frac = Math.min(0.95, Math.max(0.05, fracRaw || 0.7));
      let vtarget = total * frac - vols[poc];
      let up = poc + 1, dn = poc - 1, vah = poc, val = poc;
      while (vtarget > 0 && (up < n || dn >= 0)) {
        const vu = up < n ? vols[up] : -1, vd = dn >= 0 ? vols[dn] : -1;
        let takeUp = true;
        if (vu < 0) takeUp = false;
        else if (vd < 0) takeUp = true;
        else if (vu !== vd) takeUp = vu > vd;
        else takeUp = (up - poc) <= (poc - dn);
        const cv = takeUp ? vu : vd;
        if (!(cv >= 0) || cv > vtarget) break;
        if (takeUp) { vah = up; up += 1; } else { val = dn; dn -= 1; }
        vtarget -= cv;
      }
      const dp = (hi - lo) / n;
      const ctr = (i) => lo + (i + 0.5) * dp;
      volout.push({ op: 'rect', x: xL, y: yP(lo + (vah + 1) * dp), w: W, h: Math.max(2, yP(lo + val * dp) - yP(lo + (vah + 1) * dp)), fill: 0.12 });
      for (let i = 0; i < n; i += 1) {
        if (!(vols[i] > 0)) continue;
        const yt = yP(lo + (i + 1) * dp), yb = yP(lo + i * dp);
        if (!Number.isFinite(yt) || !Number.isFinite(yb)) continue;
        const len = Math.min(W, (vols[i] / maxV) * W);
        const inVA = i >= val && i <= vah;
        volout.push({ op: 'rect', x: xL, y: Math.min(yt, yb) + 0.5, w: Math.max(2, len), h: Math.max(2, Math.abs(yb - yt) - 1), fill: i === poc ? 0.30 : (inVA ? 0.22 : 0.10) });
      }
      const lineEnd = anchored ? c.geom.right : xR;
      const pocY = yP(ctr(poc)), vahY = yP(ctr(vah)), valY = yP(ctr(val));
      const vm = Math.max(Math.abs(lo), Math.abs(hi));
      const fmtP = (p) => (vm >= 1000
        ? Math.round(p).toLocaleString('en-US')
        : (vm >= 1
          ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : p.toLocaleString('en-US', { maximumFractionDigits: 4 })));
      const fmtV = (vv) => (vv >= 1000 ? `${(vv / 1000).toFixed(2)}K` : String(Math.round(vv)));
      if (Number.isFinite(pocY)) volout.push({ op: 'line', x1: xL, y1: pocY, x2: lineEnd, y2: pocY });
      if (Number.isFinite(vahY) && vah !== poc) volout.push({ op: 'line', x1: xL, y1: vahY, x2: lineEnd, y2: vahY, dash: [4, 4] });
      if (Number.isFinite(valY) && val !== poc) volout.push({ op: 'line', x1: xL, y1: valY, x2: lineEnd, y2: valY, dash: [4, 4] });
      if (Number.isFinite(pocY)) volout.push({ op: 'text', x: lineEnd - 4, y: Math.max(yTop + 10, pocY - 3), text: `POC ${fmtP(ctr(poc))}`, align: 'right' });
      if (Number.isFinite(vahY) && vah !== poc) volout.push({ op: 'text', x: lineEnd - 4, y: Math.max(yTop + 10, vahY - 3), text: `VAH ${fmtP(ctr(vah))}`, align: 'right' });
      if (Number.isFinite(valY) && val !== poc) volout.push({ op: 'text', x: lineEnd - 4, y: Math.min(yBot - 2, valY + 11), text: `VAL ${fmtP(ctr(val))}`, align: 'right' });
      if (vwin.length) volout.push({ op: 'text', x: xL + 4, y: yTop + 12, text: `${vwin.length} bars · ${fmtV(total)}`, align: 'left' });
      return volout.filter((pp) => pp && Object.values(pp).every((vv) => vv == null || typeof vv !== 'number' || Number.isFinite(vv)));
    }
    case 'pricerange': {
      // Price Range: shaded band between the anchor prices across the chart
      // with boundary lines and a compact stats panel (abs + % + ticks).
      if (!p0 || !p1) return [];
      if (!Number.isFinite(p0.p) || !Number.isFinite(p1.p)) return [];
      if (!a || !b) return [];
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return [];
      if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) return [];
      if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return [];
      const bottom = top + height;
      const lo = Math.min(p0.p, p1.p), hi = Math.max(p0.p, p1.p);
      const yTop = Math.min(a.y, b.y), yBot = Math.max(a.y, b.y);
      const h = yBot - yTop;
      let x0 = left, x1 = right;
      if (d.extend === false) {
        x0 = Math.min(a.x, b.x); x1 = Math.max(a.x, b.x);
        if (x1 - x0 < 2) { const mx = (x0 + x1) / 2; x0 = mx - 20; x1 = mx + 20; }
        x0 = Math.max(x0, left); x1 = Math.min(x1, right);
        if (x1 <= x0) { x0 = left; x1 = right; }
      }
      const prout = [];
      if (d.showBackground !== false && h >= 0.5) {
        prout.push({ op: 'rect', x: x0, y: yTop, w: x1 - x0, h, fill: 0.07 });
      }
      if (h >= 0.5) {
        prout.push({ op: 'line', x1: x0, y1: yTop, x2: x1, y2: yTop });
        prout.push({ op: 'line', x1: x0, y1: yBot, x2: x1, y2: yBot });
      } else {
        prout.push({ op: 'line', x1: x0, y1: (yTop + yBot) / 2, x2: x1, y2: (yTop + yBot) / 2 });
      }
      const abs = hi - lo;
      const fmtAbs = (() => {
        if (!Number.isFinite(abs)) return '';
        if (abs >= 1) return abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (abs > 0) return abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
        return '0.00';
      })();
      const base = Math.abs(p0.p);
      const pct = base > 0 ? (abs / base) * 100 : NaN;
      const pctStr = Number.isFinite(pct) ? `${pct.toFixed(2)}%` : '—';
      const want = Array.isArray(d.stats) ? d.stats.map((s) => String(s).toLowerCase()) : null;
      const showPrice = !want || want.includes('price') || want.includes('range');
      const showPct = !want || want.includes('percent') || want.includes('change') || want.includes('%');
      const tick = Number(d.tickSize ?? d.mintick ?? d.pipSize);
      const showTicks = Number.isFinite(tick) && tick > 0
        && (!want || want.includes('pips') || want.includes('ticks') || want.includes('pip'));
      const prows = [];
      const cap = typeof d.text === 'string' ? d.text.trim() : '';
      if (cap) prows.push(cap);
      if (showPrice || showPct) {
        if (showPrice && showPct) prows.push(`${fmtAbs} (${pctStr})`);
        else if (showPrice) prows.push(fmtAbs);
        else prows.push(pctStr);
      }
      if (showTicks) prows.push(`${Math.round(abs / tick).toLocaleString('en-US')} ticks`);
      if (d.showLabel !== false && prows.length) {
        const cut = prows.slice(0, 4);
        const longest = Math.max(...cut.map((s) => s.length));
        const W = Math.min(240, Math.max(120, Math.round(longest * 6.8 + 20)));
        const H = 18 + (cut.length - 1) * 14 + 12;
        const cx = (x0 + x1) / 2, cy = (yTop + yBot) / 2;
        const prbx = Math.min(Math.max(cx - W / 2, left + 4), Math.max(left + 4, right - W - 4));
        const prby = Math.min(Math.max(cy - H / 2, top + 4), Math.max(top + 4, bottom - H - 4));
        prout.push({ op: 'box', x: Math.round(prbx), y: Math.round(prby), w: W, h: H, label: cut.join('\n') });
      }
      return prout;
    }
    case 'daterange': {
      // Date Range: full-height time band. Date and Price Range
      // (d.variant === 'price'): bounded time x price rectangle. Both carry
      // a stats panel: bars + date span, plus abs + % for the price variant
      // and accumulated volume when rows are available.
      const dp0 = d.points[0], dp1 = d.points[1];
      if (!a || !b || !dp0 || !dp1) return [];
      if (!Number.isFinite(dp0.t) || !Number.isFinite(dp1.t)) return [];
      if (!Number.isFinite(dp0.p) || !Number.isFinite(dp1.p)) return [];
      const priceVariant = d.variant === 'price';
      const bottom = top + height;
      const x = Math.min(a.x, b.x), w = Math.abs(b.x - a.x);
      const y = priceVariant ? Math.min(a.y, b.y) : top;
      const h = priceVariant ? Math.abs(b.y - a.y) : height;
      const t0 = Math.min(dp0.t, dp1.t), t1 = Math.max(dp0.t, dp1.t);
      const srows = Array.isArray(c.rows) ? c.rows : [];
      let bars = 0;
      if (srows.length) {
        const si0 = srows.findIndex((r) => r && r.t === dp0.t);
        const si1 = srows.findIndex((r) => r && r.t === dp1.t);
        if (si0 >= 0 && si1 >= 0) {
          bars = Math.abs(si1 - si0) + 1;
        } else {
          const sts = srows.map((r) => r && r.t).filter(Number.isFinite).sort((m, n) => m - n);
          const step = sts.length > 1 ? (sts[sts.length - 1] - sts[0]) / (sts.length - 1) : 0;
          if (step > 0) {
            bars = Math.round(Math.abs(dp1.t - dp0.t) / step) + 1;
          } else {
            const vis = c.state && c.state.visible;
            const bms = vis && Number.isFinite(vis.from) && Number.isFinite(vis.to) && srows.length > 1
              ? (vis.to - vis.from) / srows.length : 0;
            bars = bms > 0 ? Math.round(Math.abs(dp1.t - dp0.t) / bms) + 1 : 0;
          }
        }
      } else {
        const barW = (c.barWidth && c.barWidth()) || 8;
        bars = Math.round(Math.abs(b.x - a.x) / Math.max(1, barW)) + 1;
      }
      bars = Math.max(1, bars || 0);
      let vol = 0, hasVol = false;
      for (const r of srows) {
        if (r && Number.isFinite(r.t) && r.t >= t0 && r.t <= t1 && Number.isFinite(r.v)) {
          vol += r.v; hasVol = true;
        }
      }
      const fmtVol = (v) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B`
        : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M`
        : v >= 1000 ? `${(v / 1000).toFixed(2)}K` : String(Math.round(v)));
      const statLines = [bars === 1 ? '1 bar' : `${bars} bars`, c.dateLabel(dp0.t, dp1.t)];
      if (priceVariant) {
        const dpr = dp1.p - dp0.p, adpr = Math.abs(dpr);
        const dec = adpr >= 100 ? 0 : 2;
        const dfmt = (vv) => vv.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
        const sgn = dpr > 0 ? '+' : (dpr < 0 ? '-' : '');
        const pct = dp0.p !== 0 ? (dpr / Math.abs(dp0.p)) * 100 : 0;
        const pctStr = `${pct > 0 ? '+' : (pct < 0 ? '-' : '')}${Math.abs(pct).toFixed(2)}%`;
        statLines.push(`${sgn}${dfmt(adpr)} (${pctStr})`);
      }
      if (hasVol && vol > 0) statLines.push(`Vol ${fmtVol(vol)}`);
      const rows4 = statLines.slice(0, 4);
      const longest = Math.max(...rows4.map((s) => s.length));
      const boxW = Math.min(240, Math.max(120, Math.round(longest * 6.8 + 20)));
      const boxH = 18 + (rows4.length - 1) * 14 + 12;
      const dmx = x + w / 2, dmy = y + h / 2;
      const dbx = Math.min(Math.max(dmx - boxW / 2, left + 4), Math.max(left + 4, right - boxW - 4));
      let dby = dmy - boxH - 10;
      if (dby < top + 4) dby = dmy + 12;
      dby = Math.min(Math.max(dby, top + 4), bottom - boxH - 4);
      return [
        { op: 'rect', x, y, w, h, fill: 0.07 },
        { op: 'box', x: Math.round(dbx), y: Math.round(dby), w: boxW, h: boxH, label: rows4.join('\n') },
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
    case 'rect': {
      // Rectangle: axis-aligned box with background fill, dashed-border and
      // middle-line support, plus an optional centered caption.
      if (!a || !b) return [];
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return [];
      let x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const ext = typeof d.extend === 'string' ? d.extend : 'none';
      if (ext === 'left' || ext === 'both') x0 = c.geom.left;
      if (ext === 'right' || ext === 'both') x1 = c.geom.right;
      const rw = x1 - x0, rh = y1 - y0;
      if (!(rw >= 2 && rh >= 2)) return [];
      if (!Number.isFinite(rw) || !Number.isFinite(rh)) return [];
      const rawFill = Number(d.fill);
      const explicitFill = Number.isFinite(rawFill) && rawFill > 0
        ? Math.min(1, rawFill) : undefined;
      const wantFill = d.showFill !== false && d.background !== false;
      const fill = explicitFill !== undefined ? explicitFill : (wantFill ? 0.08 : undefined);
      const rmdash = Array.isArray(d.dash) ? d.dash : undefined;
      const rout = [];
      const rbox = { op: 'rect', x: x0, y: y0, w: rw, h: rh };
      if (fill !== undefined) rbox.fill = fill;
      if (rmdash) rbox.dash = rmdash;
      rout.push(rbox);
      if (d.showMiddle === true || d.middle === true) {
        const my = (y0 + y1) / 2;
        const mline = { op: 'line', x1: x0, y1: my, x2: x1, y2: my };
        if (Array.isArray(d.middleDash)) mline.dash = d.middleDash;
        rout.push(mline);
      }
      if (typeof d.text === 'string' && d.text.length) {
        rout.push({ op: 'text', x: (x0 + x1) / 2, y: (y0 + y1) / 2 + 4, text: d.text, align: 'center', size: 12 });
      }
      return rout;
    }
    case 'rotrect': {
      // Rotated rectangle: P0->P1 is the first edge (length + angle); P2
      // sets the width by signed perpendicular distance from that edge.
      // P0/P1 are always exact vertices so selection handles sit on paint.
      // 2-point legacy records degrade to an axis-aligned quad.
      const rmdash = Array.isArray(d.dash) ? d.dash : undefined;
      const rds = rmdash ? { dash: rmdash } : {};
      const rawFill = Number(d.fill);
      const explicitFill = Number.isFinite(rawFill) && rawFill > 0 ? Math.min(1, rawFill) : undefined;
      const wantFill = d.showBackground !== false && d.showFill !== false && d.background !== false;
      const rfill = wantFill ? (explicitFill !== undefined ? explicitFill : 0.08) : undefined;
      const F = rfill !== undefined ? { fill: rfill } : {};
      if (!a || !b) return [];
      const p2 = d.points[2];
      if (!p2 || !Number.isFinite(p2.t) || !Number.isFinite(p2.p)) {
        const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        if (w < 0.5 && h < 0.5) return [];
        if (w < 0.5 || h < 0.5) return [{ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...rds }];
        const QA = { x: a.x, y: a.y }, QB = { x: b.x, y: a.y };
        const QC = { x: b.x, y: b.y }, QD = { x: a.x, y: b.y };
        return [{ op: 'path', pts: [QA, QB, QC, QD, QA], close: true, ...rds, ...F }];
      }
      const wpt = c.xy(p2);
      if (!wpt || !Number.isFinite(wpt.x) || !Number.isFinite(wpt.y)) return [];
      const rex = b.x - a.x, rey = b.y - a.y;
      const L = Math.hypot(rex, rey);
      if (!(L > 1e-9) || !Number.isFinite(L)) return [];
      const ux = rex / L, uy = rey / L;
      const nx = -uy, ny = ux;
      const s = (wpt.x - a.x) * nx + (wpt.y - a.y) * ny;
      if (!Number.isFinite(s)) return [];
      if (Math.abs(s) < 0.5) {
        return [{ op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...rds }];
      }
      const C = { x: b.x + nx * s, y: b.y + ny * s };
      const D = { x: a.x + nx * s, y: a.y + ny * s };
      return [{ op: 'path', pts: [a, b, C, D, a], close: true, ...rds, ...F }];
    }
    case 'ellipse': {
      // Ellipse: opposite data corners. Circle variant: p0 = center (first
      // click), p1 = rim (radius click) — always a screen circle.
      if (!a || !b) return [];
      const eout = [];
      const SEG = 64, TAU = Math.PI * 2;
      const ring = (cx, cy, rx, ry) => {
        const epts = [];
        for (let i = 0; i <= SEG; i += 1) {
          const t = (i / SEG) * TAU;
          epts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
        }
        return epts;
      };
      const rawFill = Number(d.fill);
      const alpha = Number.isFinite(rawFill) && rawFill >= 0 ? Math.min(1, rawFill) : 0.2;
      const wantFill = d.fillBackground !== false && d.showFill !== false
        && d.background !== false && alpha > 0;
      const txt = typeof d.text === 'string' ? d.text.trim() : '';
      if (d.variant === 'circle') {
        const r = Math.hypot(b.x - a.x, b.y - a.y);
        if (!Number.isFinite(r) || r < 0.5) return [];
        if (wantFill) eout.push({ op: 'path', pts: ring(a.x, a.y, r, r), close: true, fill: alpha });
        eout.push({ op: 'ellipse', cx: a.x, cy: a.y, rx: r, ry: r });
        if (txt !== '') eout.push({ op: 'text', x: a.x, y: a.y + 5, text: txt, align: 'center', size: 14 });
        return eout;
      }
      const ecx = x + w / 2, ecy = y + h / 2, erx = w / 2, ery = h / 2;
      if (!Number.isFinite(ecx) || !Number.isFinite(ecy) || !Number.isFinite(erx) || !Number.isFinite(ery)) return [];
      if (erx < 0.5 || ery < 0.5) return [];
      if (wantFill) eout.push({ op: 'path', pts: ring(ecx, ecy, erx, ery), close: true, fill: alpha });
      eout.push({ op: 'ellipse', cx: ecx, cy: ecy, rx: erx, ry: ery });
      if (txt !== '') eout.push({ op: 'text', x: ecx, y: ecy + 5, text: txt, align: 'center', size: 14 });
      return eout;
    }
    case 'arc': {
      // Arc: 3-point interpolated parabola (cup/cup-handle). A,B = rim
      // endpoints (chord), M = on-curve apex at t=0.5 via control
      // C = 2M-(A+B)/2. Closed chord+curve region carries the fill.
      // 2-point records fall back to the bare chord.
      if (!a || !b) return [];
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return [];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) return [];
      const chord = { op: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      const m = d.points[2] ? c.xy(d.points[2]) : null;
      if (!m || ![m.x, m.y].every(Number.isFinite)) return [chord];
      const arcCx = 2 * m.x - (a.x + b.x) / 2;
      const arcCy = 2 * m.y - (a.y + b.y) / 2;
      if (!Number.isFinite(arcCx) || !Number.isFinite(arcCy)) return [chord];
      const at = (t) => {
        const u = 1 - t;
        return {
          x: u * u * a.x + 2 * u * t * arcCx + t * t * b.x,
          y: u * u * a.y + 2 * u * t * arcCy + t * t * b.y,
        };
      };
      const curve = sample(at, 48);
      if (curve.some((q) => !Number.isFinite(q.x) || !Number.isFinite(q.y))) return [chord];
      const aout = [{ op: 'path', pts: curve }, chord];
      const wantFill = d.showFill !== false && d.background !== false && d.showBackground !== false;
      if (wantFill) {
        const raw = Number(d.fill);
        const fill = Number.isFinite(raw) && raw > 0 ? Math.min(1, raw) : 0.08;
        const area = Math.abs((b.x - a.x) * (m.y - a.y) - (b.y - a.y) * (m.x - a.x)) / 2;
        if (area > 25) aout.unshift({ op: 'path', pts: [...curve, { x: a.x, y: a.y }], close: true, fill });
      }
      return aout;
    }
    default:
      return [];
  }
}

// --- annotations -----------------------------------------------------------
function annotations(d, c) {
  const a = c.xy(d.points[0]);
  const text = d.text || (d.kind === 'idea' ? 'Idea' : d.kind === 'post' ? 'Post' : 'Note');
  switch (d.kind) {
    case 'text': {
      // Single-anchor annotation: the anchor is the first line's text origin.
      // Background/border/wrap follow the Text dialog; all default OFF, so
      // the default render is still just text. Sized box wraps the laid-out
      // lines (and is what primDist hit-tests with its rect branch).
      if (!a) return [];
      const traw = typeof d.text === 'string' ? d.text : (d.text == null ? '' : String(d.text));
      const src = traw !== '' ? traw : 'Text';
      const size = Math.min(1300, Math.max(8, Math.round(Number(d.fontsize ?? d.fontSize ?? d.size) || 13)));
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const bold = d.bold === true || d.fontWeight === 'bold';
      const italic = d.italic === true;
      const ink = d.color ?? d.textColor ?? d.textcolor ?? null;
      const opRaw = Number(d.opacity);
      const topacity = Number.isFinite(opRaw) ? Math.min(1, Math.max(0, opRaw)) : undefined;
      const wrap = d.wordWrap === true || d.textWrap === true || d.wrap === true;
      const wrapW = Math.min(2000, Math.max(40, Math.round(Number(d.wordWrapWidth ?? d.wrapWidth ?? 400) || 400)));
      const fillOn = d.fillBackground === true || d.showBackground === true;
      const borderOn = d.drawBorder === true || d.showBorder === true;
      const bgColor = d.backgroundColor ?? d.bgColor ?? '#9BBED5';
      const borderColor = d.borderColor ?? '#667B8B';
      let bgAlpha = 0.3;
      if (Number.isFinite(+d.bgAlpha)) bgAlpha = +d.bgAlpha;
      else if (Number.isFinite(+d.backgroundOpacity)) bgAlpha = +d.backgroundOpacity;
      else if (Number.isFinite(+d.backgroundTransparency)) bgAlpha = 1 - (+d.backgroundTransparency) / 100;
      bgAlpha = Math.min(1, Math.max(0, bgAlpha));
      const lh = Math.round(size * 1.3);
      const asc = Math.round(size * 0.85);
      const desc = Math.round(size * 0.25);
      const padX = 7, padY = 5;
      const cw = (s) => s.length * size * 0.6;
      const tlines = [];
      for (const para of src.split(/\r?\n/)) {
        if (!wrap || cw(para) <= wrapW) { tlines.push(para); continue; }
        if (para === '') { tlines.push(''); continue; }
        let cur = '';
        const flush = () => { if (cur !== '') { tlines.push(cur); cur = ''; } };
        for (const tok of para.split(/\s+/).filter(Boolean)) {
          if (cw(tok) > wrapW) {
            flush();
            let chunk = '';
            for (const ch of tok) {
              if (chunk !== '' && cw(chunk + ch) > wrapW) { tlines.push(chunk); chunk = ch; }
              else chunk += ch;
            }
            if (chunk !== '') tlines.push(chunk);
            continue;
          }
          const trial = cur !== '' ? `${cur} ${tok}` : tok;
          if (cur !== '' && cw(trial) > wrapW) { tlines.push(cur); cur = tok; }
          else cur = trial;
        }
        flush();
      }
      if (!tlines.length) tlines.push('');
      const wText = Math.max(1, ...tlines.map((l) => cw(l)));
      const tbw = Math.ceil(wText + padX * 2);
      const tbh = Math.ceil(padY * 2 + asc + (tlines.length - 1) * lh + desc);
      const tbx = a.x - padX, tby = a.y - asc - padY;
      if (![tbx, tby, tbw, tbh].every(Number.isFinite) || tbw <= 0 || tbh <= 0) return [];
      const tout = [];
      if (fillOn || borderOn) {
        tout.push({
          op: 'rect', x: tbx, y: tby, w: tbw, h: tbh,
          ...(fillOn ? { fill: bgAlpha, bg: bgColor } : {}),
          ...(borderOn ? { border: borderColor } : {}),
          ...((fillOn && !borderOn) ? { noStroke: true } : {}),
          ...(topacity !== undefined ? { opacity: topacity } : {}),
        });
      }
      tlines.forEach((ln, i) => {
        if (ln === '') return;
        tout.push({
          op: 'text', x: a.x, y: a.y + i * lh, text: ln, align: 'left', size,
          ...(ink ? { color: ink } : {}),
          ...(bold ? { bold: true } : {}),
          ...(italic ? { italic: true } : {}),
          ...(topacity !== undefined ? { opacity: topacity } : {}),
        });
      });
      return tout;
    }
    case 'note': {
      // Sticky note (default) vs small pointer box (variant 'comment').
      // Single anchor = the linked point; the box is offset up-right and
      // sized to the wrapped caption, with a folded corner (note) or a
      // pointer tail (comment) plus an anchor dot.
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const isComment = d.variant === 'comment';
      const PAD_X = isComment ? 8 : 10;
      const MAX_W = isComment ? 180 : 220;
      const MIN_W = isComment ? 56 : 64;
      const LINE_H = 14;
      const MAX_CHARS = Math.max(8, Math.floor((MAX_W - PAD_X * 2) / 6.2));
      const MAX_LINES = 4;
      const nraw = (typeof d.text === 'string' && d.text.trim() !== '') ? d.text : 'Note';
      const paras = String(nraw).split(/\r?\n/);
      const nlines = [];
      for (const para of paras) {
        const words = para.split(/\s+/).filter(Boolean);
        if (!words.length) { nlines.push(''); continue; }
        let cur = '';
        for (const w of words) {
          if (w.length > MAX_CHARS) {
            if (cur) { nlines.push(cur); cur = ''; }
            for (let i = 0; i < w.length; i += MAX_CHARS) nlines.push(w.slice(i, i + MAX_CHARS));
            continue;
          }
          const trial = cur ? cur + ' ' + w : w;
          if (trial.length <= MAX_CHARS) cur = trial;
          else { nlines.push(cur); cur = w; }
        }
        if (cur) nlines.push(cur);
      }
      let vis = nlines.slice(0, MAX_LINES);
      if (nlines.length > MAX_LINES && vis.length) vis[vis.length - 1] += '…';
      if (!vis.length) vis = ['Note'];
      const maxLen = vis.reduce((m, ln) => Math.max(m, ln.length), 0);
      let nw = Math.ceil(maxLen * 6.2 + PAD_X * 2);
      if (!Number.isFinite(nw)) return [];
      nw = Math.min(MAX_W, Math.max(MIN_W, nw));
      const nh = 26 + (vis.length - 1) * LINE_H;
      let nbx = a.x + (isComment ? 10 : 12);
      let nby = a.y - nh - (isComment ? 12 : 14);
      const ng = c.geom;
      if (ng && Number.isFinite(ng.left) && Number.isFinite(ng.top)
          && Number.isFinite(ng.width) && Number.isFinite(ng.height)
          && Number.isFinite(ng.right) && Number.isFinite(ng.bottom)
          && ng.width > nw + 4 && ng.height > nh + 4) {
        nbx = Math.min(Math.max(nbx, ng.left + 2), ng.right - nw - 2);
        nby = Math.min(Math.max(nby, ng.top + 2), ng.bottom - nh - 2);
      }
      if (!Number.isFinite(nbx) || !Number.isFinite(nby)) return [];
      nbx = Math.round(nbx); nby = Math.round(nby);
      const nout = [
        { op: 'box', x: nbx, y: nby, w: nw, h: nh, label: vis.join('\n'), variant: isComment ? 'comment' : 'note' },
      ];
      const footX = Math.min(Math.max(a.x, nbx), nbx + nw);
      const footY = nby + nh;
      if (Math.hypot(a.x - footX, a.y - footY) > 2) {
        nout.push({ op: 'line', x1: a.x, y1: a.y, x2: footX, y2: footY });
      }
      if (isComment) {
        nout.push({ op: 'path', pts: [{ x: footX - 5, y: footY }, { x: footX + 5, y: footY }, { x: a.x, y: a.y }], close: true });
      } else {
        const s = Math.min(10, Math.floor(Math.min(nw, nh) / 3));
        if (s >= 4) {
          nout.push({ op: 'path', pts: [{ x: nbx + nw - s, y: nby }, { x: nbx + nw, y: nby }, { x: nbx + nw, y: nby + s }], close: true });
        }
      }
      nout.push({ op: 'line', x1: a.x, y1: a.y, x2: a.x, y2: a.y, arrows: 'dot' });
      return nout;
    }
    case 'pricenote': {
      // Price Note: the box always prints the anchor's price (adaptive
      // format) plus an optional custom note. A second anchor, when present,
      // positions the box; otherwise a 90px leader (flipped near the edge).
      const pnp0 = d.points && d.points[0];
      const px = pnp0 && pnp0.p;
      if (!Number.isFinite(px)) return [];
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const fmtPx = (p) => {
        if (!Number.isFinite(p)) return '';
        const m = Math.abs(p);
        if (m >= 1000) return Math.round(p).toLocaleString('en-US');
        if (m >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return p.toLocaleString('en-US', { maximumFractionDigits: 4 });
      };
      const priceStr = fmtPx(px);
      if (!priceStr) return [];
      const praw = typeof d.text === 'string' ? d.text.trim() : '';
      const pcustom = (!praw || praw.toLowerCase() === 'price note') ? '' : praw.split('\n').slice(0, 3).join('\n');
      const plabel = pcustom ? `${priceStr}\n${pcustom}` : priceStr;
      const plines = plabel.split('\n');
      const pnw = Math.min(300, Math.max(64, Math.max(...plines.map((s) => s.length)) * 7 + 18));
      const pnh = plines.length > 1 ? 36 : 22;
      const pg = (c && c.geom) || {};
      const pright = Number.isFinite(pg.right) ? pg.right : Infinity;
      const ptop = Number.isFinite(pg.top) ? pg.top : -Infinity;
      const pbottom = Number.isFinite(pg.bottom) ? pg.bottom : Infinity;
      const pleft = Number.isFinite(pg.left) ? pg.left : -Infinity;
      const clampY = (y) => {
        let yy = y;
        if (Number.isFinite(ptop)) yy = Math.max(yy, ptop + 2);
        if (Number.isFinite(pbottom)) yy = Math.min(yy, pbottom - pnh - 2);
        return yy;
      };
      const pndash = Array.isArray(d.dash) ? { dash: d.dash } : {};
      const bRaw = d.points.length > 1 ? c.xy(d.points[1]) : null;
      if (bRaw && Number.isFinite(bRaw.x) && Number.isFinite(bRaw.y)) {
        let pbx = bRaw.x;
        if (Number.isFinite(pleft) && Number.isFinite(pright) && pright - pleft >= pnw) pbx = Math.min(Math.max(pbx, pleft), pright - pnw);
        const pby = clampY(bRaw.y);
        return [
          { op: 'line', x1: a.x, y1: a.y, x2: pbx, y2: pby, ...pndash },
          { op: 'box', x: pbx, y: pby, w: pnw, h: pnh, label: plabel, variant: 'pricenote' },
          { op: 'ellipse', cx: a.x, cy: a.y, rx: 3, ry: 3 },
        ];
      }
      const dir = (Number.isFinite(pright) && a.x + 90 + pnw > pright) ? -1 : 1;
      const pbx = dir > 0 ? a.x + 90 : a.x - 90 - pnw;
      const pby = clampY(a.y);
      const pex = dir > 0 ? pbx : pbx + pnw;
      return [
        { op: 'line', x1: a.x, y1: a.y, x2: pex, y2: pby, ...pndash },
        { op: 'box', x: pbx, y: pby, w: pnw, h: pnh, label: plabel, variant: 'pricenote' },
        { op: 'ellipse', cx: a.x, cy: a.y, rx: 3, ry: 3 },
      ];
    }
    case 'pricelabel': {
      // Price Label: single-anchor price chip beside the point, vertically
      // centred on it, with a short connector + anchor dot. No custom
      // caption: on TV this tool has no text field — the price is the content.
      const plp0 = d.points && d.points[0];
      const plpx = plp0 && plp0.p;
      if (!Number.isFinite(plpx)) return [];
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const fmtPl = (p) => {
        if (!Number.isFinite(p)) return '';
        const m = Math.abs(p);
        if (m >= 1000) return Math.round(p).toLocaleString('en-US');
        if (m >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return p.toLocaleString('en-US', { maximumFractionDigits: 4 });
      };
      const plabel = fmtPl(plpx);
      if (!plabel) return [];
      const plw = Math.min(300, Math.max(64, plabel.length * 7 + 18));
      const plh = 22;
      const plg = (c && c.geom) || {};
      const plright = Number.isFinite(plg.right) ? plg.right : Infinity;
      const pltop = Number.isFinite(plg.top) ? plg.top : -Infinity;
      const plbottom = Number.isFinite(plg.bottom) ? plg.bottom : Infinity;
      const plleft = Number.isFinite(plg.left) ? plg.left : -Infinity;
      const clampPlY = (y) => {
        let yy = y;
        if (Number.isFinite(pltop)) yy = Math.max(yy, pltop + 2);
        if (Number.isFinite(plbottom)) yy = Math.min(yy, plbottom - plh - 2);
        return yy;
      };
      const GAP = 10;
      const dir = (Number.isFinite(plright) && a.x + GAP + plw > plright) ? -1 : 1;
      let plbx = dir > 0 ? a.x + GAP : a.x - GAP - plw;
      if (Number.isFinite(plleft) && Number.isFinite(plright) && plright - plleft >= plw) {
        plbx = Math.min(Math.max(plbx, plleft + 2), plright - plw - 2);
      }
      const plby = clampPlY(a.y - plh / 2);
      if (!Number.isFinite(plbx) || !Number.isFinite(plby)) return [];
      plbx = Math.round(plbx);
      const plbyR = Math.round(plby);
      const edgeX = dir > 0 ? plbx : plbx + plw;
      const midY = Math.min(Math.max(a.y, plbyR), plbyR + plh);
      const pldash = Array.isArray(d.dash) ? { dash: d.dash } : {};
      return [
        { op: 'line', x1: a.x, y1: a.y, x2: edgeX, y2: midY, ...pldash },
        { op: 'box', x: plbx, y: plbyR, w: plw, h: plh, label: plabel, variant: 'pricelabel' },
        { op: 'ellipse', cx: a.x, cy: a.y, rx: 3, ry: 3 },
      ];
    }
    case 'pin': {
      // Pin: single-anchor map-pin marker. The tip lands exactly on the
      // anchor; the head floats above it. Screen-space constants — the icon
      // keeps its size under pan/zoom. A custom note stays hidden until the
      // pin is clicked (= selected).
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const HEAD_R = 9;
      const HEAD_DY = 19;
      const cx = a.x, cy = a.y - HEAD_DY;
      const tpy = (HEAD_R * HEAD_R) / HEAD_DY;
      const tpx = Math.sqrt(Math.max(0.5, HEAD_R * HEAD_R - tpy * tpy));
      const aR = Math.atan2(tpy, tpx);
      const aL = Math.atan2(tpy, -tpx);
      const SWEEP = 24;
      const arc = [];
      for (let i = 0; i <= SWEEP; i += 1) {
        const ang = aL + ((aR + Math.PI * 2 - aL) * i) / SWEEP;
        arc.push({ x: cx + Math.cos(ang) * HEAD_R, y: cy + Math.sin(ang) * HEAD_R });
      }
      const pout = [
        { op: 'path', pts: [...arc, { x: a.x, y: a.y }], close: true, fill: 1 },
        { op: 'line', x1: a.x, y1: a.y, x2: cx, y2: cy },
      ];
      const praw = typeof d.text === 'string' ? d.text : (d.text == null ? '' : String(d.text));
      const sel = d.id != null && c.state != null && c.state.selectedId === d.id;
      if (praw.trim() !== '' && sel) {
        const paras = praw.trim().split(/\r?\n/);
        const vis = [];
        for (const para of paras) {
          const words = para.split(/\s+/).filter(Boolean);
          if (!words.length) { vis.push(''); continue; }
          let cur = '';
          for (const w of words) {
            if (w.length > 32) {
              if (cur) { vis.push(cur); cur = ''; }
              for (let i = 0; i < w.length; i += 32) vis.push(w.slice(i, i + 32));
              continue;
            }
            const trial = cur ? cur + ' ' + w : w;
            if (trial.length <= 32) cur = trial;
            else { vis.push(cur); cur = w; }
          }
          if (cur) vis.push(cur);
        }
        let boxLines = vis.slice(0, 4);
        if (vis.length > 4 && boxLines.length) boxLines[boxLines.length - 1] += '…';
        if (!boxLines.length) boxLines = [''];
        const maxLen = boxLines.reduce((m, ln) => Math.max(m, ln.length), 0);
        let nw = Math.ceil(maxLen * 6.2 + 20);
        if (!Number.isFinite(nw)) return pout;
        nw = Math.min(220, Math.max(64, nw));
        const nh = 26 + (boxLines.length - 1) * 14;
        const pg = (c && c.geom) || {};
        let pbx = cx + 12, pby = cy - HEAD_R - 8 - nh;
        if (Number.isFinite(pg.right) && pbx + nw > pg.right - 2) pbx = cx - 12 - nw;
        if (Number.isFinite(pg.left) && Number.isFinite(pg.right) && pg.right - pg.left >= nw + 4) {
          pbx = Math.min(Math.max(pbx, pg.left + 2), pg.right - nw - 2);
        }
        if (!Number.isFinite(pby) || (Number.isFinite(pg.top) && pby < pg.top + 2)) {
          pby = a.y + 10;
        }
        if (Number.isFinite(pg.top) && Number.isFinite(pg.bottom) && pg.bottom - pg.top >= nh + 4) {
          pby = Math.min(Math.max(pby, pg.top + 2), pg.bottom - nh - 2);
        }
        if ([pbx, pby, nw, nh].every(Number.isFinite)) {
          pbx = Math.round(pbx); pby = Math.round(pby);
          const above = pby + nh <= cy - HEAD_R + 2;
          const lx = above ? cx : a.x, ly = above ? cy - HEAD_R : a.y;
          const footX = Math.min(Math.max(lx, pbx), pbx + nw);
          const footY = above ? pby + nh : pby;
          if (Math.hypot(lx - footX, ly - footY) > 2) {
            pout.push({ op: 'line', x1: lx, y1: ly, x2: footX, y2: footY });
          }
          pout.push({ op: 'box', x: pbx, y: pby, w: nw, h: nh, label: boxLines.join('\n'), variant: 'pin' });
        }
      }
      return pout;
    }
    case 'table': {
      // Table: editable data grid. The single anchor is the table's top-left
      // corner; the grid extends right+down. Shape comes from the record when
      // present (`cells` row-major 2D array, explicit rows/cols counts,
      // colWidths/rowHeights), else the factory default empty 3x3 grid.
      // A second point, when present with >=8px span, sizes the table.
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const tg = (c && c.geom) || {};
      const tgl = Number.isFinite(tg.left) ? tg.left : -Infinity;
      const tgt = Number.isFinite(tg.top) ? tg.top : -Infinity;
      const tgr = Number.isFinite(tg.right) ? tg.right : Infinity;
      const tgb = Number.isFinite(tg.bottom) ? tg.bottom : Infinity;
      const tnum = (v, fb) => {
        const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? +v : NaN);
        return Number.isFinite(n) ? n : fb;
      };
      const tstr = (v) => {
        if (typeof v === 'string') return v;
        if (typeof v === 'number' && Number.isFinite(v)) return String(v);
        return '';
      };
      const cellOf = (v) => {
        if (v == null) return '';
        if (typeof v === 'object') {
          if (typeof v.text === 'string' || typeof v.text === 'number') return tstr(v.text);
          if (typeof v.value === 'string' || typeof v.value === 'number') return tstr(v.value);
          if (typeof v.label === 'string' || typeof v.label === 'number') return tstr(v.label);
          return '';
        }
        return tstr(v);
      };
      const rawCells = Array.isArray(d.cells) ? d.cells : (Array.isArray(d.data) ? d.data : null);
      const cells = rawCells ? rawCells.slice(0, 20).map((r) => (Array.isArray(r) ? r.slice(0, 12) : [r])) : [];
      let cellCols = 0;
      for (const r of cells) cellCols = Math.max(cellCols, r.length);
      const ccount = (v, fb) => {
        if (Array.isArray(v) || v == null) return fb;
        const n = Math.round(tnum(v, NaN));
        return Number.isFinite(n) ? n : fb;
      };
      const nrows = Math.min(20, Math.max(1, ccount(d.rows ?? d.rowCount ?? d.nrows, cells.length || 3)));
      const ncols = Math.min(12, Math.max(1, ccount(d.cols ?? d.columns ?? d.colCount ?? d.columnCount ?? d.ncols, cellCols || 3)));
      const grid = [];
      for (let r = 0; r < nrows; r += 1) {
        const row = [];
        for (let cc = 0; cc < ncols; cc += 1) {
          let s = '';
          if (r < cells.length && Array.isArray(cells[r]) && cc < cells[r].length) s = cellOf(cells[r][cc]);
          row.push(s);
        }
        grid.push(row);
      }
      if (!rawCells) {
        const traw = typeof d.text === 'string' ? d.text : '';
        const tclean = traw.trim();
        if (tclean !== '' && tclean.toLowerCase() !== 'table') {
          const tlines = tclean.split(/\r?\n/).slice(0, nrows);
          tlines.forEach((ln, r) => {
            const parts = ln.includes('\t') ? ln.split('\t') : (ln.includes('|') ? ln.split('|') : [ln]);
            for (let cc = 0; cc < Math.min(ncols, parts.length); cc += 1) {
              if (grid[r][cc] === '') grid[r][cc] = tstr(parts[cc]);
            }
          });
        }
      }
      const DEF_CW = 64, DEF_RH = 30;
      let x0 = a.x, y0 = a.y, tW = NaN, tH = NaN;
      const bRaw = d.points.length > 1 ? c.xy(d.points[1]) : null;
      if (bRaw && Number.isFinite(bRaw.x) && Number.isFinite(bRaw.y)
        && (Math.abs(bRaw.x - a.x) >= 8 || Math.abs(bRaw.y - a.y) >= 8)) {
        x0 = Math.min(a.x, bRaw.x);
        y0 = Math.min(a.y, bRaw.y);
        tW = Math.abs(bRaw.x - a.x);
        tH = Math.abs(bRaw.y - a.y);
      } else {
        tW = tnum(d.tableW ?? d.tableWidth ?? d.w ?? d.width, NaN);
        tH = tnum(d.tableH ?? d.tableHeight ?? d.h ?? d.height, NaN);
      }
      if (!Number.isFinite(tW) || tW <= 0) tW = ncols * DEF_CW;
      if (!Number.isFinite(tH) || tH <= 0) tH = nrows * DEF_RH;
      tW = Math.min(1200, Math.max(ncols * 24, tW));
      tH = Math.min(800, Math.max(nrows * 16, tH));
      if (Number.isFinite(tgr - tgl) && tgr - tgl > 8) tW = Math.min(tW, Math.max(ncols * 24, (tgr - tgl) - 4));
      if (Number.isFinite(tgb - tgt) && tgb - tgt > 8) tH = Math.min(tH, Math.max(nrows * 16, (tgb - tgt) - 4));
      if (Number.isFinite(tgl) && Number.isFinite(tgr) && tgr - tgl >= tW + 4) x0 = Math.min(Math.max(x0, tgl + 2), tgr - tW - 2);
      if (Number.isFinite(tgt) && Number.isFinite(tgb) && tgb - tgt >= tH + 4) y0 = Math.min(Math.max(y0, tgt + 2), tgb - tH - 2);
      if (![x0, y0, tW, tH].every(Number.isFinite) || tW <= 0 || tH <= 0) return [];
      x0 = Math.round(x0); y0 = Math.round(y0);
      tW = Math.round(tW); tH = Math.round(tH);
      const split = (arr, n, total) => {
        const sout = new Array(n).fill(total / n);
        if (Array.isArray(arr) && arr.length) {
          const ws = [];
          let ok = true, sum = 0;
          for (let i = 0; i < n; i += 1) {
            const w = tnum(arr[i], NaN);
            if (!Number.isFinite(w) || w <= 0) { ok = false; break; }
            ws.push(w); sum += w;
          }
          if (ok && sum > 0) for (let i = 0; i < n; i += 1) sout[i] = (total * ws[i]) / sum;
        }
        return sout;
      };
      const rawCW = [d.colWidths, d.columnWidths, d.widths, d.cols].find((v) => Array.isArray(v)) || null;
      const rawRH = [d.rowHeights, d.heights, d.rows].find((v) => Array.isArray(v)) || null;
      const colW = split(rawCW, ncols, tW);
      const rowH = split(rawRH, nrows, tH);
      const cbx = [x0];
      let accW = 0;
      for (let i = 0; i < ncols; i += 1) { accW += colW[i]; cbx.push(x0 + Math.round(accW)); }
      cbx[ncols] = x0 + tW;
      const cby = [y0];
      let accH = 0;
      for (let i = 0; i < nrows; i += 1) { accH += rowH[i]; cby.push(y0 + Math.round(accH)); }
      cby[nrows] = y0 + tH;
      let fs = Math.round(tnum(d.fontSize ?? d.fontsize ?? d.size ?? d.textSize, 12));
      if (!Number.isFinite(fs)) fs = 12;
      fs = Math.min(32, Math.max(8, fs));
      const rawAlign = String(d.align ?? d.textAlign ?? d.halign ?? 'left').toLowerCase();
      const talign = rawAlign.includes('center') || rawAlign.includes('middle') ? 'center'
        : (rawAlign.includes('right') || rawAlign === 'end' ? 'right' : 'left');
      const pickStr = (...vs) => {
        for (const v of vs) if (typeof v === 'string' && v) return v;
        return null;
      };
      const ink = pickStr(d.color, d.textColor, d.textcolor, d.fontColor) || '#131722';
      const bgc = pickStr(d.bg, d.backgroundColor, d.bgcolor, d.fillColor) || '#ffffff';
      let talpha = tnum(d.bgAlpha ?? d.backgroundOpacity ?? d.opacity, 1);
      if (Number.isFinite(+d.backgroundTransparency)) talpha = 1 - (+d.backgroundTransparency) / 100;
      talpha = Math.min(1, Math.max(0, talpha));
      const border = pickStr(d.border, d.borderColor, d.lineColor);
      const tout = [];
      const body = { op: 'rect', x: x0, y: y0, w: tW, h: tH };
      if (talpha > 0) { body.fill = talpha; body.bg = bgc; }
      if (border) body.border = border;
      tout.push(body);
      for (let i = 1; i < ncols; i += 1) tout.push({ op: 'line', x1: cbx[i], y1: y0, x2: cbx[i], y2: y0 + tH });
      for (let j = 1; j < nrows; j += 1) tout.push({ op: 'line', x1: x0, y1: cby[j], x2: x0 + tW, y2: cby[j] });
      for (let r = 0; r < nrows; r += 1) {
        const cy0 = cby[r], cy1 = cby[r + 1];
        if (!((cy1 - cy0) >= 8)) continue;
        for (let cc = 0; cc < ncols; cc += 1) {
          let tlabel = grid[r][cc];
          if (tlabel === '') continue;
          tlabel = String(tlabel).split(/\r?\n/)[0];
          if (tlabel === '') continue;
          const cx0 = cbx[cc], cx1 = cbx[cc + 1];
          if (!((cx1 - cx0) >= 16)) continue;
          const maxChars = Math.max(1, Math.floor(((cx1 - cx0) - 12) / (fs * 0.6)));
          const shown = tlabel.length > maxChars ? (maxChars > 1 ? tlabel.slice(0, maxChars - 1) + '…' : '…') : tlabel;
          const lx = talign === 'center' ? (cx0 + cx1) / 2 : (talign === 'right' ? cx1 - 6 : cx0 + 6);
          const ly = (cy0 + cy1) / 2 + fs * 0.35;
          if (![lx, ly].every(Number.isFinite)) continue;
          tout.push({ op: 'text', x: lx, y: ly, text: shown, align: talign, size: fs, color: ink });
        }
      }
      return tout;
    }
    case 'callout': {
      // Callout: P0 = point tip, P1 = container anchor. Teal bubble sized to
      // the laid-out text + padding, clamped in-plot; leader to the bubble
      // edge + speech-tail triangle + anchor dot.
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const bRaw = d.points.length > 1 ? c.xy(d.points[1]) : null;
      if (!bRaw || !Number.isFinite(bRaw.x) || !Number.isFinite(bRaw.y)) return [];
      const cp0 = d.points[0], cp1 = d.points[1];
      if (!cp0 || !cp1 || !Number.isFinite(cp0.p) || !Number.isFinite(cp1.p)) return [];
      if (!Number.isFinite(cp0.t) || !Number.isFinite(cp1.t)) return [];
      const craw = (typeof d.text === 'string' && d.text.trim() !== '') ? d.text : 'Callout';
      const csize = Math.min(72, Math.max(8, Math.round(Number(d.fontsize ?? d.fontSize ?? d.size) || 14)));
      const cbold = d.bold === true || d.fontWeight === 'bold';
      const citalic = d.italic === true;
      const cink = d.color ?? d.textColor ?? d.textcolor ?? '#ffffff';
      const cwrap = d.wordWrap === true || d.textWrap === true || d.wrap === true;
      const cwrapW = Math.min(2000, Math.max(40, Math.round(Number(d.wordWrapWidth ?? d.wrapWidth ?? 200) || 200)));
      const cbgColor = d.backgroundColor ?? d.bgColor ?? 'rgba(0,151,167,0.7)';
      let cbgAlpha = 1;
      if (Number.isFinite(+d.bgAlpha)) cbgAlpha = +d.bgAlpha;
      else if (Number.isFinite(+d.backgroundTransparency)) cbgAlpha = 1 - (+d.backgroundTransparency) / 100;
      else if (Number.isFinite(+d.transparency)) cbgAlpha = 1 - (+d.transparency) / 100;
      else if (Number.isFinite(+d.backgroundOpacity)) cbgAlpha = +d.backgroundOpacity;
      cbgAlpha = Math.min(1, Math.max(0, cbgAlpha));
      const cborderColor = d.bordercolor ?? d.borderColor ?? '#0097A7';
      const cdash = Array.isArray(d.dash) ? d.dash : undefined;
      const clh = Math.round(csize * 1.3);
      const casc = Math.round(csize * 0.85);
      const cdesc = Math.round(csize * 0.25);
      const cpadX = 12, cpadY = 8;
      const ccw = (s) => s.length * csize * 0.6;
      const clines = [];
      for (const para of String(craw).split(/\r?\n/)) {
        if (para === '') { clines.push(''); continue; }
        if (!cwrap || ccw(para) <= cwrapW) { clines.push(para); continue; }
        let cur = '';
        const flush = () => { if (cur !== '') { clines.push(cur); cur = ''; } };
        for (const tok of para.split(/\s+/).filter(Boolean)) {
          if (ccw(tok) > cwrapW) {
            flush();
            let chunk = '';
            for (const ch of tok) {
              if (chunk !== '' && ccw(chunk + ch) > cwrapW) { clines.push(chunk); chunk = ch; }
              else chunk += ch;
            }
            if (chunk !== '') clines.push(chunk);
            continue;
          }
          const trial = cur !== '' ? `${cur} ${tok}` : tok;
          if (cur !== '' && ccw(trial) > cwrapW) { clines.push(cur); cur = tok; }
          else cur = trial;
        }
        flush();
      }
      if (!clines.length) clines.push('Callout');
      const wText = Math.max(1, ...clines.map((l) => ccw(l)));
      const cbw = Math.ceil(wText + cpadX * 2);
      const cbh = Math.ceil(cpadY * 2 + casc + (clines.length - 1) * clh + cdesc);
      if (!Number.isFinite(cbw) || !Number.isFinite(cbh) || cbw <= 0 || cbh <= 0) return [];
      const cg = (c && c.geom) || {};
      const cleft = Number.isFinite(cg.left) ? cg.left : -Infinity;
      const ctop = Number.isFinite(cg.top) ? cg.top : -Infinity;
      const cright = Number.isFinite(cg.right) ? cg.right : Infinity;
      const cbottom = Number.isFinite(cg.bottom) ? cg.bottom : Infinity;
      let cbx = bRaw.x, cby = bRaw.y;
      if (Number.isFinite(cleft) && Number.isFinite(cright) && cright - cleft >= 0) {
        cbx = Math.min(Math.max(cbx, cleft + 2), Math.max(cleft + 2, cright - cbw - 2));
      }
      if (Number.isFinite(ctop) && Number.isFinite(cbottom) && cbottom - ctop >= 0) {
        cby = Math.min(Math.max(cby, ctop + 2), Math.max(ctop + 2, cbottom - cbh - 2));
      }
      cbx = Math.round(cbx); cby = Math.round(cby);
      if (!Number.isFinite(cbx) || !Number.isFinite(cby)) return [];
      const cout = [];
      const rectPrim = { op: 'rect', x: cbx, y: cby, w: cbw, h: cbh, fill: cbgAlpha, bg: cbgColor, border: cborderColor };
      if (cdash) rectPrim.dash = cdash;
      cout.push(rectPrim);
      clines.forEach((ln, i) => {
        if (ln === '') return;
        cout.push({
          op: 'text', x: cbx + cpadX, y: cby + cpadY + casc + i * clh, text: ln, align: 'left', size: csize,
          ...(cink ? { color: cink } : {}), ...(cbold ? { bold: true } : {}), ...(citalic ? { italic: true } : {}),
        });
      });
      const fx = Math.min(Math.max(a.x, cbx), cbx + cbw);
      const fy = Math.min(Math.max(a.y, cby), cby + cbh);
      const cdx = a.x - fx, cdy = a.y - fy;
      const dist = Math.hypot(cdx, cdy);
      if (Number.isFinite(dist) && dist >= 2) {
        cout.push({ op: 'line', x1: a.x, y1: a.y, x2: fx, y2: fy, ...(cdash ? { dash: cdash } : {}) });
        const ux = cdx / dist, uy = cdy / dist;
        const nx = -uy, ny = ux;
        cout.push({ op: 'path', pts: [{ x: fx + nx * 5, y: fy + ny * 5 }, { x: fx - nx * 5, y: fy - ny * 5 }, { x: a.x, y: a.y }], close: true });
      }
      cout.push({ op: 'ellipse', cx: a.x, cy: a.y, rx: 3, ry: 3 });
      return cout;
    }
    case 'signpost': {
      // Signpost: strictly-vertical road-sign post + text plate (extends only
      // straight up/down from the anchor). The pole is always x = A.x; P1's
      // x-drift is ignored. Plate sits beyond the pole tip with an anchor
      // dot (or emoji pin when d.emoji is set).
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const sraw = typeof d.text === 'string' ? d.text : (d.text == null ? '' : String(d.text));
      let slines = (sraw.trim() !== '' ? sraw : 'Signpost').split(/\r?\n/).map((s) => s.replace(/\s+$/, ''));
      if (!slines.length) slines = ['Signpost'];
      slines = slines.slice(0, 4);
      const ssize = Math.min(72, Math.max(8, Math.round(Number(d.fontsize ?? d.fontSize ?? d.size) || 13)));
      const sstep = Math.max(14, Math.round(ssize * 1.3));
      const spadX = 10, spadY = 7;
      const swText = Math.max(1, ...slines.map((l) => l.length * ssize * 0.6));
      let sw = Math.ceil(swText + spadX * 2);
      if (!Number.isFinite(sw)) return [];
      sw = Math.min(300, Math.max(56, sw));
      const sh = spadY * 2 + sstep * slines.length;
      let sbY = null;
      const sbRaw = d.points.length > 1 ? c.xy(d.points[1]) : null;
      if (sbRaw && Number.isFinite(sbRaw.y)) sbY = sbRaw.y;
      if (!Number.isFinite(sbY) || Math.abs(sbY - a.y) < 2) sbY = a.y - 70;
      const sup = sbY <= a.y;
      let spx = Math.round(a.x - sw / 2);
      let spy = sup ? Math.round(sbY - sh) : Math.round(sbY);
      const sg = (c && c.geom) || {};
      if (Number.isFinite(sg.left) && Number.isFinite(sg.right) && sg.right - sg.left >= sw + 4) {
        spx = Math.min(Math.max(spx, sg.left + 2), sg.right - sw - 2);
      }
      if (Number.isFinite(sg.top) && Number.isFinite(sg.bottom) && sg.bottom - sg.top >= sh + 4) {
        spy = Math.min(Math.max(spy, sg.top + 2), sg.bottom - sh - 2);
      }
      if (![spx, spy, sw, sh].every(Number.isFinite) || sw <= 0 || sh <= 0) return [];
      const stipY = sup ? spy + sh : spy;
      const sout = [];
      const sdash = Array.isArray(d.dash) ? { dash: d.dash } : {};
      sout.push({ op: 'line', x1: a.x, y1: a.y, x2: a.x, y2: stipY, ...sdash });
      sout.push({ op: 'box', x: spx, y: spy, w: sw, h: sh, label: slines.join('\n'), variant: 'signpost' });
      const sem = typeof d.emoji === 'string' ? d.emoji.trim() : '';
      if (sem !== '') sout.push({ op: 'text', x: a.x, y: a.y - 8, text: sem, align: 'center', size: 18 });
      else sout.push({ op: 'ellipse', cx: a.x, cy: a.y, rx: 3, ry: 3 });
      return sout;
    }
    case 'flag': {
      // Flag Mark: fixed-size pole + solid waving pennant at points[0].
      // points[1], when present and horizontally distinct, picks only the
      // wave side — never the size. Optional d.text caption past the fly end.
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const tip = c.xy(d.points[1] || d.points[0]);
      const fg = (c && c.geom) || {};
      const fright = Number.isFinite(fg.right) ? fg.right : Infinity;
      const POLE_H = 26, FLY_W = 16, FLY_H = 11;
      let dir = 1;
      if (tip && Number.isFinite(tip.x) && Math.abs(tip.x - a.x) > 2) {
        dir = tip.x < a.x ? -1 : 1;
      } else if (Number.isFinite(fright) && a.x + FLY_W + 4 > fright) {
        dir = -1;
      }
      const px = a.x, py = a.y - POLE_H;
      const fly = dir > 0
        ? [{ x: px, y: py }, { x: px + FLY_W, y: py + 2 }, { x: px + FLY_W, y: py + FLY_H - 2 }, { x: px, y: py + FLY_H }]
        : [{ x: px, y: py }, { x: px - FLY_W, y: py + 2 }, { x: px - FLY_W, y: py + FLY_H - 2 }, { x: px, y: py + FLY_H }];
      const fout = [
        { op: 'line', x1: a.x, y1: a.y, x2: px, y2: py },
        { op: 'path', pts: fly, close: true, fill: 1 },
      ];
      const fraw = typeof d.text === 'string' ? d.text.trim() : '';
      if (fraw !== '') {
        const fsize = Math.min(24, Math.max(8, Math.round(Number(d.fontsize ?? d.fontSize ?? d.size) || 11)));
        const fink = d.color ?? d.textColor ?? d.textcolor ?? null;
        fout.push({
          op: 'text',
          x: dir > 0 ? px + FLY_W + 5 : px - FLY_W - 5,
          y: py + FLY_H / 2 + fsize * 0.35,
          text: fraw.split('\n')[0].slice(0, 60),
          align: dir > 0 ? 'left' : 'right',
          size: fsize,
          ...(fink ? { color: fink } : {}),
          ...(d.bold === true || d.fontWeight === 'bold' ? { bold: true } : {}),
          ...(d.italic === true ? { italic: true } : {}),
        });
      }
      return fout;
    }
    case 'image': {
      // Image: pasted/dropped JPG/PNG attached as d.image. Data-anchored so
      // it pans/zooms with the chart. Two time-anchored points define
      // opposite corners (free stretch); a lone anchor is the top-left with
      // a pixel size from explicit d.w/d.h, else aspect-preserved natural
      // d.natW/d.natH (shrink-only to a 400px long side), else 200x130.
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const firstPos = (...vs) => {
        for (const v of vs) {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) return n;
        }
        return 0;
      };
      let ix, iy, iw, ih;
      const p1 = d.points.length > 1 ? d.points[1] : null;
      const imb = p1 ? c.xy(p1) : null;
      const hasB = !!(imb && Number.isFinite(imb.x) && Number.isFinite(imb.y)
        && p1 && Number.isFinite(p1.p) && Number.isFinite(p1.t));
      if (hasB) {
        ix = Math.min(a.x, imb.x); iy = Math.min(a.y, imb.y);
        iw = Math.abs(imb.x - a.x); ih = Math.abs(imb.y - a.y);
        if (![ix, iy, iw, ih].every(Number.isFinite)) return [];
        if (!(iw >= 2 && ih >= 2)) return [];
      } else {
        const natW = firstPos(d.natW, d.naturalWidth, d.imgNatW);
        const natH = firstPos(d.natH, d.naturalHeight, d.imgNatH);
        let ew = firstPos(d.w, d.pxW, d.width, d.pxWidth);
        let eh = firstPos(d.h, d.pxH, d.height, d.pxHeight);
        if (ew && eh) { /* explicit pair: free aspect, as dragged */ }
        else if (ew && natW && natH) eh = (ew * natH) / natW;
        else if (eh && natW && natH) ew = (eh * natW) / natH;
        else if (natW && natH) {
          const s = Math.min(1, 400 / Math.max(natW, natH));
          ew = natW * s; eh = natH * s;
        } else {
          ew = ew || 200;
          eh = eh || (ew !== 200 ? (ew * 130) / 200 : 130);
        }
        if (!Number.isFinite(ew) || !Number.isFinite(eh)) return [];
        iw = Math.min(2000, Math.max(8, Math.round(ew)));
        ih = Math.min(2000, Math.max(8, Math.round(eh)));
        ix = a.x; iy = a.y;
      }
      let imgOp = 1;
      if (Number.isFinite(+d.opacity)) imgOp = +d.opacity;
      else if (Number.isFinite(+d.alpha)) imgOp = +d.alpha;
      else if (Number.isFinite(+d.transparency)) imgOp = 1 - +d.transparency / 100;
      else if (Number.isFinite(+d.transparent)) imgOp = 1 - +d.transparent / 100;
      imgOp = Math.min(1, Math.max(0, imgOp));
      const hasImg = typeof d.image === 'string' ? d.image.trim() !== '' : !!d.image;
      const iout = [];
      const ibox = {
        op: 'box',
        x: Math.round(ix), y: Math.round(iy),
        w: Math.round(iw), h: Math.round(ih),
        label: hasImg ? '' : 'Image', variant: 'image',
      };
      if (hasImg) ibox.image = d.image;
      if (imgOp < 1) ibox.opacity = imgOp;
      iout.push(ibox);
      const sel = !!(c.state && c.state.selectedId === d.id);
      if (sel && hasImg) {
        iout.push({ op: 'rect', x: Math.round(ix), y: Math.round(iy), w: Math.round(iw), h: Math.round(ih) });
      }
      return iout;
    }
    case 'post': {
      // X Post (default) vs TradingView Idea (d.variant === 'idea').
      // Single anchor = publication time/price. The card floats up-right of
      // the anchor with header badge, title, wrapped body and footer. The
      // background box carries an empty label (card + hit area); all rows
      // are explicit left-aligned text prims.
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const isIdea = d.variant === 'idea';
      const W = isIdea ? 270 : 250;
      const PAD_X = 10, PAD_BOT = 8, HEAD_H = 28;
      const TITLE_SIZE = 13, TITLE_LH = 17, TITLE_MAX = 2;
      const BODY_SIZE = 12, BODY_LH = 15, BODY_MAX = isIdea ? 4 : 3;
      const META_SIZE = 11, FOOT_MAX = 42;
      const raw0 = typeof d.text === 'string' ? d.text : (d.text == null ? '' : String(d.text));
      const urlField = typeof d.url === 'string' ? d.url.trim() : '';
      const urlInText = (raw0.match(/https?:\/\/[^\s)]+/i) || [])[0] || '';
      const url = urlField || urlInText;
      const noUrl = urlInText ? raw0.replace(urlInText, ' ').replace(/\s+/g, ' ').trim() : raw0.trim();
      const rawLines = noUrl.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '');
      const author = typeof d.author === 'string' ? d.author.trim().slice(0, 24) : '';
      let title = typeof d.title === 'string' ? d.title.trim() : '';
      let bodySrc = typeof d.body === 'string' ? d.body.trim() : '';
      if (!title && !bodySrc) {
        if (isIdea) { title = rawLines[0] || 'Idea'; bodySrc = rawLines.slice(1).join('\n'); }
        else { bodySrc = rawLines.join('\n'); }
      }
      if (!title && !bodySrc) { if (isIdea) title = 'Idea'; else bodySrc = 'Post'; }
      const head = (isIdea ? 'IDEA' : 'X POST') + (author ? ` · ${author}` : '');
      const foot = (url || (isIdea ? 'tradingview.com/ideas' : 'x.com')).slice(0, FOOT_MAX + 8);
      const inner = W - PAD_X * 2 - 16;
      const wrap = (src, size, maxLines) => {
        const per = Math.max(8, Math.floor(inner / (size * 0.6)));
        const words = String(src).split(/\s+/).filter(Boolean);
        const wlines = [];
        let cur = '';
        const push = (s) => { if (s !== '') wlines.push(s); };
        for (const w of words) {
          if (w.length > per) {
            if (cur) { push(cur); cur = ''; }
            for (let i = 0; i < w.length; i += per) push(w.slice(i, i + per));
            continue;
          }
          const trial = cur ? `${cur} ${w}` : w;
          if (trial.length <= per) cur = trial;
          else { push(cur); cur = w; }
        }
        if (cur) push(cur);
        const cut = wlines.length > maxLines;
        const wvis = wlines.slice(0, maxLines);
        if (cut && wvis.length) wvis[wvis.length - 1] += '…';
        return wvis;
      };
      const titleLines = title ? wrap(title, TITLE_SIZE, TITLE_MAX) : [];
      let bodyLines = bodySrc ? wrap(bodySrc, BODY_SIZE, BODY_MAX) : [];
      if (!titleLines.length && !bodyLines.length) bodyLines = [isIdea ? '(no description)' : 'Post'];
      const footLine = foot.length > FOOT_MAX ? `${foot.slice(0, FOOT_MAX - 1)}…` : foot;
      const H = HEAD_H + titleLines.length * TITLE_LH
        + ((titleLines.length && bodyLines.length) ? 3 : 0)
        + bodyLines.length * BODY_LH + (bodyLines.length ? 3 : 0) + 14 + PAD_BOT;
      if (!Number.isFinite(H) || H <= 0) return [];
      let pbx = Math.round(a.x + 12);
      let pby = Math.round(a.y - H - 14);
      const pg = c.geom;
      if (pg && [pg.left, pg.top, pg.width, pg.height, pg.right, pg.bottom].every(Number.isFinite)
        && pg.width > W + 4 && pg.height > H + 4) {
        pbx = Math.round(Math.min(Math.max(pbx, pg.left + 2), pg.right - W - 2));
        pby = Math.round(Math.min(Math.max(pby, pg.top + 2), pg.bottom - H - 2));
      }
      if (!Number.isFinite(pbx) || !Number.isFinite(pby)) return [];
      const postout = [
        { op: 'box', x: pbx, y: pby, w: W, h: Math.round(H), label: '', variant: isIdea ? 'idea' : 'post' },
        { op: 'ellipse', cx: pbx + 16, cy: pby + 16, rx: 6, ry: 6 },
        { op: 'text', x: pbx + 26, y: pby + 20, text: head.slice(0, 34), align: 'left', size: 11, bold: true, color: '#9aa0b0' },
        { op: 'line', x1: pbx + PAD_X, y1: pby + HEAD_H, x2: pbx + W - PAD_X, y2: pby + HEAD_H },
      ];
      let pcy = pby + HEAD_H;
      titleLines.forEach((ln) => { pcy += TITLE_LH; postout.push({ op: 'text', x: pbx + PAD_X, y: pcy, text: ln, align: 'left', size: TITLE_SIZE, bold: true, color: '#f0f3fa' }); });
      if (titleLines.length && bodyLines.length) pcy += 3;
      bodyLines.forEach((ln) => { pcy += BODY_LH; postout.push({ op: 'text', x: pbx + PAD_X, y: pcy, text: ln, align: 'left', size: BODY_SIZE, color: '#d6dae2' }); });
      pcy += bodyLines.length ? 3 : 0;
      postout.push({ op: 'text', x: pbx + PAD_X, y: pcy + 14, text: footLine, align: 'left', size: META_SIZE, color: '#8b93a7' });
      const footX = Math.min(Math.max(a.x, pbx), pbx + W);
      const footY = pby + Math.round(H);
      if (Math.hypot(a.x - footX, a.y - footY) > 2) {
        postout.push({ op: 'line', x1: a.x, y1: a.y, x2: footX, y2: footY });
      }
      postout.push({ op: 'line', x1: a.x, y1: a.y, x2: a.x, y2: a.y, arrows: 'dot' });
      return postout;
    }
    case 'icon': {
      // Single-anchor emoji badge: bare centered glyph by default; circular
      // halo + outline when selected; opt-in persistent disc via
      // showBackground. Size: TV px override `d.size` first, else the local
      // 1-10x slider `d.iconScale` on the 18px base. An invisible body rect
      // makes click-select match the glyph bounds.
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];
      const glyph = (typeof d.text === 'string' && d.text !== '') ? d.text : '⭐';
      let S = 18;
      const ipx = Number(d.size);
      if (Number.isFinite(ipx) && ipx > 0) S = ipx;
      else {
        const k = Math.min(10, Math.max(1, Math.round(Number(d.iconScale) || 1)));
        S = 18 * k;
      }
      if (!Number.isFinite(S) || S <= 0) S = 18;
      S = Math.min(200, Math.max(8, Math.round(S)));
      const sel = !!(c.state && c.state.selectedId === d.id);
      const showDisc = d.showBackground === true || d.fillBackground === true;
      const iout = [
        { op: 'rect', x: a.x - S * 0.6, y: a.y - S * 0.6, w: S * 1.2, h: S * 1.2, noStroke: true },
      ];
      if (sel || showDisc) {
        const R = S * 0.62;
        iout.push({
          op: 'path',
          pts: sample((t) => ({ x: a.x + R * Math.cos(t * Math.PI * 2), y: a.y + R * Math.sin(t * Math.PI * 2) }), 48),
          close: true, fill: 0.15,
        });
        iout.push({ op: 'ellipse', cx: a.x, cy: a.y, rx: R, ry: R });
      }
      iout.push({ op: 'text', x: a.x, y: a.y + S * 0.35, text: glyph, align: 'center', size: S });
      return iout;
    }
    default:
      return [];
  }
}
// --- brush -----------------------------------------------------------------
function brush(d, c) {
  // Freehand stroke: Brush (thin opaque) vs Highlighter (wide translucent).
  // Width/smoothness honor the TV Style-dialog params when present, else the
  // TV factory defaults (brush 2px / highlight 20px, smooth 5). Smoothing is
  // baked into pts as endpoint-pinned binomial blur over jitter-decimated px.
  const hi = d.variant === 'highlight' || d.kind === 'highlighter' || d.type === 'highlighter';
  const raw = (d.points || [])
    .map((p) => c.xy(p))
    .filter((q) => q && Number.isFinite(q.x) && Number.isFinite(q.y));
  if (raw.length < 2) return [];
  const dec = [raw[0]];
  for (let i = 1; i < raw.length; i += 1) {
    const l = dec[dec.length - 1];
    if (Math.hypot(raw[i].x - l.x, raw[i].y - l.y) >= 1.5) dec.push(raw[i]);
  }
  const lastRaw = raw[raw.length - 1], lastDec = dec[dec.length - 1];
  if ((lastDec.x !== lastRaw.x || lastDec.y !== lastRaw.y)
    && Math.hypot(lastRaw.x - lastDec.x, lastRaw.y - lastDec.y) > 1e-9) {
    dec.push({ x: lastRaw.x, y: lastRaw.y });
  }
  if (dec.length < 2) return [];
  let k = Number.isFinite(+d.smooth) ? Math.round(+d.smooth) : 5;
  k = Math.min(10, Math.max(0, k));
  const passes = k <= 0 ? 0 : k <= 2 ? 1 : k <= 5 ? 2 : 3;
  let bpts = dec.map((q) => ({ x: q.x, y: q.y }));
  for (let n = 0; n < passes; n += 1) {
    if (bpts.length < 3) break;
    const nx = [bpts[0]];
    for (let i = 1; i < bpts.length - 1; i += 1) {
      nx.push({
        x: (bpts[i - 1].x + 2 * bpts[i].x + bpts[i + 1].x) / 4,
        y: (bpts[i - 1].y + 2 * bpts[i].y + bpts[i + 1].y) / 4,
      });
    }
    nx.push(bpts[bpts.length - 1]);
    bpts = nx;
  }
  const asked = Number.isFinite(+d.linewidth) ? +d.linewidth
    : Number.isFinite(+d.width) ? +d.width : NaN;
  const w = Number.isFinite(asked) && asked > 0
    ? Math.min(64, Math.max(1, asked)) : (hi ? 20 : 2);
  return [{ op: 'path', pts: bpts, thick: w }];
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
