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
test('encoded traversal via /js/* allowlist is denied (normalize-first)', () => {
  // Bypass proof: raw /js/* prefix passes, but decoded+normalized escapes it.
  assert.equal(staticDecision('/js/%2e%2e/server/proxy.js'), 404);
  assert.equal(staticDecision('/js/%2E%2E/server/proxy.js'), 404);
  assert.equal(staticDecision('/js/..%2fserver%2fproxy.js'), 404);
});
test('encoded dot-segments outside allowlist are denied', () => {
  assert.equal(staticDecision('/%2e%2e/x'), 404);
  assert.equal(staticDecision('/%2E%2E/x'), 404);
  assert.equal(staticDecision('/%2e%2e/server/proxy.js'), 404);
});
