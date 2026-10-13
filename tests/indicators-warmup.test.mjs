// tests/indicators-warmup.test.mjs — FINDING 1 regression: indicators must be
// computed on FULL history, then windowed. Slice-computed seeds/warmups shift
// on every pan/zoom (left-edge flicker).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi } from '../js/indicators.js';
import { visibleRows, sliceOffset, renderBase } from '../js/chart.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load classic vendor lib exactly as studies.test.mjs / index.html do.
const ORDER = ['indicators/indicators.js', 'indicators/indicators-osc.js', 'indicators/indicators-tulip.js', 'indicators/indicators-tmom.js', 'indicators/indicators-tvol.js', 'indicators/indicators-qx.js'];
const vctx = vm.createContext({ console, Math, Number, Array, Object, Error, isFinite, globalThis: {} });
vctx.globalThis = vctx;
for (const f of ORDER) vm.runInContext(readFileSync(f, 'utf8'), vctx, { filename: f });
globalThis.Indicators = vctx.Indicators;
const { computeStudy } = await import('../js/studies.js');

const DAY = 86400000;
const mkRows = (n) => Array.from({ length: n }, (_, i) => ({
  t: i * DAY, o: 100 + i, h: 110 + i, l: 90 + i, c: 100 + i, v: 10,
}));

// Recording ctx: captures polylines per strokeStyle for drawIndLine paths.
function recordCtx() {
  const polylines = new Map(); // color -> [{x,y}]
  let curColor = null;
  let curPath = null;
  const ctx = {
    canvas: {},
    fillRect() {},
    beginPath() { curPath = []; },
    moveTo(x, y) { curPath.push({ x, y }); },
    lineTo(x, y) { curPath.push({ x, y }); },
    stroke() { if (curColor && curPath) {
      if (!polylines.has(curColor)) polylines.set(curColor, []);
      polylines.get(curColor).push(...curPath);
    } curPath = null; },
    arc() {},
    fill() {},
    closePath() {},
    measureText: () => ({ width: 10 }),
    save() {}, restore() {},
    setLineDash() {},
    set strokeStyle(v) { curColor = v; },
    get strokeStyle() { return curColor; },
    set fillStyle(v) {},
    set globalAlpha(v) {},
    set lineWidth(v) {},
  };
  return { ctx, polylines };
}

const GEOM = { left: 0, top: 0, width: 420, height: 200 };
const priceFor = (rows) => {
  const cs = rows.map((r) => r.c);
  return { min: Math.min(...cs) - 5, max: Math.max(...cs) + 5 };
};

test('SMA(20) full-history differs from slice-computed at same bar', () => {
  const full = mkRows(40);
  const off = 10;
  const slice = full.slice(off, 31); // bars 10..30
  const fullVals = sma(full, 20);
  const sliceVals = sma(slice, 20);
  const targetFullIdx = 25;
  const targetSliceIdx = targetFullIdx - off;
  // Full has 20 bars of history -> numeric; slice has only 16 -> null.
  assert.equal(typeof fullVals[targetFullIdx], 'number');
  assert.equal(sliceVals[targetSliceIdx], null);
});

test('EMA(20) full-history differs from slice-computed at same bar', () => {
  const full = mkRows(40);
  const off = 10;
  const slice = full.slice(off, 31);
  const fullVals = ema(full, 20);
  const sliceVals = sma(slice, 20); // warmup contrast still holds
  void sliceVals;
  const fe = ema(full, 20);
  const se = ema(slice, 20);
  const targetFullIdx = 30;
  const targetSliceIdx = targetFullIdx - off;
  assert.equal(typeof fe[targetFullIdx], 'number');
  assert.equal(typeof se[targetSliceIdx], 'number');
  // Different seeds (full seeds at bar0, slice seeds at bar10) -> values differ.
  assert.notEqual(se[targetSliceIdx], fe[targetFullIdx]);
});

