/* Indicators-Tulip momentum: dependency-free math (oscillator group).
 * Owns: stochrsi, adxr, aroon, cci, cmo, dx, di, mom, roc, rocr, trix,
 *   ultosc, willr, apo, ppo, bop, qstick — Tulip momentum fns missing from
 *   indicators-osc.js. Attaches onto shared global Indicators (same pattern
 *   as indicators-tulip.js). Inputs: clean number arrays; null/NaN in a
 *   window yields null (chart warmup contract). No DOM/chain/money.
 * Prov: Tulip ti_*.c semantics via QTradeX qx.ti passthrough; formulas
 *   reimplemented. Sign/scale choices documented per fn (not hidden).
 * Created by: building-vanilla-slices skill, indicator-parity plan. */
(function () {
  "use strict";

  var I = (typeof globalThis !== "undefined") ? globalThis.Indicators : undefined;
  if (typeof I === "undefined" && typeof Indicators !== "undefined") I = Indicators;
  if (!I) throw new Error("indicators-tmom.js requires indicators.js first");

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
  /* Wilder DM/TR smoothing core shared by dx/di/adx-style math (mirrors
   * indicators-osc.js _tr/_dm — per-file copies, doctrine rule 5 noted in
   * indicators-tulip.js). Returns {dip, dim} same-length arrays (null warmup). */
  function _diPair(high, low, period) {
    var n = high.length, dip = _out(n), dim = _out(n), i;
    if (n <= period) return { dip: dip, dim: dim };
    var tr = 0, up = 0, dn = 0, ok = true;
    for (i = 1; i <= period; i++) {
      if (!_ok(high[i]) || !_ok(low[i]) || !_ok(high[i - 1]) || !_ok(low[i - 1])) { ok = false; break; }
      var u0 = high[i] - high[i - 1], d0 = low[i - 1] - low[i];
      if (u0 < 0) u0 = 0; else if (u0 > d0) d0 = 0;
      if (d0 < 0) d0 = 0; else if (d0 > u0) u0 = 0;
      var t0 = high[i] - low[i];
      var yh = Math.abs(high[i] - low[i - 1]), yl = Math.abs(low[i] - high[i - 1]);
      tr += yh > t0 ? (yl > yh ? yl : yh) : (yl > t0 ? yl : t0);
      up += u0; dn += d0;
    }
    if (!ok || tr === 0) return { dip: dip, dim: dim };
    var per = (period - 1) / period;
    dip[period] = 100 * up / tr; dim[period] = 100 * dn / tr;
    for (i = period + 1; i < n; i++) {
      if (!_ok(high[i]) || !_ok(low[i]) || !_ok(high[i - 1]) || !_ok(low[i - 1])) continue;
      var u = high[i] - high[i - 1], d = low[i - 1] - low[i];
      if (u < 0) u = 0; else if (u > d) d = 0;
      if (d < 0) d = 0; else if (d > u) u = 0;
      var t = high[i] - low[i];
      var xh = Math.abs(high[i] - low[i - 1]), xl = Math.abs(low[i] - high[i - 1]);
      tr = tr * per + (xh > t ? (xl > xh ? xl : xh) : (xl > t ? xl : t));
      up = up * per + u; dn = dn * per + d;
      if (tr === 0) continue;
      dip[i] = 100 * up / tr; dim[i] = 100 * dn / tr;
    }
    return { dip: dip, dim: dim };
  }
  function _ema(a, n) {
    var o = _out(a.length), k = 2 / (n + 1), sum = 0, cnt = 0, started = false, prev = 0, i;
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
  function _rsiArr(closes, period) {
    var n = closes.length, o = _out(n), i;
    if (n <= period) return o;
    var up = 0, dn = 0;
    for (i = 1; i <= period; i++) {
      if (!_ok(closes[i]) || !_ok(closes[i - 1])) return o;
      var u0 = closes[i] - closes[i - 1];
      if (u0 > 0) up += u0; else dn -= u0;
    }
    up /= period; dn /= period;
    o[period] = (up + dn) === 0 ? 50 : 100 * up / (up + dn);
    for (i = period + 1; i < n; i++) {
      if (!_ok(closes[i]) || !_ok(closes[i - 1])) continue;
      var u = closes[i] - closes[i - 1];
      up += ((u > 0 ? u : 0) - up) / period; dn += ((u < 0 ? -u : 0) - dn) / period;
      if (o[i - 1] === null) continue;
      o[i] = (up + dn) === 0 ? 50 : 100 * up / (up + dn);
    }
    return o;
  }

  /* stochrsi: Stochastic of the RSI series (%K over n, 0-100 scale).
   * Prov: Tulip ti_stochrsi.c. Default {period:14}. */
  function stochrsi(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 14, 1);
    var o = _out(n), r = _rsiArr(closes, period), i, j;
    for (i = period; i < n; i++) {
      var mn = Infinity, mx = -Infinity, ok = true;
      for (j = i - period + 1; j <= i; j++) {
        if (!_ok(r[j])) { ok = false; break; }
        if (r[j] < mn) mn = r[j];
        if (r[j] > mx) mx = r[j];
      }
      if (!ok) continue;
      o[i] = (mx === mn) ? 0 : 100 * (r[i] - mn) / (mx - mn);
    }
    return o;
  }
  /* adxr: (ADX[i] + ADX[i-n+1]) / 2. Prov: Tulip ti_adxr.c. */
  function adxr(high, low, period) {
    var n = _arr(high, "high"); _arr(low, "low"); period = _per(period, 14, 2);
    var o = _out(n);
    if (typeof I.adx !== "function") return o;
    var a = I.adx(high, low, { period: period }), i;
    for (i = 0; i < n; i++) {
      if (!_ok(a[i]) || i - period + 1 < 0 || !_ok(a[i - period + 1])) continue;
      o[i] = (a[i] + a[i - period + 1]) / 2;
    }
    return o;
  }
  /* aroon: {up, down} 0-100 trend bars. Prov: Tulip ti_aroon.c. */
  function aroon(high, low, period) {
    var n = _arr(high, "high"); _arr(low, "low"); period = _per(period, 25, 1);
    var up = _out(n), dn = _out(n), i, j;
    for (i = period; i < n; i++) {
      var mi = i - period, ni = i - period, ok = true;
      for (j = i - period; j <= i; j++) {
        if (!_ok(high[j]) || !_ok(low[j])) { ok = false; break; }
        if (high[j] >= high[mi]) mi = j;
        if (low[j] <= low[ni]) ni = j;
      }
      if (!ok) continue;
      up[i] = 100 * (period - (i - mi)) / period;
      dn[i] = 100 * (period - (i - ni)) / period;
    }
    return { up: up, down: dn };
  }
  /* cci: (TP - SMA) / (0.015 * meanDev), TP=(h+l+c)/3. Prov: Tulip ti_cci.c. */
  function cci(high, low, close, period) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close");
    period = _per(period, 20, 1);
    var o = _out(n), i, j;
    for (i = period - 1; i < n; i++) {
      var tp = [], ok = true;
      for (j = i - period + 1; j <= i; j++) {
        if (!_ok(high[j]) || !_ok(low[j]) || !_ok(close[j])) { ok = false; break; }
        tp.push((high[j] + low[j] + close[j]) / 3);
      }
      if (!ok) continue;
      var mean = 0;
      for (j = 0; j < period; j++) mean += tp[j];
      mean /= period;
      var dev = 0;
      for (j = 0; j < period; j++) dev += Math.abs(tp[j] - mean);
      dev /= period;
      o[i] = dev === 0 ? 0 : (tp[period - 1] - mean) / (0.015 * dev);
    }
    return o;
  }
  /* cmo: 100*(upSum-dnSum)/(upSum+dnSum). Prov: Tulip ti_cmo.c. */
  function cmo(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 14, 1);
    var o = _out(n), i, j;
    for (i = period; i < n; i++) {
      var up = 0, dn = 0, ok = true;
      for (j = i - period + 1; j <= i; j++) {
        if (!_ok(closes[j]) || !_ok(closes[j - 1])) { ok = false; break; }
        var d = closes[j] - closes[j - 1];
        if (d > 0) up += d; else dn -= d;
      }
      if (!ok) continue;
      o[i] = (up + dn) === 0 ? 0 : 100 * (up - dn) / (up + dn);
    }
    return o;
  }
  /* dx: 100*|+DI - -DI|/(+DI + -DI). Prov: Tulip ti_dx.c (+dx.h). */
  function dx(high, low, period) {
    var n = _arr(high, "high"); _arr(low, "low"); period = _per(period, 14, 1);
    var o = _out(n), p = _diPair(high, low, period), i;
    for (i = 0; i < n; i++) {
      if (!_ok(p.dip[i]) || !_ok(p.dim[i]) || (p.dip[i] + p.dim[i]) === 0) continue;
      o[i] = 100 * Math.abs(p.dip[i] - p.dim[i]) / (p.dip[i] + p.dim[i]);
    }
    return o;
  }
  /* di: {plus, minus} directional indicators. Prov: Tulip ti_di.c. */
  function di(high, low, period) {
    var n = _arr(high, "high"); _arr(low, "low"); period = _per(period, 14, 1);
    var p = _diPair(high, low, period);
    return { plus: p.dip, minus: p.dim };
  }
  /* mom: close - close[n-1]. Prov: Tulip ti_mom.c. */
  function mom(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 12, 1);
    var o = _out(n), i;
    for (i = period; i < n; i++) {
      if (!_ok(closes[i]) || !_ok(closes[i - period])) continue;
      o[i] = closes[i] - closes[i - period];
    }
    return o;
  }
  /* roc: (close/close[n-1]) - 1 (ratio, Tulip scale). rocr: close/close[n-1].
   * Prov: Tulip ti_roc.c / ti_rocr.c. */
  function roc(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 12, 1);
    var o = _out(n), i;
    for (i = period; i < n; i++) {
      if (!_ok(closes[i]) || !_ok(closes[i - period]) || closes[i - period] === 0) continue;
      o[i] = closes[i] / closes[i - period] - 1;
    }
    return o;
  }
  function rocr(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 12, 1);
    var o = _out(n), i;
    for (i = period; i < n; i++) {
      if (!_ok(closes[i]) || !_ok(closes[i - period]) || closes[i - period] === 0) continue;
      o[i] = closes[i] / closes[i - period];
    }
    return o;
  }
  /* trix: TRIPLE-EMA rate of change as a RATIO (Tulip scale — qi.pyx trix
   * multiplies by 100; documented difference, same shape). Prov: Tulip ti_trix.c. */
  function trix(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 15, 1);
    var o = _out(n);
    function num(a) { return a.map(function (v) { return v === null ? NaN : v; }); }
    var e1 = _ema(closes, period), e2 = _ema(num(e1), period), e3 = _ema(num(e2), period), i;
    for (i = 1; i < n; i++) {
      if (!_ok(e3[i]) || !_ok(e3[i - 1]) || e3[i - 1] === 0) continue;
      o[i] = (e3[i] - e3[i - 1]) / e3[i - 1];
    }
    return o;
  }
  /* ultosc: 100*(4*avg7 + 2*avg14 + avg28)/7 of BP/TR. Prov: Tulip ti_ultosc.c. */
  function ultosc(high, low, close, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); opts = opts || {};
    var s = _per(opts.short, 7, 1), m = _per(opts.middle, 14, 1), l = _per(opts.long, 28, 1);
    var o = _out(n), i, j;
    function avg(len, idx) {
      var bp = 0, tr = 0;
      for (var j = idx - len + 1; j <= idx; j++) {
        if (!_ok(high[j]) || !_ok(low[j]) || !_ok(close[j]) || !_ok(close[j - 1])) return null;
        var lo = Math.min(low[j], close[j - 1]), hi = Math.max(high[j], close[j - 1]);
        bp += close[j] - lo; tr += hi - lo;
      }
      return tr === 0 ? null : bp / tr;
    }
    for (i = l; i < n; i++) {
      var a = avg(s, i), b = avg(m, i), c = avg(l, i);
      if (a === null || b === null || c === null) continue;
      o[i] = 100 * (4 * a + 2 * b + c) / 7;
    }
    return o;
  }
  /* willr: (HH - close)/(HH - LL) * -100. Prov: Tulip ti_willr.c. */
  function willr(high, low, close, period) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close");
    period = _per(period, 14, 1);
    var o = _out(n), i;
    for (i = period - 1; i < n; i++) {
      var hh = _hi(high, i - period + 1, i), ll = _lo(low, i - period + 1, i);
      if (!_ok(hh) || !_ok(ll) || !_ok(close[i])) continue;
      o[i] = (hh === ll) ? 0 : 100 * (hh - close[i]) / (hh - ll) * -1;
    }
    return o;
  }
  /* apo: EMA(s)-EMA(l). ppo: 100*(EMA(s)-EMA(l))/EMA(l). Prov: Tulip ti_apo.c / ti_ppo.c. */
  function apo(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var s = _per(opts.short, 12, 1), l = _per(opts.long, 26, 1);
    var o = _out(n), es = _ema(closes, s), el = _ema(closes, l), i;
    for (i = 0; i < n; i++) {
      if (!_ok(es[i]) || !_ok(el[i])) continue;
      o[i] = es[i] - el[i];
    }
    return o;
  }
  function ppo(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var s = _per(opts.short, 12, 1), l = _per(opts.long, 26, 1);
    var o = _out(n), es = _ema(closes, s), el = _ema(closes, l), i;
    for (i = 0; i < n; i++) {
      if (!_ok(es[i]) || !_ok(el[i]) || el[i] === 0) continue;
      o[i] = 100 * (es[i] - el[i]) / el[i];
    }
    return o;
  }
  /* bop: (close - open)/(high - low). Prov: Tulip ti_bop.c. */
  function bop(open, high, low, close) {
    var n = _arr(open, "open"); _arr(high, "high"); _arr(low, "low"); _arr(close, "close");
    var o = _out(n), i;
    for (i = 0; i < n; i++) {
      if (!_ok(open[i]) || !_ok(high[i]) || !_ok(low[i]) || !_ok(close[i])) continue;
      o[i] = (high[i] === low[i]) ? 0 : (close[i] - open[i]) / (high[i] - low[i]);
    }
    return o;
  }
  /* qstick: SMA(close - open, n). SIGN CONVENTION documented: positive when
   * closes beat opens (StockCharts polarity). Prov: Tulip ti_qstick.c. */
  function qstick(open, close, period) {
    var n = _arr(open, "open"); _arr(close, "close"); period = _per(period, 8, 1);
    var o = _out(n), i, j;
    for (i = period - 1; i < n; i++) {
      var s = 0, ok = true;
      for (j = i - period + 1; j <= i; j++) {
        if (!_ok(open[j]) || !_ok(close[j])) { ok = false; break; }
        s += close[j] - open[j];
      }
      o[i] = ok ? s / period : null;
    }
    return o;
  }

  I.stochrsi = stochrsi; I.adxr = adxr; I.aroon = aroon; I.cci = cci;
  I.cmo = cmo; I.dx = dx; I.di = di; I.mom = mom; I.roc = roc;
  I.rocr = rocr; I.trix = trix; I.ultosc = ultosc; I.willr = willr;
  I.apo = apo; I.ppo = ppo; I.bop = bop; I.qstick = qstick;
})();

if (typeof globalThis !== "undefined" && globalThis.Indicators && typeof module !== "undefined") { module.exports = globalThis.Indicators; }
