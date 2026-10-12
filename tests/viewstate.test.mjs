// tests/viewstate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewState } from '../js/viewstate.js';

test('set merges and notifies once', () => {
  const v = ViewState({ symbol: 'BTC/USD' });
  let n = 0; v.subscribe(() => n++);
  v.set({ theme: 'dark' });
  assert.equal(v.get().theme, 'dark');
  assert.equal(n, 1);
});
test('toggleTheme flips light/dark', () => {
  const v = ViewState({ theme: 'light' });
  v.toggleTheme(); assert.equal(v.get().theme, 'dark');
});
