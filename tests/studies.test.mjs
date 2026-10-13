// tests/studies.test.mjs — Task 9: all 85 vendored studies wired.
// Loads the classic indicators/*.js exactly as index.html will (base first),
// then exercises the ESM registry (js/studies.js) + compute helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load the classic library exactly as index.html will (base first).
const ORDER = ['indicators/indicators.js', 'indicators/indicators-osc.js', 'indicators/indicators-tulip.js', 'indicators/indicators-tmom.js', 'indicators/indicators-tvol.js', 'indicators/indicators-qx.js'];
const ctx = vm.createContext({ console, Math, Number, Array, Object, Error, isFinite, globalThis: {} });
ctx.globalThis = ctx;
for (const f of ORDER) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
const Lib = ctx.Indicators;
globalThis.Indicators = Lib; // js/lib.js bridges this global into ESM.
const { STUDIES, computeStudy } = await import('../js/studies.js');

test('library exposes all 85 studies', () => {
  assert.equal(Object.keys(Lib).length, 85);
});

test('registry covers all 85 with no orphans either direction', () => {
  const ids = STUDIES.map(s => s.id).sort();
  assert.equal(ids.length, 85);
  assert.deepEqual(ids, Object.keys(Lib).sort());
});

test('registry entries carry kind/lines/opts contract', () => {
  const kinds = new Set(['overlay', 'bands', 'multiline', 'pane', 'transform']);
  for (const s of STUDIES) {
    assert.ok(kinds.has(s.kind), `${s.id} kind`);
    assert.ok(Array.isArray(s.lines) && s.lines.length > 0, `${s.id} lines`);
    assert.ok(s.opts && typeof s.opts === 'object', `${s.id} opts`);
    assert.ok(['close', 'hl', 'hlc', 'hlcv', 'ohlc', 'oc', 'closevol', 'hlvol', 'vol'].includes(s.inputs), `${s.id} inputs`);
  }
  const transforms = STUDIES.filter(s => s.kind === 'transform').map(s => s.id).sort();
  assert.deepEqual(transforms, ['heikinashi', 'kagi', 'renko']);
});

// Studies with no bar-0 warmup by vendor design (cumulative / level series):
// renko/kagi step levels, heikinashi candles, wilders/aema/holtwinters seeds,
// vwap/obv/wad/ad/bop cumulatives from bar 0, zigzag pinned steps.
const NOWARM = new Set(['renko', 'heikinashi', 'kagi', 'wilders', 'vwap', 'obv', 'wad', 'ad', 'bop', 'aema', 'holtwinters', 'zigzag']);

test('every study computes same-length output with null warmup', () => {
  const N = 60;
  const closes = Array.from({ length: N }, (_, i) => 60000 + i * 100 + (i % 5) * 50);
  const open = closes.map(c => c - 40);
  const high = closes.map(c => c + 120), low = closes.map(c => c - 120), vol = closes.map(() => 1.5);
  const rows = closes.map((c, i) => ({ t: 1700000000000 + i * 86400000, o: open[i], h: high[i], l: low[i], c, v: vol[i] }));
  for (const s of STUDIES) {
    const { series } = computeStudy(s.id, rows, {});
    for (const key of s.lines) {
      assert.ok(Array.isArray(series[key]), `${s.id}.${key} exists`);
      assert.equal(series[key].length, N, `${s.id}.${key} length`);
    }
    for (const arr of Object.values(series)) {
      assert.equal(arr.length, N, `${s.id} length`);
      if (!NOWARM.has(s.id)) assert.equal(arr[0], null, `${s.id} warmup`);
    }
  }
});

test('computeStudy throws on unknown study', () => {
  assert.throws(() => computeStudy('nope', []), /unknown study/);
});
