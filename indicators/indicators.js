/* Indicators: pure-function chart overlay math, base file (helpers + SMA/EMA + trend/overlay group).
 * Owns: rolling-mean/exponential-mean arrays plus trend/overlay series (MACD, Bollinger,
 * stddev, TRIMA, ZLEMA, HMA, FRAMA, VWAP, PSAR, Ichimoku, Heikin-Ashi, Renko) for Canvas2D chart pixels.
 * Consumes: nothing. Side effects: none (pure functions).
 * Globals: exposes single `Indicators` global; Node guard via module.exports.
 * Load order: this file FIRST, then js/indicators-osc.js (osc file extends the same
 * `Indicators` object and throws if this file has not run yet). Helpers shared by both
 * files (_arr/_per/_out/_hi/_lo) are duplicated verbatim per file on purpose — no
 * cross-file calls, so either file's internals stay self-contained; _tr/_dm live only
 * in the osc file (no base function uses them), _wma lives only here (sole caller hma).
 * Created by: building-vanilla-slices skill, slice-05-exchange-read plan Task 1;
 * split into base+osc by refactor (move-only, no logic changes).
 * NOTE: Numbers live here ONLY — chart coordinates are not money. The
 * underlying bucket values stay raw integers until plotted; never route
 * asset amounts or prices through these functions.
 */
