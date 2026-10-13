/* Indicators-Tulip volume/volatility: dependency-free math.
 * Owns: obv, emv, vosc, nvi, pvi, wad, ad, cvi, natr, mass, kvo, adosc,
 *   dpo, vhf, volatility — Tulip volume/volatility fns missing from
 *   indicators-osc.js. Attaches onto shared global Indicators (same pattern
 *   as indicators-tulip.js). Volume inputs are human-string-friendly numbers
 *   (chart coordinates, never money). Null/NaN in a window yields null.
 * Prov: Tulip ti_*.c semantics via QTradeX qx.ti passthrough; formulas
 *   reimplemented. Scale choices documented per fn.
 * Created by: building-vanilla-slices skill, indicator-parity plan. */
(function () {
  "use strict";

  var I = (typeof globalThis !== "undefined") ? globalThis.Indicators : undefined;
  if (typeof I === "undefined" && typeof Indicators !== "undefined") I = Indicators;
  if (!I) throw new Error("indicators-tvol.js requires indicators.js first");

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
  function _trAt(h, l, c, i) {
    if (i <= 0) return h[0] - l[0];
    var v = h[i] - l[i], yh = Math.abs(h[i] - c[i - 1]), yl = Math.abs(l[i] - c[i - 1]);
    return yh > v ? (yl > yh ? yl : yh) : (yl > v ? yl : v);
  }
  function _atrArr(h, l, c, n) {
    var o = _out(h.length), i, acc = 0, started = false;
    for (i = 0; i < h.length; i++) {
      if (!_ok(h[i]) || !_ok(l[i]) || !_ok(c[i])) continue;
      var t = _trAt(h, l, c, i);
      acc += t;
      if (i < n - 1) continue;
      if (!started) { o[i] = acc / n; started = true; }
      else o[i] = (o[i - 1] * (n - 1) + t) / n;
      if (i === n - 1 && started && o[i] === null) o[i] = acc / n;
    }
    return o;
  }

  /* obv: cumulative +/-volume on up/down closes. Prov: Tulip ti_obv.c. */
  function obv(closes, volume) {
    var n = _arr(closes, "closes"); _arr(volume, "volume");
    var o = _out(n), acc = 0, i;
    for (i = 0; i < n; i++) {
      if (!_ok(closes[i]) || !_ok(volume[i])) continue;
      if (i > 0 && _ok(closes[i - 1])) {
        if (closes[i] > closes[i - 1]) acc += volume[i];
        else if (closes[i] < closes[i - 1]) acc -= volume[i];
      }
      o[i] = acc;
    }
    return o;
  }
  /* emv: midpoint-move * range/volume. Prov: Tulip ti_emv.c. */
  function emv(high, low, volume) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(volume, "volume");
    var o = _out(n), i;
    for (i = 1; i < n; i++) {
      if (!_ok(high[i]) || !_ok(low[i]) || !_ok(volume[i]) ||
          !_ok(high[i - 1]) || !_ok(low[i - 1]) || volume[i] === 0) continue;
      var mid = (high[i] + low[i]) / 2 - (high[i - 1] + low[i - 1]) / 2;
      var ratio = (high[i] - low[i]) / volume[i];
      o[i] = ratio === 0 ? 0 : mid / ratio;
    }
    return o;
  }
  /* vosc: 100*(EMAvol(s) - EMAvol(l))/EMAvol(l). Prov: Tulip ti_vosc.c.
   * Defaults {short:5, long:10} (tulind README example uses 5/10). */
  function vosc(volume, opts) {
    var n = _arr(volume, "volume"); opts = opts || {};
    var s = _per(opts.short, 5, 1), l = _per(opts.long, 10, 1);
    var o = _out(n), es = _ema(volume, s), el = _ema(volume, l), i;
    for (i = 0; i < n; i++) {
      if (!_ok(es[i]) || !_ok(el[i]) || el[i] === 0) continue;
      o[i] = 100 * (es[i] - el[i]) / el[i];
    }
    return o;
  }
  /* nvi: accumulate ROC only when volume FALLS. pvi: only when volume RISES.
   * Seed 1000 (Tulip convention). Prov: Tulip ti_nvi.c / ti_pvi.c. */
  function nvi(closes, volume) {
    var n = _arr(closes, "closes"); _arr(volume, "volume");
    var o = _out(n), v = 1000, i;
    for (i = 1; i < n; i++) {
      if (!_ok(closes[i]) || !_ok(closes[i - 1]) || !_ok(volume[i]) || !_ok(volume[i - 1])) continue;
      if (volume[i] < volume[i - 1] && closes[i - 1] !== 0) v = v + (closes[i] - closes[i - 1]) / closes[i - 1] * v;
      o[i] = v;
    }
    return o;
  }
  function pvi(closes, volume) {
    var n = _arr(closes, "closes"); _arr(volume, "volume");
    var o = _out(n), v = 1000, i;
    for (i = 1; i < n; i++) {
      if (!_ok(closes[i]) || !_ok(closes[i - 1]) || !_ok(volume[i]) || !_ok(volume[i - 1])) continue;
      if (volume[i] > volume[i - 1] && closes[i - 1] !== 0) v = v + (closes[i] - closes[i - 1]) / closes[i - 1] * v;
      o[i] = v;
    }
    return o;
  }
  /* wad: Williams accumulation/distribution (true-high/low breakout form).
   * Prov: Tulip ti_wad.c. */
  function wad(high, low, close) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close");
    var o = _out(n), acc = 0, i;
    for (i = 0; i < n; i++) {
      if (!_ok(high[i]) || !_ok(low[i]) || !_ok(close[i])) continue;
      if (i === 0) { o[i] = 0; continue; }
      if (!_ok(high[i - 1]) || !_ok(low[i - 1]) || !_ok(close[i - 1])) continue;
      var th = Math.max(high[i], close[i - 1]), tl = Math.min(low[i], close[i - 1]);
      if (close[i] > close[i - 1]) acc += close[i] - tl;
      else if (close[i] < close[i - 1]) acc -= th - close[i];
      o[i] = acc;
    }
    return o;
  }
  /* ad: Chaikin A/D line (money-flow-volume cumulative). Prov: Tulip ti_ad.c. */
  function ad(high, low, close, volume) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); _arr(volume, "volume");
    var o = _out(n), acc = 0, i;
    for (i = 0; i < n; i++) {
      if (!_ok(high[i]) || !_ok(low[i]) || !_ok(close[i]) || !_ok(volume[i])) continue;
      var mfv = (high[i] === low[i]) ? 0
        : ((close[i] - low[i]) - (high[i] - close[i])) / (high[i] - low[i]) * volume[i];
      acc += mfv;
      o[i] = acc;
    }
    return o;
  }
  /* cvi: Chaikin volatility = 100*ROC(EMA(high-low, n), n).
   * Prov: Tulip ti_cvi.c. Default {period:10}. */
  function cvi(high, low, period) {
    var n = _arr(high, "high"); _arr(low, "low"); period = _per(period, 10, 1);
    var o = _out(n), spread = new Array(n), i;
    for (i = 0; i < n; i++) spread[i] = (_ok(high[i]) && _ok(low[i])) ? high[i] - low[i] : NaN;
    var e = _ema(spread, period);
    for (i = period; i < n; i++) {
      if (!_ok(e[i]) || !_ok(e[i - period]) || e[i - period] === 0) continue;
      o[i] = 100 * (e[i] - e[i - period]) / e[i - period];
    }
    return o;
  }
  /* natr: 100*ATR/close. Prov: Tulip ti_natr.c. */
  function natr(high, low, close, period) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close");
    period = _per(period, 14, 1);
    var o = _out(n), a = _atrArr(high, low, close, period), i;
    for (i = 0; i < n; i++) {
      if (!_ok(a[i]) || !_ok(close[i]) || close[i] === 0) continue;
      o[i] = 100 * a[i] / close[i];
    }
    return o;
  }
  /* mass: Mass Index = 25-bar sum of EMA9((H-L)/EMA9(H-L)). Prov: Tulip ti_mass.c. */
  function mass(high, low) {
    var n = _arr(high, "high"); _arr(low, "low");
    var o = _out(n), ratio = new Array(n), i;
    for (i = 0; i < n; i++) ratio[i] = (_ok(high[i]) && _ok(low[i])) ? high[i] - low[i] : NaN;
    var e9 = _ema(ratio, 9), r2 = new Array(n), j;
    for (j = 0; j < n; j++) r2[j] = (_ok(ratio[j]) && _ok(e9[j]) && e9[j] !== 0) ? ratio[j] / e9[j] : NaN;
    var e9b = _ema(r2, 9);
    for (i = 24; i < n; i++) {
      var s = 0, ok = true;
      for (j = i - 24; j <= i; j++) {
        if (!_ok(e9b[j])) { ok = false; break; }
        s += e9b[j];
      }
      o[i] = ok ? s : null;
    }
    return o;
  }
  /* kvo: EMA(vforce,fast) - EMA(vforce,slow), vforce = V*((C-L)-(H-C))/(H-L).
   * Prov: Tulip ti_kvo.c. Defaults {fast:34, slow:55}. */
  function kvo(high, low, close, volume, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); _arr(volume, "volume");
    opts = opts || {};
    var f = _per(opts.fast, 34, 1), s = _per(opts.slow, 55, 1);
    var o = _out(n), vf = new Array(n), i;
    for (i = 0; i < n; i++) {
      if (!_ok(high[i]) || !_ok(low[i]) || !_ok(close[i]) || !_ok(volume[i])) { vf[i] = NaN; continue; }
      vf[i] = (high[i] === low[i]) ? 0
        : volume[i] * ((close[i] - low[i]) - (high[i] - close[i])) / (high[i] - low[i]);
    }
    var ef = _ema(vf, f), es = _ema(vf, s);
    for (i = 0; i < n; i++) {
      if (!_ok(ef[i]) || !_ok(es[i])) continue;
      o[i] = ef[i] - es[i];
    }
    return o;
  }
  /* adosc: EMA(AD,fast) - EMA(AD,slow). Prov: Tulip ti_adosc.c. */
  function adosc(high, low, close, volume, opts) {
    var n = _arr(high, "high");
    opts = opts || {};
    var f = _per(opts.fast, 3, 1), s = _per(opts.slow, 10, 1);
    var o = _out(n);
    if (typeof I.ad !== "function") return o;
    var line = I.ad(high, low, close, volume);
    var ef = _ema(line.map(function (v) { return v === null ? NaN : v; }), f);
    var es = _ema(line.map(function (v) { return v === null ? NaN : v; }), s);
    for (var i = 0; i < n; i++) {
      if (!_ok(ef[i]) || !_ok(es[i])) continue;
      o[i] = ef[i] - es[i];
    }
    return o;
  }
  /* dpo: close[i] - SMA at (i - period/2 - 1), integer shift floor(period/2)+1.
   * Prov: Tulip ti_dpo.c. */
  function dpo(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 21, 1);
    var o = _out(n), back = Math.floor(period / 2) + 1, i, j;
    for (i = period - 1 + back; i < n; i++) {
      var ref = i - back, s = 0, ok = true;
      for (j = ref - period + 1; j <= ref; j++) {
        if (!_ok(closes[j])) { ok = false; break; }
        s += closes[j];
      }
      if (!ok || !_ok(closes[i])) continue;
      o[i] = closes[i] - s / period;
    }
    return o;
  }
  /* vhf: |highestClose - lowestClose| / sum|close diffs| over n.
   * Prov: qi.pyx vhf (standard Vertical Horizontal Filter). */
  function vhf(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 28, 1);
    var o = _out(n), i, j;
    for (i = period - 1; i < n; i++) {
      var hh = -Infinity, ll = Infinity, diff = 0, ok = true;
      for (j = i - period + 1; j <= i; j++) {
        if (!_ok(closes[j])) { ok = false; break; }
        if (closes[j] > hh) hh = closes[j];
        if (closes[j] < ll) ll = closes[j];
        if (j > i - period + 1) {
          if (!_ok(closes[j - 1])) { ok = false; break; }
          diff += Math.abs(closes[j] - closes[j - 1]);
        }
      }
      if (!ok) continue;
      o[i] = diff === 0 ? 0 : Math.abs(hh - ll) / diff;
    }
    return o;
  }
  /* volatility: stdev(ln returns, n) * sqrt(n). DOCUMENTED SCALE: Tulip ti_
   * volatility annualizes with the period root — same definition here.
   * Prov: Tulip ti_volatility.c. */
  function volatility(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 14, 1);
    var o = _out(n), i, j;
    for (i = period; i < n; i++) {
      var r = [], ok = true;
      for (j = i - period + 1; j <= i; j++) {
        if (!_ok(closes[j]) || !_ok(closes[j - 1]) || closes[j] <= 0 || closes[j - 1] <= 0) { ok = false; break; }
        r.push(Math.log(closes[j] / closes[j - 1]));
      }
      if (!ok) continue;
      var mean = 0;
      for (j = 0; j < r.length; j++) mean += r[j];
      mean /= r.length;
      var v = 0;
      for (j = 0; j < r.length; j++) v += (r[j] - mean) * (r[j] - mean);
      o[i] = Math.sqrt(v / r.length) * Math.sqrt(period);
    }
    return o;
  }

  I.obv = obv; I.emv = emv; I.vosc = vosc; I.nvi = nvi; I.pvi = pvi;
  I.wad = wad; I.ad = ad; I.cvi = cvi; I.natr = natr; I.mass = mass;
  I.kvo = kvo; I.adosc = adosc; I.dpo = dpo; I.vhf = vhf;
  I.volatility = volatility;
})();

if (typeof globalThis !== "undefined" && globalThis.Indicators && typeof module !== "undefined") { module.exports = globalThis.Indicators; }
