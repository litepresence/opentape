// tests/study-instances.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load the classic vendor lib exactly as index.html / studies.test.mjs do —
// computeStudy delegates to globalThis.Indicators, which is empty without it.
const ORDER = ['indicators/indicators.js', 'indicators/indicators-osc.js', 'indicators/indicators-tulip.js', 'indicators/indicators-tmom.js', 'indicators/indicators-tvol.js', 'indicators/indicators-qx.js'];
const lctx = vm.createContext({ console, Math, Number, Array, Object, Error, isFinite, globalThis: {} });
lctx.globalThis = lctx;
for (const f of ORDER) vm.runInContext(readFileSync(f, 'utf8'), lctx, { filename: f });
globalThis.Indicators = lctx.Indicators;
import { STUDIES, makeInstance, migrateStudies } from '../js/studies.js';

test('every opts key has exactly one param def and vice versa', () => {
  for (const s of STUDIES) {
    const optKeys = Object.keys(s.opts || {}).sort();
    const parKeys = (s.params || []).map(p => p.key).sort();
    assert.deepEqual(parKeys, optKeys, s.id);
    for (const p of s.params || []) assert.ok(['int', 'float'].includes(p.type), s.id + '.' + p.key);
  }
});
test('sma period actually changes output', async () => {
  const { computeStudy } = await import('../js/studies.js');
  const rows = Array.from({ length: 60 }, (_, i) => ({ o: 1, h: 2, l: 0.5, c: 100 + i, v: 1 }));
  const a = computeStudy('sma', rows, { period: 5 }).series.line;
  const b = computeStudy('sma', rows, { period: 50 }).series.line;
  assert.notDeepEqual(a, b);
});
test('migrateStudies converts legacy forms', () => {
  const fromIds = migrateStudies(['sma', 'rsi']);
  assert.equal(fromIds.length, 2);
  assert.ok(fromIds.every(i => i.uid && i.params && 'color' in i));
  const fromFlags = migrateStudies({ indicators: { sma20: true, rsi: true } });
  const sma = fromFlags.find(i => i.id === 'sma');
  assert.equal(sma.params.period, 20);
});
