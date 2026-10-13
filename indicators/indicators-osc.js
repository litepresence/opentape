/* Indicators-osc: oscillator group for the chart (RSI/stochastic/Aroon-osc/ADX/ATR/Fisher/MFI/UO/FOSC/DMI/MSW).
 * Owns: bounded and range-based oscillator series for Canvas2D chart pixels.
 * Consumes: the `Indicators` global created by js/indicators.js (extends it in place).
 * Side effects: adds 11 properties to the shared `Indicators` object; none otherwise.
 * Globals: NO new global — extends the existing `Indicators` object.
 * Load order: js/indicators.js MUST load BEFORE this file (throws otherwise).
 * Helpers (_arr/_per/_out/_hi/_lo/_tr/_dm) are private verbatim copies of the base
 * file's — no cross-file calls, each file stays self-contained (see base header).
 * Created by: building-vanilla-slices skill, slice-05 refactor (move-only split of
 * indicators.js; logic and provenance comments unchanged).
 * NOTE: Numbers live here ONLY — chart coordinates are not money. Never route
 * asset amounts or prices through these functions.
 */
(function () {
  "use strict";

  /* Base object this file extends (set by indicators.js; load order enforced below). */
  var I = (typeof globalThis !== "undefined") ? globalThis.Indicators : undefined;
  if (typeof I === "undefined" && typeof Indicators !== "undefined") I = Indicators;
  if (!I) throw new Error("indicators-osc.js requires indicators.js first");

  /* _arr: assert array input, return its length. */
  function _arr(x, name) {
    if (!Array.isArray(x)) throw new Error("bad " + (name || "input"));
    return x.length;
  }

  /* _per: period option with default; must be an integer >= minp (default 1). */
  function _per(p, dflt, minp) {
    if (p === undefined) p = dflt;
    if (!Number.isInteger(p) || p < (minp === undefined ? 1 : minp)) throw new Error("bad period");
    return p;
  }

  /* _out: same-length null-filled output (null = warmup bar, existing convention). */
  function _out(n) {
    var o = new Array(n);
    for (var i = 0; i < n; i++) o[i] = null;
    return o;
  }

  /* _hi/_lo: max/min of arr over inclusive index range [i0..i1]. */
  function _hi(a, i0, i1) {
    var m = -Infinity;
    for (var i = i0; i <= i1; i++) if (a[i] > m) m = a[i];
    return m;
  }
  function _lo(a, i0, i1) {
    var m = Infinity;
    for (var i = i0; i <= i1; i++) if (a[i] < m) m = a[i];
    return m;
  }

  /* _tr: Wilder true range at bar i (bar 0 => high-low, mirrors truerange.h). */
  function _tr(h, l, c, i) {
    if (i <= 0) return h[0] - l[0];
    var v = h[i] - l[i], yh = Math.abs(h[i] - c[i - 1]), yl = Math.abs(l[i] - c[i - 1]);
    return yh > v ? (yl > yh ? yl : yh) : (yl > v ? yl : v);
  }

  /* _dm: directional movement at bar i -> [up, down] (mirrors Tulip dx.h). */
  function _dm(h, l, i) {
    var up = h[i] - h[i - 1], down = l[i - 1] - l[i];
    if (up < 0) up = 0; else if (up > down) down = 0;
    if (down < 0) down = 0; else if (down > up) up = 0;
    return [up, down];
  }

  /* rsi: Wilder RSI over closes (smoothed avg gain/loss).
   * Prov: Tulip ti_rsi.c via QTradeX passthrough. Default {period:14}. Warmup: index < period. */
  function rsi(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var period = _per(opts.period, 14, 1), o = _out(n), i;
    if (n <= period) return o;
    var up = 0, down = 0;
    for (i = 1; i <= period; i++) { var u0 = closes[i] - closes[i - 1]; if (u0 > 0) up += u0; else down -= u0; }
    up /= period; down /= period; o[period] = 100 * up / (up + down);
    for (i = period + 1; i < n; i++) {
      var u = closes[i] - closes[i - 1];
      up += ((u > 0 ? u : 0) - up) / period; down += ((u < 0 ? -u : 0) - down) / period;
      o[i] = 100 * up / (up + down);
    }
    return o;
  }

  /* stoch: slow Stochastic %K + %D over high/low/close.
   * Prov: Tulip ti_stoch.c via QTradeX passthrough. Defaults {kPeriod:5, kSlowing:3, dPeriod:3}
   * (tulind README example). Warmup: index < kPeriod+kSlowing+dPeriod-3. */
  function stoch(high, low, close, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); opts = opts || {};
    var kp = _per(opts.kPeriod, 5, 1), ks = _per(opts.kSlowing, 3, 1), dp = _per(opts.dPeriod, 3, 1);
    var o = { k: _out(n), d: _out(n) }, kf = new Array(n), i, j;
    for (i = 0; i < n; i++) {
      if (i < kp - 1) { kf[i] = 0; continue; }
      var mx = _hi(high, i - kp + 1, i), mn = _lo(low, i - kp + 1, i);
      kf[i] = (mx === mn) ? 0 : 100 * (close[i] - mn) / (mx - mn);
    }
    for (i = kp - 1 + ks - 1; i < n; i++) {
      var sk = 0;
      for (j = i - ks + 1; j <= i; j++) sk += kf[j];
      if (i < kp - 1 + ks - 1 + dp - 1) continue;
      var sd = 0;
      for (j = i - dp + 1; j <= i; j++) { var s2 = 0; for (var q = j - ks + 1; q <= j; q++) s2 += kf[q]; sd += s2 / ks; }
      o.k[i] = sk / ks; o.d[i] = sd / dp;
    }
    return o;
  }

  /* aroonosc: (last-high-index - last-low-index) * 100/period, last-tie wins.
   * Prov: Tulip ti_aroonosc.c via QTradeX passthrough. Default {period:25} (Chande standard).
   * Warmup: index < period (first value AT period, mirrors C loop from i=period). */
  function aroonosc(high, low, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); opts = opts || {};
    var period = _per(opts.period, 25, 1), o = _out(n), sc = 100 / period;
    for (var i = period; i < n; i++) {
      var mi = i - period, ni = i - period;
      for (var j = i - period; j <= i; j++) { if (high[j] >= high[mi]) mi = j; if (low[j] <= low[ni]) ni = j; }
      o[i] = (mi - ni) * sc;
    }
    return o;
  }

  /* adx: Wilder average directional index over high/low.
   * Prov: Tulip ti_adx.c (+dx.h) via QTradeX passthrough. Default {period:14}. Warmup: index < 2*(period-1). */
  function adx(high, low, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); opts = opts || {};
    var period = _per(opts.period, 14, 2), o = _out(n);
    if (n <= 2 * (period - 1)) return o;
    var per = (period - 1) / period, inv = 1 / period, up = 0, dn = 0, i, t;
    for (i = 1; i < period; i++) { t = _dm(high, low, i); up += t[0]; dn += t[1]; }
    var ax = 100 * Math.abs(up - dn) / (up + dn);
    for (i = period; i < n; i++) {
      t = _dm(high, low, i); up = up * per + t[0]; dn = dn * per + t[1];
      var dx = 100 * Math.abs(up - dn) / (up + dn);
      if (i - period < period - 2) ax += dx;
      else if (i - period === period - 2) { ax += dx; o[i] = ax * inv; }
      else { ax = ax * per + dx; o[i] = ax * inv; }
    }
    return o;
  }

  /* atr: Wilder average true range over high/low/close.
   * Prov: Tulip ti_atr.c (+truerange.h) via QTradeX passthrough. Default {period:14}. Warmup: index < period-1. */
  function atr(high, low, close, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); opts = opts || {};
    var period = _per(opts.period, 14, 1), o = _out(n), i;
    if (n < period) return o;
    var per = 1 / period, sum = high[0] - low[0];
    for (i = 1; i < period; i++) sum += _tr(high, low, close, i);
    var v = sum / period; o[period - 1] = v;
    for (i = period; i < n; i++) { v += (_tr(high, low, close, i) - v) * per; o[i] = v; }
    return o;
  }

  /* fisher: Ehlers Fisher Transform + signal (one-bar-delayed fish) over (high+low)/2.
   * Prov: Tulip ti_fisher.c via QTradeX passthrough. Default {period:9}. Warmup: index < period-1. */
  function fisher(high, low, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); opts = opts || {};
    var period = _per(opts.period, 9, 1), o = { fisher: _out(n), signal: _out(n) };
    var v1 = 0, fish = 0;
    for (var i = period - 1; i < n; i++) {
      var mx = -Infinity, mn = Infinity, hl = 0;
      for (var j = i - period + 1; j <= i; j++) { hl = (high[j] + low[j]) / 2; if (hl >= mx) mx = hl; if (hl <= mn) mn = hl; }
      var mm = mx - mn; if (mm === 0) mm = 0.001;
      v1 = 0.33 * 2 * ((hl - mn) / mm - 0.5) + 0.67 * v1;
      if (v1 > 0.99) v1 = 0.999; if (v1 < -0.99) v1 = -0.999;
      o.signal[i] = fish;
      fish = 0.5 * Math.log((1 + v1) / (1 - v1)) + 0.5 * fish;
      o.fisher[i] = fish;
    }
    return o;
  }

  /* mfi: money flow index over high/low/close/volume (typical price * volume).
   * Prov: Tulip ti_mfi.c via QTradeX passthrough. Default {period:14}. Warmup: index < period. */
  function mfi(high, low, close, volume, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); _arr(volume, "volume"); opts = opts || {};
    var period = _per(opts.period, 14, 1), o = _out(n);
    var ytyp = (high[0] + low[0] + close[0]) / 3, us = 0, ds = 0, fu = [], fd = [];
    for (var i = 1; i < n; i++) {
      var typ = (high[i] + low[i] + close[i]) / 3, bar = typ * volume[i];
      var u = typ > ytyp ? bar : 0, d = typ < ytyp ? bar : 0;
      fu.push(u); fd.push(d); us += u; ds += d; ytyp = typ;
      if (fu.length > period) { us -= fu.shift(); ds -= fd.shift(); }
      if (i >= period) o[i] = 100 * us / (us + ds);
    }
    return o;
  }

  /* uo: Williams Ultimate Oscillator (4:2:1 weighted buying-pressure ratios).
   * Prov: Tulip ti_ultosc.c via QTradeX passthrough. Defaults {short:7, medium:14, long:28}.
   * Warmup: index < long. */
  function uo(high, low, close, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); opts = opts || {};
    var sp = _per(opts.short, 7, 1), mp = _per(opts.medium, 14, 1), lp = _per(opts.long, 28, 1);
    if (mp < sp || lp < mp) throw new Error("bad period");
    var o = _out(n), bp = new Array(n), r = new Array(n), i, j;
    bp[0] = 0; r[0] = 0;
    for (i = 1; i < n; i++) {
      var tl = Math.min(low[i], close[i - 1]), th = Math.max(high[i], close[i - 1]);
      bp[i] = close[i] - tl; r[i] = th - tl;
    }
    for (i = lp; i < n; i++) {
      var bs = 0, bm = 0, bl = 0, rs = 0, rm = 0, rl = 0;
      for (j = i - sp + 1; j <= i; j++) { bs += bp[j]; rs += r[j]; }
      for (j = i - mp + 1; j <= i; j++) { bm += bp[j]; rm += r[j]; }
      for (j = i - lp + 1; j <= i; j++) { bl += bp[j]; rl += r[j]; }
      o[i] = 100 * (4 * bs / rs + 2 * bm / rm + bl / rl) / 7;
    }
    return o;
  }

  /* fosc: Chande Forecast Oscillator = 100*(close - time-series-forecast)/close.
   * Prov: Tulip ti_fosc.c (+trend.h LINEAR_REGRESSION, forecast=period+1) via QTradeX passthrough.
   * Default {period:5}. Warmup: index < period. */
  function fosc(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var period = _per(opts.period, 5, 1), o = _out(n), i;
    if (n <= period) return o;
    var p = 1 / period, x = 0, x2 = 0, y = 0, xy = 0, tsf = 0;
    for (i = 0; i < period - 1; i++) { x += i + 1; x2 += (i + 1) * (i + 1); xy += closes[i] * (i + 1); y += closes[i]; }
    x += period; x2 += period * period;
    var bd = 1 / (period * x2 - x * x);
    for (i = period - 1; i < n; i++) {
      xy += closes[i] * period; y += closes[i];
      var b = (period * xy - x * y) * bd, a = (y - b * x) * p;
      if (i >= period) o[i] = 100 * (closes[i] - tsf) / closes[i];
      tsf = a + b * (period + 1);
      xy -= y; y -= closes[i - period + 1];
    }
    return o;
  }

  /* dmi: Wilder +DI/-DI pair over high/low/close.
   * Prov: Tulip ti_di.c (+dx.h, truerange.h) via QTradeX passthrough. Default {period:14}.
   * Warmup: index < period-1. Returns {plusDI, minusDI}. */
  function dmi(high, low, close, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); opts = opts || {};
    var period = _per(opts.period, 14, 1), o = { plusDI: _out(n), minusDI: _out(n) }, i, t;
    if (n <= period - 1) return o;
    var per = (period - 1) / period, av = 0, up = 0, dn = 0;
    for (i = 1; i < period; i++) { av += _tr(high, low, close, i); t = _dm(high, low, i); up += t[0]; dn += t[1]; }
    o.plusDI[period - 1] = 100 * up / av; o.minusDI[period - 1] = 100 * dn / av;
    for (i = period; i < n; i++) {
      av = av * per + _tr(high, low, close, i); t = _dm(high, low, i);
      up = up * per + t[0]; dn = dn * per + t[1];
      o.plusDI[i] = 100 * up / av; o.minusDI[i] = 100 * dn / av;
    }
    return o;
  }

  /* msw: Ehlers MESA sine wave + 45-degree lead via DFT phase (BONUS — verifiable in ti_msw.c).
   * Prov: Tulip ti_msw.c via QTradeX passthrough. Default {period:20} (DFT-window convention, recorded).
   * Warmup: index < period. Outputs in [-1,1]. FFT-lowpass: DEFERRED (no verifiable formula found). */
  function msw(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var period = _per(opts.period, 20, 1), o = { sine: _out(n), lead: _out(n) };
    var pi = 3.1415926, tpi = 2 * pi; /* Tulip ti_msw.c constant verbatim (not Math.PI) for bit-parity. */
    for (var i = period; i < n; i++) {
      var rp = 0, ip = 0;
      for (var j = 0; j < period; j++) { rp += Math.cos(tpi * j / period) * closes[i - j]; ip += Math.sin(tpi * j / period) * closes[i - j]; }
      var ph = (Math.abs(rp) > 0.001) ? Math.atan(ip / rp) : tpi / 2 * (ip < 0 ? -1 : 1);
      if (rp < 0) ph += pi;
      ph += pi / 2; if (ph < 0) ph += tpi; if (ph > tpi) ph -= tpi;
      o.sine[i] = Math.sin(ph); o.lead[i] = Math.sin(ph + pi / 4);
    }
    return o;
  }

  /* Extend the shared Indicators object in place — no new global. */
  I.rsi = rsi;
  I.stoch = stoch;
  I.aroonosc = aroonosc;
  I.adx = adx;
  I.atr = atr;
  I.fisher = fisher;
  I.mfi = mfi;
  I.uo = uo;
  I.fosc = fosc;
  I.dmi = dmi;
  I.msw = msw;
})();

/* Re-export the extended object for Node (no-op in browsers). */
if (typeof globalThis !== "undefined" && globalThis.Indicators && typeof module !== "undefined") { module.exports = globalThis.Indicators; }
