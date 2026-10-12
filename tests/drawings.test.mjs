// tests/drawings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapPrice, serialize, deserialize, addDrawing } from '../js/drawings.js';
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
