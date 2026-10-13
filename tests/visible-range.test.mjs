// tests/visible-range.test.mjs — CRITICAL #1 regression: candles, axes and
// hitTest all operate on the same visible slice with one index-based x map.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  visibleRows, sliceOffset, replayCount, candleX,
  xForRowTime, timeForX, xForTime, yForPrice, niceTicks, renderBase,
} from '../js/chart.js';
import { hitTest } from '../js/overlay.js';

const DAY = 86400000;
const mkRows = (n) => Array.from({ length: n }, (_, i) => ({
  t: i * DAY, o: 100 + i, h: 110 + i, l: 90 + i, c: 105 + i, v: 1 + (i % 3),
}));
const GEOM = { left: 0, top: 0, width: 200, height: 100 };

function fakeCtx(counter) {
  return new Proxy({ canvas: {} }, {
    get: (t, prop) => {
      if (prop === 'fillRect') return (...a) => { counter.n++; };
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'canvas') return {};
      if (typeof prop === 'string') return (...a) => {};
      return undefined;
    },
    set: () => true,
  });
}
const baseState = (visible) => ({
  theme: 'light', price: { min: 0, max: 500 }, visible,
  chartType: 'candles', indicators: {}, studies: [], replayIndex: null,
});

test('narrow visible slices the row window (candle count changes)', () => {
  const rows = mkRows(10);
  const full = { from: rows[0].t, to: rows[9].t };
  const narrow = { from: rows[3].t, to: rows[6].t };
  assert.equal(visibleRows(rows, full).length, 10);
  const sliced = visibleRows(rows, narrow);
  assert.equal(sliced.length, 4);
  assert.deepEqual(sliced.map((r) => r.t), [3, 4, 5, 6].map((i) => i * DAY));
  assert.equal(sliceOffset(rows, sliced), 3);
});

test('narrow visible widens candle span (same width, fewer slots)', () => {
  const rows = mkRows(10);
  const stepFull = GEOM.width / visibleRows(rows, { from: rows[0].t, to: rows[9].t }).length;
  const stepNarrow = GEOM.width / visibleRows(rows, { from: rows[3].t, to: rows[6].t }).length;
  assert.equal(stepFull, 20);
  assert.equal(stepNarrow, 50);
  assert.ok(stepNarrow > stepFull);
});

test('renderBase draws only the visible slice (fillRect body+volume per bar)', () => {
  const rows = mkRows(10);
  const cFull = { n: 0 };
  renderBase(fakeCtx(cFull), baseState({ from: rows[0].t, to: rows[9].t }), rows, GEOM);
  const cNarrow = { n: 0 };
  renderBase(fakeCtx(cNarrow), baseState({ from: rows[3].t, to: rows[6].t }), rows, GEOM);
  assert.equal(cFull.n, 21); // bg + 10 bodies + 10 volume bars
  assert.equal(cNarrow.n, 9); // bg + 4 bodies + 4 volume bars
});

test('axes x agrees with candle x on the slice', () => {
  const rows = mkRows(10);
  const vis = { from: rows[3].t, to: rows[6].t };
  const sliced = visibleRows(rows, vis);
  sliced.forEach((r, i) => {
    assert.equal(xForRowTime(r.t, sliced, GEOM.left, GEOM.width), candleX(i, sliced.length, GEOM.left, GEOM.width));
  });
  // timeForX inverts xForRowTime at slot centers.
  sliced.forEach((r, i) => {
    const x = candleX(i, sliced.length, GEOM.left, GEOM.width);
    assert.equal(timeForX(x, sliced, GEOM.left, GEOM.width), r.t);
  });
});

test('hitTest agrees with candle x (returns full index via slice offset)', () => {
  const rows = mkRows(10);
  const vis = { from: rows[3].t, to: rows[6].t };
  const sliced = visibleRows(rows, vis);
  const off = sliceOffset(rows, sliced);
  assert.equal(off, 3);
  sliced.forEach((r, i) => {
    const x = candleX(i, sliced.length, GEOM.left, GEOM.width);
    assert.equal(hitTest(x, vis, GEOM.left, GEOM.width, rows), off + i);
  });
});

test('replayIndex maps onto the slice via offset', () => {
  const rows = mkRows(10);
  const vis = { from: rows[3].t, to: rows[6].t };
  const sliced = visibleRows(rows, vis);
  const off = sliceOffset(rows, sliced);
  // replayIndex=4 shows full[0..4]; slice holds full[3..6] -> 2 visible bars.
  assert.equal(replayCount(rows, sliced, off, { replayIndex: 4 }), 2);
  // replayIndex before the window shows nothing of the slice.
  assert.equal(replayCount(rows, sliced, off, { replayIndex: 1 }), 0);
  // no replay shows the whole slice.
  assert.equal(replayCount(rows, sliced, off, { replayIndex: null }), 4);
});

test('zero-range guards stay NaN-safe', () => {
  assert.ok(Number.isNaN(xForTime(5, { from: 1, to: 1 }, 0, 200)));
  assert.ok(Number.isNaN(yForPrice(5, { min: 9, max: 9 }, 0, 200)));
  assert.deepEqual(niceTicks(100, 100), []);
  assert.ok(Number.isNaN(xForRowTime(5, [], 0, 200)));
  assert.ok(Number.isNaN(timeForX(5, [], 0, 200)));
});
