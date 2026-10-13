// tests/drawings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {snapPrice, serialize, deserialize, addDrawing, translateDrawing, moveAnchor, isComplete, migrateDrawing, makeDrawing, bounds, anchorCount } from '../js/drawings.js';
test('magnet snaps to nearest OHL within tolerance', () => {
  const rows = [{ o: 100, h: 110, l: 90, c: 105 }];
  assert.equal(snapPrice(109, rows, 2), 110);
  assert.equal(snapPrice(50, rows, 2), 50);
});
test('serialize round-trips', () => {
  const d = [{ id: 'a', type: 'trend', p1: { t: 1, p: 2 } }];
  assert.deepEqual(JSON.parse(serialize(d)), d);
});
test('layout object form {drawings,alerts} round-trips', () => {
  const layout = {
    drawings: [{ id: 'd1', type: 'horizontal', price: 80000 }],
    alerts: [{ id: 'a1', price: 82000 }],
  };
  const parsed = deserialize(serialize(layout));
  assert.deepEqual(parsed, layout);
});
test('full layout form {drawings,alerts,studies,indicators,chartType,symbol,timeframe} round-trips', () => {
  const layout = {
    drawings: [{ id: 'd1', type: 'horizontal', price: 80000 }],
    alerts: [{ id: 'a1', price: 82000 }],
    studies: ['sma', 'bbands'],
    indicators: { sma20: true, sma50: false, ema20: false, rsi: true },
    chartType: 'bars',
    symbol: 'ETH/USD',
    timeframe: '1W',
  };
  const parsed = deserialize(serialize(layout));
  assert.deepEqual(parsed, layout);
  // Loader keeps new keys when present, defaults otherwise (backward-compat).
  const loaded = Array.isArray(parsed)
    ? { drawings: parsed, alerts: [] }
    : {
      drawings: parsed.drawings || [],
      alerts: parsed.alerts || [],
      studies: parsed.studies,
      indicators: parsed.indicators,
      chartType: parsed.chartType,
      symbol: parsed.symbol,
      timeframe: parsed.timeframe,
    };
  assert.deepEqual(loaded.studies, ['sma', 'bbands']);
  assert.equal(loaded.chartType, 'bars');
  assert.equal(loaded.symbol, 'ETH/USD');
  assert.equal(loaded.timeframe, '1W');
});
test('legacy array form loads as drawings-only', () => {
  const legacy = [{ id: 'd1', type: 'horizontal', price: 80000 }];
  const parsed = deserialize(serialize(legacy));
  assert.ok(Array.isArray(parsed));
  // Mirror ui.js loadLayout branching: array -> {drawings, alerts: []}.
  const loaded = Array.isArray(parsed)
    ? { drawings: parsed, alerts: [] }
    : { drawings: parsed.drawings || [], alerts: parsed.alerts || [] };
  assert.deepEqual(loaded, { drawings: legacy, alerts: [] });
});
test('addDrawing is pure state update (no direct persistence)', () => {
  const store = { drawings: [] };
  const view = { get: () => ({ ...store }), set: (p) => Object.assign(store, p) };
  addDrawing(view, { type: 'horizontal', price: 80000 });
  assert.equal(store.drawings.length, 1);
  assert.equal(store.drawings[0].type, 'horizontal');
});

// --- rail-parity regression coverage ---
test('translateDrawing preserves null time anchors (horizontal lines)', () => {
  const moved = translateDrawing({ type: 'horizontal', points: [{ t: null, p: 100 }] }, 5000, -3);
  assert.equal(moved.points[0].t, null, 'price-only anchors must not become time-anchored');
  assert.equal(moved.points[0].p, 97);
});
test('isComplete accepts price-only horizontals, rejects short trends', () => {
  assert.equal(isComplete({ type: 'horizontal', points: [{ t: null, p: 1 }] }), true);
  assert.equal(isComplete({ type: 'trend', points: [{ t: 1, p: 2 }] }), false);
  assert.equal(isComplete({ type: 'xabcd', points: [{ t: 1, p: 2 }, { t: 2, p: 3 }, { t: 3, p: 4 }] }), false);
  assert.equal(isComplete({ type: 'brush', points: [{ t: 1, p: 2 }, { t: 2, p: 3 }] }), true);
});
test('migrateDrawing turns legacy half-trends into unusable-but-safe records', () => {
  const d = migrateDrawing({ id: 'x', type: 'trend', p1: { t: 1, p: 2 } });
  assert.equal(isComplete(d), false, 'renderers must skip this instead of crashing');
});
test('anchor geometry helpers behave', () => {
  const d = makeDrawing('rect', [{ t: 1, p: 10 }, { t: 5, p: 2 }]);
  assert.deepEqual(bounds(d), { t0: 1, t1: 5, p0: 2, p1: 10 });
  const moved = moveAnchor(d, 1, { t: 9, p: 9 });
  assert.deepEqual(moved.points[1], { t: 9, p: 9 });
  assert.deepEqual(d.points[1], { t: 5, p: 2 }, 'original is not mutated');
});
test('ids are unique across rapid creation', () => {
  const ids = new Set(Array.from({ length: 200 }, () => makeDrawing('trend', [{ t: 1, p: 1 }, { t: 2, p: 2 }]).id));
  assert.equal(ids.size, 200);
});
