// tooling/capture.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { captureClone } from './capture.js';

test('captureClone saves a PNG', async () => {
  const out = 'tooling/shots/smoke.png';
  await captureClone('about:blank', out, { width: 1280, height: 800 });
  assert.ok(existsSync(out), 'screenshot file should exist');
});
