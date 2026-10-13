/* Indicators-Tulip (overlap averages + regressions): dependency-free math.
 * Owns: dema, tema, wma, wilders, vidya, vwma, linreg, tsf, linregslope,
 *   kama, md — the Tulip overlap/stat fns missing from indicators.js.
 *   Attaches onto the shared global Indicators object (indicators-osc.js
 *   precedent); cross-file EMA/SMA reuse via that object, never vendored.
 * Consumes: globalThis.Indicators (indicators.js must load first — enforced
 *   below), plain number arrays (clean inputs; null/NaN in a window yields
 *   null — same contract as indicators-osc.js). No DOM, no chain, no float
 *   money (pixel coordinates only — indicators never touch money).
 * Prov: Tulip ti_*.c semantics via QTradeX qx.ti passthrough
 *   (tulipy_wrapped.py); formulas reimplemented, never copied (Python/C
 *   runtime has no place here — math is public domain). Warmup = nulls,
 *   same-length outputs (file convention).
 * Created by: building-vanilla-slices skill, indicator-parity plan. */
(function () {
  "use strict";

  /* Base object this file extends (indicators-osc.js precedent). Helpers are
   * small per-file copies (doctrine rule 5: duplicated plain code beats a
   * shared-util abstraction with migration cost — WHY documented here). */
  var I = (typeof globalThis !== "undefined") ? globalThis.Indicators : undefined;
  if (typeof I === "undefined" && typeof Indicators !== "undefined") I = Indicators;
  if (!I) throw new Error("indicators-tulip.js requires indicators.js first");

  function _arr(x, name) {
    if (!Array.isArray(x)) throw new Error("bad " + (name || "input"));
    return x.length;
  }
  function _per(p, dflt, minp) {
    if (p === undefined) p = dflt;
    if (!Number.isInteger(p) || p < (minp === undefined ? 1 : minp)) throw new Error("bad period");
    return p;
  }
  function _out(n) {
    var o = new Array(n);
    for (var i = 0; i < n; i++) o[i] = null;
    return o;
  }
  function _ok(v) { return typeof v === "number" && isFinite(v); }
  /* _ema: local EMA (k=2/(n+1), seed = SMA of first n VALID values) for
   * double-smoothing internals — seeded on valid count (not index) so
   * composed passes over warmup-NaN arrays seed correctly. */
  function _ema(a, n) {
    var o = _out(a.length), k = 2 / (n + 1), sum = 0, cnt = 0, prev = 0, started = false, i;
    for (i = 0; i < a.length; i++) {
      if (!_ok(a[i])) continue;
      sum += a[i]; cnt++;
      if (cnt < n) continue;
      if (!started) { prev = sum / n; started = true; }
      else prev = a[i] * k + prev * (1 - k);
      o[i] = prev;
    }
    return o;
  }
  function _sma(a, n) {
    var o = _out(a.length), sum = 0, i;
    for (i = 0; i < a.length; i++) {
      if (!_ok(a[i])) return o;
      sum += a[i];
      if (i >= n) sum -= a[i - n];
      if (i >= n - 1) o[i] = sum / n;
    }
    return o;
  }

  /* dema: 2*EMA(n) - EMA(EMA(n)). Prov: Tulip ti_dema.c. */
  function dema(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 21, 1);
    var o = _out(n);
    if (n < 2 * period - 1) return o;
    var e1 = _ema(closes, period), e2 = _ema(e1.map(function (v) { return v === null ? NaN : v; }), period), i;
    for (i = 0; i < n; i++) {
      if (e1[i] === null || e2[i] === null || !_ok(e1[i]) || !_ok(e2[i])) continue;
      o[i] = 2 * e1[i] - e2[i];
    }
    return o;
  }
  /* tema: 3*e1 - 3*e2 + e3. Prov: Tulip ti_tema.c. */
  function tema(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 21, 1);
    var o = _out(n);
    if (n < 3 * period - 2) return o;
    function num(a) { return a.map(function (v) { return v === null ? NaN : v; }); }
    var e1 = _ema(closes, period), e2 = _ema(num(e1), period), e3 = _ema(num(e2), period), i;
    for (i = 0; i < n; i++) {
      if (!_ok(e1[i]) || !_ok(e2[i]) || !_ok(e3[i])) continue;
      o[i] = 3 * e1[i] - 3 * e2[i] + e3[i];
    }
    return o;
  }
  /* wma: recent-weighted mean, weights n..1. Prov: Tulip ti_wma.c. */
  function wma(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 9, 1);
    var o = _out(n), den = period * (period + 1) / 2, i, j;
    for (i = period - 1; i < n; i++) {
      var s = 0, w;
      for (j = 0; j < period; j++) {
        if (!_ok(closes[i - j])) { s = NaN; break; }
        w = period - j; s += closes[i - j] * w;
      }
      o[i] = isFinite(s) ? s / den : null;
    }
    return o;
  }
  /* wilders: Wilder smoothing (EMA alpha 1/n, seeded with first value).
   * Prov: Tulip ti_wilders.c. */
  function wilders(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 14, 1);
    var o = _out(n), i;
    if (n === 0 || !_ok(closes[0])) return o;
    o[0] = closes[0];
    for (i = 1; i < n; i++) {
      if (!_ok(closes[i]) || !_ok(o[i - 1])) { o[i] = null; continue; }
      o[i] = (closes[i] + (period - 1) * o[i - 1]) / period;
    }
    return o;
  }
  /* vidya: Chande variable index dynamic average (CMO-adaptive over short,
   * scaled by 2/(long+1)). Prov: Tulip ti_vidya.c. Defaults {short:9, long:12}. */
  function vidya(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var sp = _per(opts.short, 9, 1), lp = _per(opts.long, 12, 1);
    var o = _out(n), k = 2 / (lp + 1), i, j;
    for (i = sp; i < n; i++) {
      var up = 0, dn = 0, ok = true;
      for (j = i - sp + 1; j <= i; j++) {
        if (!_ok(closes[j]) || (j > 0 && !_ok(closes[j - 1]))) { ok = false; break; }
        if (j === 0) continue;
        var d = closes[j] - closes[j - 1];
        if (d > 0) up += d; else dn -= d;
      }
      if (!ok || !_ok(closes[i])) continue;
      var prev = (i === sp || o[i - 1] === null) ? closes[i] : o[i - 1];
      var cmo = (up + dn) === 0 ? 0 : Math.abs(up - dn) / (up + dn);
      o[i] = k * cmo * closes[i] + (1 - k * cmo) * prev;
    }
    return o;
  }
  /* vwma: volume-weighted mean. Prov: Tulip ti_vwma.c. */
  function vwma(closes, volume, period) {
    var n = _arr(closes, "closes"); _arr(volume, "volume");
    period = _per(period, 20, 1);
    var o = _out(n), i, j;
    for (i = period - 1; i < n; i++) {
      var pv = 0, vv = 0, ok = true;
      for (j = i - period + 1; j <= i; j++) {
        if (!_ok(closes[j]) || !_ok(volume[j])) { ok = false; break; }
        pv += closes[j] * volume[j]; vv += volume[j];
      }
      o[i] = (!ok || vv === 0) ? null : pv / vv;
    }
    return o;
  }
  /* linreg: least-squares endpoint forecast. tsf: same forecast series
   * (Tulip tsf == linreg forecast). linregslope: slope only.
   * Prov: Tulip ti_linreg.c / ti_tsf.c / ti_linregslope.c. */
  function _linfit(y) {
    var n = y.length, sx = 0, sy = 0, sxx = 0, sxy = 0, i;
    for (i = 0; i < n; i++) {
      if (!_ok(y[i])) return null;
      sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i];
    }
    var den = n * sxx - sx * sx;
    if (den === 0) return null;
    var slope = (n * sxy - sx * sy) / den;
    return { slope: slope, intercept: (sy - slope * sx) / n };
  }
  function linreg(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 14, 1);
    var o = _out(n), i;
    for (i = period - 1; i < n; i++) {
      var f = _linfit(closes.slice(i - period + 1, i + 1));
      o[i] = f ? f.intercept + f.slope * (period - 1) : null;
    }
    return o;
  }
  function tsf(closes, period) {
    return linreg(closes, period);
  }
  function linregslope(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 14, 1);
    var o = _out(n), i;
    for (i = period - 1; i < n; i++) {
      var f = _linfit(closes.slice(i - period + 1, i + 1));
      o[i] = f ? f.slope : null;
    }
    return o;
  }
  /* kama: Kaufman adaptive MA (fast 2 / slow 30, ER over period).
   * Prov: Tulip ti_kama.c. Default {period:10}. */
  function kama(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 10, 1);
    var o = _out(n), i, j;
    var fast = 2 / 3, slow = 2 / 31, prev = NaN;
    for (i = 0; i < n; i++) {
      if (i < period) continue;
      var er = 0, vol = 0, ok = true;
      for (j = i - period + 1; j <= i; j++) {
        if (!_ok(closes[j]) || !_ok(closes[j - 1])) { ok = false; break; }
        vol += Math.abs(closes[j] - closes[j - 1]);
      }
      if (!ok || vol === 0) {
        /* No movement in the window: the average cannot move — hold the
         * previous value (Tulip yields NaN here; holding is the honest
         * chart-continuous choice, documented). */
        o[i] = _ok(prev) ? prev : closes[i];
        if (_ok(prev)) continue;
        prev = o[i];
        continue;
      }
      er = Math.abs(closes[i] - closes[i - period]) / vol;
      var sc = Math.pow(er * (fast - slow) + slow, 2);
      if (!_ok(prev)) prev = closes[i - 1];
      prev = prev + sc * (closes[i] - prev);
      o[i] = prev;
    }
    return o;
  }
  /* md: mean absolute deviation from the SMA. Prov: Tulip ti_md.c. */
  function md(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 14, 1);
    var o = _out(n), i, j;
    for (i = period - 1; i < n; i++) {
      var mean = 0, ok = true;
      for (j = i - period + 1; j <= i; j++) {
        if (!_ok(closes[j])) { ok = false; break; }
        mean += closes[j];
      }
      if (!ok) continue;
      mean /= period;
      var dev = 0;
      for (j = i - period + 1; j <= i; j++) dev += Math.abs(closes[j] - mean);
      o[i] = dev / period;
    }
    return o;
  }

  I.dema = dema; I.tema = tema; I.wma = wma; I.wilders = wilders;
  I.vidya = vidya; I.vwma = vwma; I.linreg = linreg; I.tsf = tsf;
  I.linregslope = linregslope; I.kama = kama; I.md = md;
})();

if (typeof globalThis !== "undefined" && globalThis.Indicators && typeof module !== "undefined") { module.exports = globalThis.Indicators; }
