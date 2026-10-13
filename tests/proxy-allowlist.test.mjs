// tests/proxy-allowlist.test.mjs — IMPORTANT #2: static allowlist + dot denial.
import test from 'node:test';
import assert from 'node:assert/strict';
import { staticDecision } from '../server/proxy.js';

test('/index.html is served', () => {
  assert.equal(staticDecision('/index.html'), 200);
  assert.equal(staticDecision('/'), 200);
  assert.equal(staticDecision('/styles.css'), 200);
});
test('/js/*, /data/*, /indicators/* are served', () => {
  assert.equal(staticDecision('/js/chart.js'), 200);
  assert.equal(staticDecision('/data/btcusd-1d.json'), 200);
  assert.equal(staticDecision('/indicators/indicators.js'), 200);
});
test('/.git/config is denied (dot-segment -> 404)', () => {
  assert.equal(staticDecision('/.git/config'), 404);
  assert.equal(staticDecision('/data/.hidden'), 404);
  assert.equal(staticDecision('/js/../.git/config'), 404);
});
test('anything else is denied', () => {
  assert.equal(staticDecision('/package.json'), 404);
  assert.equal(staticDecision('/server/proxy.js'), 404);
  assert.equal(staticDecision('/favicon.ico'), 404);
});
