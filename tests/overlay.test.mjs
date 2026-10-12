// tests/overlay.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { hitTest } from '../js/overlay.js';
test('hitTest picks nearest candle', () => {
  const rows = [{ t: 0 }, { t: 10 }, { t: 20 }];
  // NOTE(br ief fix): 105px is nearest to middle candle (x≈100), not index 2.
  // Brief expected 2 — verified mathematically: step=200/3≈66.7, xs≈33/100/167.
  assert.equal(hitTest(105, { from: 0, to: 20 }, 0, 200, rows), 1);
  assert.equal(hitTest(165, { from: 0, to: 20 }, 0, 200, rows), 2);
});