test('RSI(14) full-history differs from slice-computed at same bar', () => {
  // Early down-move history matters: slice starting at 10 misses the drop,
  // so Wilder seeds differ at bar 25.
  const full = mkRows(40).map((r, i) => ({ ...r, c: i < 10 ? 200 - i * 5 : 150 + (i - 10) * 1 }));
  const off = 10;
  const slice = full.slice(off, 31);
  const fullVals = rsi(full, 14);
  const sliceVals = rsi(slice, 14);
  const targetFullIdx = 25;
  const targetSliceIdx = targetFullIdx - off;
  // Both numeric here, but Wilder seeds differ -> values differ.
  assert.equal(typeof fullVals[targetFullIdx], 'number');
  assert.equal(typeof sliceVals[targetSliceIdx], 'number');
  assert.notEqual(sliceVals[targetSliceIdx], fullVals[targetFullIdx]);
});

test('study sma full-windowed differs from slice-computed', () => {
  const full = mkRows(40);
  const off = 10;
  const slice = full.slice(off, 31);
  const fullSeries = computeStudy('sma', full, {}).series.line;
  const sliceSeries = computeStudy('sma', slice, {}).series.line;
  const targetFullIdx = 25;
  const targetSliceIdx = targetFullIdx - off;
  const windowed = fullSeries.slice(off, off + slice.length);
  assert.equal(typeof fullSeries[targetFullIdx], 'number');
  // Windowed full preserves the full-history value at the same bar.
  assert.equal(windowed[targetSliceIdx], fullSeries[targetFullIdx]);
  // Slice-computed seed/warmup differs (null or different number).
  const same = sliceSeries[targetSliceIdx] === windowed[targetSliceIdx];
  assert.equal(same, false);
});

test('renderBase SMA(20) y is pan-invariant for the same bar', () => {
  const rows = mkRows(40);
  const price = priceFor(rows);
  const visA = { from: rows[10].t, to: rows[30].t };
  const visB = { from: rows[15].t, to: rows[35].t };
  const targetT = rows[25].t;
  const ys = [];
  for (const vis of [visA, visB]) {
    const { ctx, polylines } = recordCtx();
    const state = { theme: 'light', price, visible: vis, chartType: 'candles', indicators: {}, studies: [{ uid: 't-sma20', id: 'sma', params: { period: 20 }, color: '#2962FF', visible: true }], replayIndex: null };
    renderBase(ctx, state, rows, GEOM);
    const pts = polylines.get('#2962FF') || [];
    const sliced = visibleRows(rows, vis);
    const step = GEOM.width / sliced.length;
    const idx = sliced.findIndex((r) => r.t === targetT);
    assert.ok(idx >= 0);
    const expectX = GEOM.left + idx * step + step / 2;
    const hit = pts.reduce((best, p) => (!best || Math.abs(p.x - expectX) < Math.abs(best.x - expectX) ? p : best), null);
    assert.ok(hit, 'SMA point for target bar must be drawn');
    ys.push(hit.y);
  }
  assert.ok(Number.isFinite(ys[0]) && Number.isFinite(ys[1]));
  assert.ok(Math.abs(ys[0] - ys[1]) < 1e-6, `SMA y moved on pan: ${ys[0]} vs ${ys[1]}`);
});

test('renderBase EMA(20) y is pan-invariant for the same bar', () => {
  const rows = mkRows(40);
  const price = priceFor(rows);
  const visA = { from: rows[10].t, to: rows[30].t };
  const visB = { from: rows[15].t, to: rows[35].t };
  const targetT = rows[28].t;
  const ys = [];
  for (const vis of [visA, visB]) {
    const { ctx, polylines } = recordCtx();
    const state = { theme: 'light', price, visible: vis, chartType: 'candles', indicators: {}, studies: [{ uid: 't-ema20', id: 'ema', params: { period: 20 }, color: '#9C27B0', visible: true }], replayIndex: null };
    renderBase(ctx, state, rows, GEOM);
    const pts = polylines.get('#9C27B0') || [];
    const sliced = visibleRows(rows, vis);
    const step = GEOM.width / sliced.length;
    const idx = sliced.findIndex((r) => r.t === targetT);
    const expectX = GEOM.left + idx * step + step / 2;
    const hit = pts.reduce((best, p) => (!best || Math.abs(p.x - expectX) < Math.abs(best.x - expectX) ? p : best), null);
    assert.ok(hit, 'EMA point for target bar must be drawn');
    ys.push(hit.y);
  }
  assert.ok(Math.abs(ys[0] - ys[1]) < 1e-6, `EMA y moved on pan: ${ys[0]} vs ${ys[1]}`);
});