var Indicators = (function () {
  "use strict";

  /* sma: simple moving average over closes.
   * Params: closes (number[]), period (positive int).
   * Returns number[] same length as closes, null for warmup bars (index < period-1).
   * Throws on bad period or non-array input. */
  function sma(closes, period) {
    if (!Array.isArray(closes)) throw new Error("bad closes");
    if (!Number.isInteger(period) || period <= 0) throw new Error("bad period");
    var out = new Array(closes.length);
    var sum = 0;
    for (var i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= period) sum -= closes[i - period];
      out[i] = i >= period - 1 ? sum / period : null;
    }
    return out;
  }

  /* ema: exponential moving average over closes, seeded with SMA(period).
   * Params: closes (number[]), period (positive int).
   * Returns number[] same length as closes, null for warmup bars
   * (index < period-1); out[period-1] is the SMA seed, later bars use
   * k=2/(period+1). Throws on bad period or non-array input. */
  function ema(closes, period) {
    if (!Array.isArray(closes)) throw new Error("bad closes");
    if (!Number.isInteger(period) || period <= 0) throw new Error("bad period");
    var out = new Array(closes.length);
    var k = 2 / (period + 1);
    var sum = 0;
    for (var i = 0; i < closes.length; i++) {
      if (i < period - 1) {
        sum += closes[i];
        out[i] = null;
      } else if (i === period - 1) {
        sum += closes[i];
        out[i] = sum / period;
      } else {
        out[i] = closes[i] * k + out[i - 1] * (1 - k);
      }
    }
    return out;
  }

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

  /* _wma: linear-weighted MA, same length, null warmup (index < period-1). */
  function _wma(a, period) {
    var n = a.length, o = _out(n), w = period * (period + 1) / 2, ws = 0, s = 0;
    for (var i = 0; i < n; i++) {
      if (i < period) {
        ws += a[i] * (i + 1); s += a[i];
        if (i === period - 1) o[i] = ws / w;
      } else {
        ws += a[i] * period - s; s += a[i] - a[i - period];
        o[i] = ws / w;
      }
    }
    return o;
  }

  /* macd: MACD line + signal + histogram over closes.
   * Prov: Tulip ti_macd.c (incl. the 12/26 k-factor quirk), via QTradeX tulipy_wrapped.py passthrough.
   * Defaults {short:12, long:26, signal:9} (universal; Tulip C special-cases 12/26). Warmup: index < long-1. */
  function macd(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var sp = _per(opts.short, 12, 1), lp = _per(opts.long, 26, 2), gp = _per(opts.signal, 9, 1);
    if (lp < sp) throw new Error("bad period");
    var o = { macd: _out(n), signal: _out(n), hist: _out(n) };
    var sf = 2 / (sp + 1), lf = 2 / (lp + 1), gf = 2 / (gp + 1);
    if (sp === 12 && lp === 26) { sf = 0.15; lf = 0.075; }
    var se = closes[0], le = closes[0], sg = 0;
    for (var i = 1; i < n; i++) {
      se += (closes[i] - se) * sf; le += (closes[i] - le) * lf;
      var m = se - le;
      if (i === lp - 1) sg = m;
      if (i >= lp - 1) { sg += (m - sg) * gf; o.macd[i] = m; o.signal[i] = sg; o.hist[i] = m - sg; }
    }
    return o;
  }

  /* bbands: Bollinger lower/middle/upper (population variance, no clamp — mirrors C sqrt).
   * Prov: Tulip ti_bbands.c via QTradeX passthrough. Defaults {period:20, stddev:2} (Bollinger standard).
   * Warmup: index < period-1. */
  function bbands(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var period = _per(opts.period, 20, 1), mult = (opts.stddev === undefined ? 2 : opts.stddev);
    if (!(mult > 0)) throw new Error("bad stddev");
    var o = { lower: _out(n), middle: _out(n), upper: _out(n) }, s = 0, s2 = 0, sc = 1 / period;
    for (var i = 0; i < n; i++) {
      s += closes[i]; s2 += closes[i] * closes[i];
      if (i >= period) { s -= closes[i - period]; s2 -= closes[i - period] * closes[i - period]; }
      if (i >= period - 1) {
        var m = s * sc, sd = Math.sqrt(s2 * sc - m * m);
        o.middle[i] = m; o.lower[i] = m - mult * sd; o.upper[i] = m + mult * sd;
      }
    }
    return o;
  }

  /* stddev: rolling population standard deviation (mirrors C: negatives pass through unclamped).
   * Prov: Tulip ti_stddev.c via QTradeX passthrough. Default {period:5} (TA-Lib STDDEV default).
   * Warmup: index < period-1. */
  function stddev(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var period = _per(opts.period, 5, 1), o = _out(n), s = 0, s2 = 0, sc = 1 / period;
    for (var i = 0; i < n; i++) {
      s += closes[i]; s2 += closes[i] * closes[i];
      if (i >= period) { s -= closes[i - period]; s2 -= closes[i - period] * closes[i - period]; }
      if (i >= period - 1) { var v = s2 * sc - (s * sc) * (s * sc); o[i] = v > 0 ? Math.sqrt(v) : v; }
    }
    return o;
  }

  /* psar: Wilder parabolic SAR over high/low.
   * Prov: Tulip ti_psar.c via QTradeX passthrough. Defaults {step:0.02, max:0.2}. Warmup: index 0. */
  function psar(high, low, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); opts = opts || {};
    var step = (opts.step === undefined ? 0.02 : opts.step), mx = (opts.max === undefined ? 0.2 : opts.max);
    if (!(step > 0) || !(mx > step)) throw new Error("bad psar accel");
    var o = _out(n);
    if (n < 2) return o;
    var lng = (high[0] + low[0] <= high[1] + low[1]) ? 1 : 0;
    var sar = lng ? low[0] : high[0], ext = lng ? high[0] : low[0], acc = step;
    for (var i = 1; i < n; i++) {
      sar += (ext - sar) * acc;
      if (lng) {
        if (i >= 2 && sar > low[i - 2]) sar = low[i - 2];
        if (sar > low[i - 1]) sar = low[i - 1];
        if (acc < mx && high[i] > ext) { acc += step; if (acc > mx) acc = mx; }
        if (high[i] > ext) ext = high[i];
      } else {
        if (i >= 2 && sar < high[i - 2]) sar = high[i - 2];
        if (sar < high[i - 1]) sar = high[i - 1];
        if (acc < mx && low[i] < ext) { acc += step; if (acc > mx) acc = mx; }
        if (low[i] < ext) ext = low[i];
      }
      if ((lng && low[i] < sar) || (!lng && high[i] > sar)) {
        acc = step; sar = ext; lng = lng ? 0 : 1;
        ext = lng ? high[i] : low[i];
      }
      o[i] = sar;
    }
    return o;
  }

  /* vwap: session-cumulative typical-price VWAP (no period — cumulative from bar 0).
   * Prov: standard definition; NO QTradeX raw exists (searched qi.pyx, utilities.pyx,
   * tulipy_wrapped.py — only Tulip vwma, a different rolling indicator). Null while volume sums to 0. */
  function vwap(high, low, close, volume) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); _arr(volume, "volume");
    var o = _out(n), pv = 0, vv = 0;
    for (var i = 0; i < n; i++) {
      pv += ((high[i] + low[i] + close[i]) / 3) * volume[i]; vv += volume[i];
      o[i] = (vv === 0) ? null : pv / vv;
    }
    return o;
  }

  /* zlema: zero-lag EMA (EMA of close + (close - lagged close)).
   * Prov: Tulip ti_zlema.c via QTradeX passthrough. Default {period:20}. Warmup: index < lag-1
   * (lag = floor((period-1)/2)); period>=3 required (Tulip C reads out-of-bounds below that). */
  function zlema(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var period = _per(opts.period, 20, 3), o = _out(n);
    var lag = ((period - 1) / 2) | 0, start = lag - 1, per = 2 / (period + 1), val = closes[lag - 1];
    if (n > start) o[start] = val;
    for (var i = lag; i < n; i++) { var c = closes[i]; val += ((c + (c - closes[i - lag])) - val) * per; o[i] = val; }
    return o;
  }

  /* trima: triangular MA (double-smoothed SMA; period<=2 delegates to SMA like C).
   * Prov: Tulip ti_trima.c via QTradeX passthrough. Default {period:30} (TA-Lib TRIMA default).
   * Warmup: index < period-1. */
  function trima(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var period = _per(opts.period, 30, 1), o = _out(n);
    if (period <= 2) return sma(closes, period);
    var half = (period / 2) | 0, wsum = (period % 2) ? (half + 1) * (half + 1) : (half + 1) * half;
    for (var i = period - 1; i < n; i++) {
      var s = 0;
      for (var j = 0; j < period; j++) s += closes[i - period + 1 + j] * Math.min(j + 1, period - j);
      o[i] = s / wsum;
    }
    return o;
  }

  /* hma: Hull MA = WMA(2*WMA(N/2) - WMA(N), sqrt(N)).
   * Prov: Tulip ti_hma.c via QTradeX passthrough. Default {period:9} (common chart default).
   * Warmup: index < period+floor(sqrt(period))-2. */
  function hma(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var period = _per(opts.period, 9, 2), o = _out(n);
    var half = (period / 2) | 0, sq = Math.floor(Math.sqrt(period)), start = period + sq - 2;
    var wFull = _wma(closes, period), wHalf = _wma(closes, half), diff = new Array(n), i;
    for (i = 0; i < n; i++) diff[i] = (wFull[i] === null || wHalf[i] === null) ? 0 : 2 * wHalf[i] - wFull[i];
    var w3 = _wma(diff, sq);
    for (i = start; i < n; i++) o[i] = w3[i];
    return o;
  }

  /* renko: percent-brick levels as a same-length series (out[i] = brick level at bar i, no nulls).
   * Prov: QTradeX qi.pyx renko() (brick_size = price*brick_percent/100, recomputed per bar);
   * same-length adaptation recorded (qi returns a variable-length brick array).
   * Default {brickPercent:1} (qi takes it explicit; 1% neutral default, recorded). */
  function renko(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var pct = (opts.brickPercent === undefined ? 1 : opts.brickPercent);
    if (typeof pct !== "number" || !(pct > 0)) throw new Error("bad brickPercent");
    var o = new Array(n), last = closes[0];
    for (var i = 0; i < n; i++) {
      var price = closes[i], sz = price * pct / 100;
      if (sz > 0) {
        while (price >= last + sz) last += sz;
        while (price <= last - sz) last -= sz;
      }
      o[i] = last;
    }
    return o;
  }

  /* heikinashi: Heikin-Ashi candles {open, high, low, close}; haClose=(O+H+L+C)/4 identity holds every bar.
   * Prov: QTradeX qi.pyx heikin_ashi() WITH index-0 fix recorded (qi leaves ha_close[0]=0; standard
   * sets (O+H+L+C)/4; ha_open[0]=open[0] kept). No params, no nulls. */
  function heikinashi(open, high, low, close) {
    var n = _arr(open, "open"); _arr(high, "high"); _arr(low, "low"); _arr(close, "close");
    var o = { open: new Array(n), high: new Array(n), low: new Array(n), close: new Array(n) }, po = 0;
    for (var i = 0; i < n; i++) {
      var hc = (open[i] + high[i] + low[i] + close[i]) / 4;
      var ho = (i === 0) ? open[0] : (po + close[i - 1]) / 2;
      o.close[i] = hc; o.open[i] = ho;
      o.high[i] = Math.max(high[i], ho, hc); o.low[i] = Math.min(low[i], ho, hc);
      po = ho;
    }
    return o;
  }

  /* ichimoku: tenkan/kijun/senkouA/senkouB/chikou (unshifted, as qi.pyx computes them).
   * Prov: QTradeX qi.pyx ichimoku() verbatim math; null-guarded pre-warmup (qi zero-fills;
   * identical under standard periods). Defaults {tenkan:9, kijun:26, senkouB:52, displacement:26}. */
  function ichimoku(high, low, close, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); opts = opts || {};
    var tp = _per(opts.tenkan, 9, 1), kp = _per(opts.kijun, 26, 1);
    var sb = _per(opts.senkouB, 52, 1), dsp = _per(opts.displacement, 26, 1);
    var o = { tenkan: _out(n), kijun: _out(n), senkouA: _out(n), senkouB: _out(n), chikou: _out(n) }, i;
    for (i = tp - 1; i < n; i++) o.tenkan[i] = (_hi(high, i - tp + 1, i) + _lo(low, i - tp + 1, i)) / 2;
    for (i = kp - 1; i < n; i++) o.kijun[i] = (_hi(high, i - kp + 1, i) + _lo(low, i - kp + 1, i)) / 2;
    for (i = dsp - 1; i < n; i++) {
      if (o.tenkan[i] !== null && o.kijun[i] !== null) o.senkouA[i] = (o.tenkan[i] + o.kijun[i]) / 2;
    }
    for (i = sb - 1; i < n; i++) o.senkouB[i] = (_hi(high, i - sb + 1, i) + _lo(low, i - sb + 1, i)) / 2;
    for (i = dsp; i < n; i++) o.chikou[i] = close[i - dsp];
    return o;
  }

  /* frama: QTradeX fractal blend = SMA(period) pulled toward mean(fractalPeriod).
   * Prov: QTradeX qi.pyx frama() verbatim — NOTE this is NOT Ehlers FRAMA (no log-range fractal
   * dimension); ported as-is and recorded as QTradeX-specific. Defaults {period:14, fractalPeriod:2}
   * (qi.pyx docstring). Warmup: index < period-1. */
  function frama(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var period = _per(opts.period, 14, 1), fp = _per(opts.fractalPeriod, 2, 1), o = _out(n);
    for (var i = period - 1; i < n; i++) {
      var s = 0, j;
      for (j = i - period + 1; j <= i; j++) s += closes[j];
      var v = s / period, f = 0;
      if (i >= fp - 1) { var fs = 0; for (j = i - fp + 1; j <= i; j++) fs += closes[j]; f = fs / fp; }
      o[i] = (f > 0) ? v + (f - v) / fp : v;
    }
    return o;
  }

  return {
    sma: sma,
    ema: ema,
    macd: macd,
    bbands: bbands,
    stddev: stddev,
    psar: psar,
    vwap: vwap,
    zlema: zlema,
    trima: trima,
    hma: hma,
    renko: renko,
    heikinashi: heikinashi,
    ichimoku: ichimoku,
    frama: frama
  };
})();

/* Expose the single Indicators global to Node for headless smoke tests (no-op in browsers). */
if (typeof globalThis !== "undefined" && typeof globalThis.Indicators === "undefined") { globalThis.Indicators = Indicators; }
if (typeof module !== "undefined") { module.exports = Indicators; }
