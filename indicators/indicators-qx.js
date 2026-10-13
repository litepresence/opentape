/* Indicators-QX: QTradeX custom (beyond-Tulip) math, dependency-free.
 * Owns: vortex, kst, zigzag, ravi, aema, tsi, smi, eri, awesome, supertrend,
 *   arsi, keltner, donchian, ulcer, earsi, holtwinters, kagi — the qi.pyx
 *   add-on suite (transcribed formulas, never copied runtime). Attaches onto
 *   shared global Indicators. Inputs: clean number arrays; null/NaN in a
 *   window yields null. No DOM/chain/money.
 * Prov: QTradeX-Algo-Trading-SDK qtradex/indicators/qi.pyx (per-fn lines
 *   cited; upstream master 2026-09-28). Warmup = nulls, same-length outputs.
 * Deferred honestly (not chart series): tick_indicator/trin/market_profile/
 *   price_action (need tick/up-down-volume infra), typed_macd/typed_bbands
 *   (same math as macd/bbands), candle patterns (separate marker feature).
 * Created by: building-vanilla-slices skill, indicator-parity plan. */
(function () {
  "use strict";

  var I = (typeof globalThis !== "undefined") ? globalThis.Indicators : undefined;
  if (typeof I === "undefined" && typeof Indicators !== "undefined") I = Indicators;
  if (!I) throw new Error("indicators-qx.js requires indicators.js first");

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
  function _sma(a, from, to) {
    var s = 0;
    for (var i = from; i <= to; i++) {
      if (!_ok(a[i])) return null;
      s += a[i];
    }
    return s / (to - from + 1);
  }
  function _emaArr(a, n) {
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
  function _roc(a, n) {
    var o = _out(a.length), i;
    for (i = n; i < a.length; i++) {
      if (!_ok(a[i]) || !_ok(a[i - n]) || a[i - n] === 0) continue;
      o[i] = (a[i] - a[i - n]) / a[i - n];
    }
    return o;
  }

  /* vortex: +VI/-VI over true-range sums (qi.pyx:155). Returns {plus, minus}.
   * First-bar fill uses the window mean (upstream convention, documented). */
  function vortex(high, low, close, period) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close");
    period = _per(period, 14, 1);
    var plus = _out(n), minus = _out(n), i, j;
    if (n <= period) return { plus: plus, minus: minus };
    var mean = 0, cnt = 0;
    for (i = 0; i < n; i++) if (_ok(close[i])) { mean += close[i]; cnt++; }
    mean = cnt ? mean / cnt : 0;
    for (i = period; i < n; i++) {
      var tr = 0, vp = 0, vm = 0, ok = true;
      for (j = i - period + 1; j <= i; j++) {
        if (!_ok(high[j]) || !_ok(low[j]) || !_ok(close[j])) { ok = false; break; }
        var pc = (j === 0) ? mean : close[j - 1];
        if (!_ok(pc)) { ok = false; break; }
        tr += Math.max(high[j] - low[j], Math.abs(high[j] - pc), Math.abs(low[j] - pc));
        var pl = (j === 0) ? low[0] : low[j - 1], ph = (j === 0) ? high[0] : high[j - 1];
        if (!_ok(pl) || !_ok(ph)) { ok = false; break; }
        vp += Math.abs(high[j] - pl);
        vm += Math.abs(low[j] - ph);
      }
      if (!ok || tr === 0) continue;
      plus[i] = vp / tr; minus[i] = vm / tr;
    }
    return { plus: plus, minus: minus };
  }
  /* kst: weighted ROC sum + SMA signal (qi.pyx:206). Defaults
   * {r1:10, r2:15, r3:20, r4:30, sig:9}. Returns {kst, signal}. */
  function kst(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var r1 = _per(opts.r1, 10, 1), r2 = _per(opts.r2, 15, 1);
    var r3 = _per(opts.r3, 20, 1), r4 = _per(opts.r4, 30, 1);
    var sig = _per(opts.sig, 9, 1);
    var k = _out(n), s = _out(n), i;
    var a = _roc(closes, r1), b = _roc(closes, r2), c = _roc(closes, r3), d = _roc(closes, r4);
    for (i = 0; i < n; i++) {
      if (!_ok(a[i]) || !_ok(b[i]) || !_ok(c[i]) || !_ok(d[i])) continue;
      k[i] = a[i] + 2 * b[i] + 3 * c[i] + 4 * d[i];
    }
    for (i = sig - 1; i < n; i++) s[i] = _sma(k, i - sig + 1, i);
    return { kst: k, signal: s };
  }
  /* zigzag: reversal-step + interpolated line (qi.pyx:309). deviation in %.
   * Returns {line, steps}. */
  function zigzag(closes, deviation) {
    var n = _arr(closes, "closes");
    if (deviation === undefined) deviation = 5;
    if (typeof deviation !== "number" || !(deviation > 0)) throw new Error("bad deviation");
    var steps = _out(n), line = _out(n), i;
    if (n === 0 || !_ok(closes[0])) return { line: line, steps: steps };
    var lastEx = closes[0], dir = 0;
    steps[0] = lastEx;
    for (i = 1; i < n; i++) {
      if (!_ok(closes[i])) { steps[i] = steps[i - 1]; continue; }
      var chg = (closes[i] - lastEx) / lastEx * 100;
      if (chg > deviation && dir !== 1) { steps[i] = closes[i]; lastEx = closes[i]; dir = 1; }
      else if (chg < -deviation && dir !== -1) { steps[i] = closes[i]; lastEx = closes[i]; dir = -1; }
      else steps[i] = steps[i - 1];
    }
    var idx = [];
    for (i = 0; i < n; i++) if (steps[i] !== null && (idx.length === 0 || steps[i] !== steps[idx[idx.length - 1]])) idx.push(i);
    for (var k = 0; k + 1 < idx.length; k++) {
      var a = idx[k], b = idx[k + 1], span = b - a;
      for (i = a; i <= b; i++) line[i] = steps[a] + (steps[b] - steps[a]) * (i - a) / span;
    }
    if (idx.length) {
      var last = idx[idx.length - 1];
      for (i = last; i < n; i++) if (line[i] === null) line[i] = steps[last];
    }
    return { line: line, steps: steps };
  }
  /* ravi: 100*(shortRange - longRange)/longRange (qi.pyx:370).
   * Defaults {short:14, long:30}. */
  function ravi(high, low, close, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); opts = opts || {};
    var sp = _per(opts.short, 14, 1), lp = _per(opts.long, 30, 1);
    var o = _out(n), i;
    for (i = lp - 1; i < n; i++) {
      var sh = _sma(high, i - sp + 1, i), sl = _sma(low, i - sp + 1, i);
      var lh = _sma(high, i - lp + 1, i), ll = _sma(low, i - lp + 1, i);
      if (sh === null || sl === null || lh === null || ll === null) continue;
      var denom = lh - ll;
      o[i] = denom === 0 ? 0 : ((sh - sl) - denom) / denom * 100;
    }
    return o;
  }
  /* aema: volatility-adaptive EMA, alpha 0.1 default (qi.pyx:426). */
  function aema(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var period = _per(opts.period, 14, 1);
    var alpha = opts.alpha === undefined ? 0.1 : opts.alpha;
    if (typeof alpha !== "number" || !(alpha > 0) || !(alpha < 1)) throw new Error("bad alpha");
    var o = _out(n), i;
    if (n === 0) return o;
    var seed = 0, cnt = 0;
    for (i = 0; i < Math.min(period, n); i++) {
      if (!_ok(closes[i])) return o;
      seed += closes[i]; cnt++;
    }
    o[0] = seed / cnt;
    for (i = 1; i < n; i++) {
      if (!_ok(closes[i]) || !_ok(closes[i - 1]) || !_ok(o[i - 1])) { o[i] = null; continue; }
      var aa = alpha / (1 + Math.abs(closes[i] - closes[i - 1]));
      o[i] = aa * closes[i] + (1 - aa) * o[i - 1];
    }
    return o;
  }
  /* tsi: double-smoothed momentum/absolute-momentum ratio (qi.pyx:577).
   * Defaults {long:25, short:13}. */
  function tsi(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var lp = _per(opts.long, 25, 1), sp = _per(opts.short, 13, 1);
    var o = _out(n);
    var pc = new Array(n), apc = new Array(n), i;
    for (i = 0; i < n; i++) {
      if (i === 0) { pc[i] = 0; apc[i] = 0; continue; }
      if (!_ok(closes[i]) || !_ok(closes[i - 1])) { pc[i] = NaN; apc[i] = NaN; continue; }
      pc[i] = closes[i] - closes[i - 1]; apc[i] = Math.abs(pc[i]);
    }
    /* Wilder smoothing over possibly-null arrays: skips nulls, seeds on the
     * first p VALID values, then smooths against the running value (nulls
     * neither seed nor advance the average). */
    function wildish(a, p) {
      var r = _out(a.length), acc = 0, cnt = 0, prev = null, i;
      for (i = 0; i < a.length; i++) {
        if (!_ok(a[i])) continue;
        acc += a[i]; cnt++;
        if (cnt < p) continue;
        if (cnt === p) { prev = acc / p; r[i] = prev; continue; }
        prev = (prev * (p - 1) + a[i]) / p;
        r[i] = prev;
      }
      return r;
    }
    var s1 = wildish(pc, sp), s2 = wildish(s1.map(function (v) { return v === null ? NaN : v; }), lp);
    var t1 = wildish(apc, sp), t2 = wildish(t1.map(function (v) { return v === null ? NaN : v; }), lp);
    for (i = 0; i < n; i++) {
      if (!_ok(s2[i]) || !_ok(t2[i]) || t2[i] === 0) continue;
      o[i] = 100 * s2[i] / t2[i];
    }
    return o;
  }
  /* smi: stochastic momentum + SMA signal (qi.pyx:631).
   * Defaults {k:14, d:3}. Returns {smi, signal}. */
  function smi(high, low, close, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); opts = opts || {};
    var kp = _per(opts.k, 14, 1), dp = _per(opts.d, 3, 1);
    var s = _out(n), g = _out(n), i, j;
    for (i = kp - 1; i < n; i++) {
      var hh = -Infinity, ll = Infinity, ok = true;
      for (j = i - kp + 1; j <= i; j++) {
        if (!_ok(high[j]) || !_ok(low[j])) { ok = false; break; }
        if (high[j] > hh) hh = high[j];
        if (low[j] < ll) ll = low[j];
      }
      if (!ok || !_ok(close[i])) continue;
      s[i] = (hh === ll) ? 0 : (close[i] - (hh + ll) / 2) / ((hh - ll) / 2) * 100;
    }
    for (i = dp - 1; i < n; i++) g[i] = _sma(s, i - dp + 1, i);
    return { smi: s, signal: g };
  }
  /* eri: Elder bull/bear power vs EMA (qi.pyx:681, ma_type=EMA documented). */
  function eri(high, low, close, period) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close");
    period = _per(period, 13, 1);
    var bull = _out(n), bear = _out(n), e = _emaArr(close, period), i;
    for (i = 0; i < n; i++) {
      if (!_ok(e[i]) || !_ok(high[i]) || !_ok(low[i])) continue;
      bull[i] = high[i] - e[i]; bear[i] = low[i] - e[i];
    }
    return { bull: bull, bear: bear };
  }
  /* awesome: SMA(median,5) - SMA(median,34) (qi.pyx:735). */
  function awesome(high, low, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); opts = opts || {};
    var sp = _per(opts.short, 5, 1), lp = _per(opts.long, 34, 1);
    var o = _out(n), i;
    var med = new Array(n);
    for (i = 0; i < n; i++) med[i] = (_ok(high[i]) && _ok(low[i])) ? (high[i] + low[i]) / 2 : NaN;
    for (i = lp - 1; i < n; i++) {
      var a = _sma(med, i - sp + 1, i), b = _sma(med, i - lp + 1, i);
      o[i] = (a === null || b === null) ? null : a - b;
    }
    return o;
  }
  /* supertrend: trailing bands + toggle line (qi.pyx:772). Multipliers
   * default {top:3, bottom:3}. Returns {trend, upper, lower}. */
  function supertrend(high, low, close, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); opts = opts || {};
    var period = _per(opts.period, 14, 1);
    var mt = opts.top === undefined ? 3 : opts.top, mb = opts.bottom === undefined ? 3 : opts.bottom;
    var trend = _out(n), up = _out(n), lo = _out(n), i, j;
    if (n <= period) return { trend: trend, upper: up, lower: lo };
    var atr = _atrArr(high, low, close, period);
    var toggle = false, first = true;
    for (i = period; i < n; i++) {
      var th = -Infinity, tl = Infinity, ok = true;
      for (j = i - period; j < i; j++) {
        if (!_ok(high[j]) || !_ok(low[j])) { ok = false; break; }
        if (high[j] > th) th = high[j];
        if (low[j] < tl) tl = low[j];
      }
      if (!ok || !_ok(atr[i]) || !_ok(close[i])) continue;
      var mid = (th + tl) / 2;
      up[i] = mid + mt * atr[i]; lo[i] = mid - mb * atr[i];
      if (first) { toggle = close[i] > lo[i]; first = false; }
      else if (toggle && close[i] < lo[i]) toggle = false;
      else if (!toggle && close[i] > up[i]) toggle = true;
      trend[i] = toggle ? lo[i] : up[i];
    }
    return { trend: trend, upper: up, lower: lo };
  }
  function _atrArr(h, l, c, n) {
    var o = _out(h.length), i, acc = 0, started = false;
    for (i = 0; i < h.length; i++) {
      if (!_ok(h[i]) || !_ok(l[i]) || !_ok(c[i])) continue;
      var t = (i <= 0) ? h[0] - l[0]
        : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
      acc += t;
      if (i < n - 1) continue;
      if (!started) { o[i] = acc / n; started = true; }
      else if (o[i - 1] !== null) o[i] = (o[i - 1] * (n - 1) + t) / n;
    }
    return o;
  }
  /* arsi: RSI-adaptive price smoother (qi.pyx:824). Default {length:14}. */
  function arsi(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 14, 1);
    var o = _out(n);
    if (typeof I.rsi !== "function") return o;
    var r = I.rsi(closes, { period: period }), i;
    for (i = 0; i < n; i++) {
      if (!_ok(r[i]) || !_ok(closes[i])) continue;
      var alpha = 2 * Math.abs(r[i] / 100 - 0.5);
      if (i === 0 || o[i - 1] === null) o[i] = closes[i];
      else o[i] = alpha * closes[i] + (1 - alpha) * o[i - 1];
    }
    return o;
  }
  /* keltner: EMA middle +/- mult*ATR (qi.pyx:859, ma_type=EMA documented).
   * Defaults {atr:20, ema:20, mult:1.5}. Returns {upper, middle, lower}. */
  function keltner(high, low, close, opts) {
    var n = _arr(high, "high"); _arr(low, "low"); _arr(close, "close"); opts = opts || {};
    var ap = _per(opts.atr, 20, 1), ep = _per(opts.ema, 20, 1);
    var mult = opts.mult === undefined ? 1.5 : opts.mult;
    var up = _out(n), mid = _emaArr(close, ep), lo = _out(n);
    var av = _atrArr(high, low, close, ap), i;
    for (i = 0; i < n; i++) {
      if (!_ok(mid[i]) || !_ok(av[i])) continue;
      up[i] = mid[i] + mult * av[i]; lo[i] = mid[i] - mult * av[i];
    }
    return { upper: up, middle: mid, lower: lo };
  }
  /* donchian: highest-high / lowest-low / mid (qi.pyx:910). */
  function donchian(high, low, period) {
    var n = _arr(high, "high"); _arr(low, "low"); period = _per(period, 20, 1);
    var up = _out(n), mid = _out(n), lo = _out(n), i, j;
    for (i = period - 1; i < n; i++) {
      var hh = -Infinity, ll = Infinity, ok = true;
      for (j = i - period + 1; j <= i; j++) {
        if (!_ok(high[j]) || !_ok(low[j])) { ok = false; break; }
        if (high[j] > hh) hh = high[j];
        if (low[j] < ll) ll = low[j];
      }
      if (!ok) continue;
      up[i] = hh; lo[i] = ll; mid[i] = (hh + ll) / 2;
    }
    return { upper: up, middle: mid, lower: lo };
  }
  /* ulcer: sqrt(mean(squared % drawdown from running max)) (qi.pyx:1223). */
  function ulcer(closes, period) {
    var n = _arr(closes, "closes"); period = _per(period, 14, 1);
    var o = _out(n), i, j;
    var peak = -Infinity;
    for (i = 0; i < n; i++) {
      if (!_ok(closes[i])) continue;
      if (closes[i] > peak) peak = closes[i];
      if (i < period) continue;
      var s = 0, ok = true, pk = -Infinity;
      for (j = 0; j <= i; j++) {
        if (!_ok(closes[j])) { ok = false; break; }
        if (closes[j] > pk) pk = closes[j];
      }
      if (!ok) continue;
      for (j = i - period + 1; j <= i; j++) {
        var r = 100 * (closes[j] - pk) / pk;
        s += r * r;
      }
      o[i] = Math.sqrt(s / period);
    }
    return o;
  }
  /* earsi: Ehlers adaptive RSI (qi.pyx:1297). Upstream computes a dominant-
   * cycle estimate but its own output stage uses the min-period Wilder
   * averages regardless — this port implements exactly that effective
   * behavior (Wilder RSI over min period), documented, no dead spectral
   * code carried. Defaults {min:10, max:48, avg:3} (max/avg accepted,
   * validated, unused — same as upstream output). */
  function earsi(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var mn = _per(opts.min, 10, 2);
    _per(opts.max === undefined ? mn + 1 : opts.max, mn + 1, mn + 1);
    _per(opts.avg === undefined ? 3 : opts.avg, 1, 1);
    var o = _out(n);
    if (n < mn + 1) return o;
    var ag = 0, al = 0, i, ok = true;
    for (i = 1; i <= mn; i++) {
      if (!_ok(closes[i]) || !_ok(closes[i - 1])) { ok = false; break; }
      var d0 = closes[i] - closes[i - 1];
      if (d0 > 0) ag += d0; else al -= d0;
    }
    if (!ok) return o;
    ag /= mn; al /= mn;
    for (i = mn; i < n; i++) {
      if (i > mn) {
        if (!_ok(closes[i]) || !_ok(closes[i - 1])) continue;
        var d = closes[i] - closes[i - 1];
        ag = (ag * (mn - 1) + (d > 0 ? d : 0)) / mn;
        al = (al * (mn - 1) + (d < 0 ? -d : 0)) / mn;
      }
      if (o[i - 1] === null && i > mn) continue;
      o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return o;
  }
  /* holtwinters: double exponential smoothing + trend (qi.pyx:1181).
   * Defaults {span:10, beta:0.3}. Returns {smooth, trend}. */
  function holtwinters(closes, opts) {
    var n = _arr(closes, "closes"); opts = opts || {};
    var span = _per(opts.span, 10, 1);
    var beta = opts.beta === undefined ? 0.3 : opts.beta;
    if (typeof beta !== "number" || !(beta > 0) || !(beta < 1)) throw new Error("bad beta");
    var s = _out(n), b = _out(n), i;
    if (n === 0 || !_ok(closes[0])) return { smooth: s, trend: b };
    var alpha = 2 / (1 + span), ra = 1 - alpha, rb = 1 - beta;
    s[0] = closes[0]; b[0] = 0;
    for (i = 1; i < n; i++) {
      if (!_ok(closes[i]) || s[i - 1] === null || b[i - 1] === null) continue;
      s[i] = alpha * closes[i] + ra * (s[i - 1] + b[i - 1]);
      b[i] = beta * (s[i] - s[i - 1]) + rb * b[i - 1];
    }
    return { smooth: s, trend: b };
  }
  /* kagi: reversal-line levels (qi.pyx:941). deviation in %. Returns levels. */
  function kagi(closes, deviation) {
    var n = _arr(closes, "closes");
    if (deviation === undefined) deviation = 2;
    if (typeof deviation !== "number" || !(deviation > 0)) throw new Error("bad deviation");
    var o = _out(n), i;
    if (n === 0 || !_ok(closes[0])) return o;
    var fr = deviation / 100, dir = null, last = closes[0];
    o[0] = last;
    for (i = 1; i < n; i++) {
      if (!_ok(closes[i])) { o[i] = o[i - 1]; continue; }
      var up = last * (1 + fr), dn = last * (1 - fr), px = closes[i];
      if (dir === null || (dir === "up" && px < dn) || (dir === "down" && px > up)) {
        dir = (dir === "up") ? "down" : "up";
        o[i] = px; last = px;
      } else if (dir === "up" && px > last) { o[i] = px; last = px; }
      else if (dir === "down" && px < last) { o[i] = px; last = px; }
      else o[i] = o[i - 1];
    }
    return o;
  }

  I.vortex = vortex; I.kst = kst; I.zigzag = zigzag; I.ravi = ravi;
  I.aema = aema; I.tsi = tsi; I.smi = smi; I.eri = eri;
  I.awesome = awesome; I.supertrend = supertrend; I.arsi = arsi;
  I.keltner = keltner; I.donchian = donchian; I.ulcer = ulcer;
  I.earsi = earsi; I.holtwinters = holtwinters; I.kagi = kagi;
})();

if (typeof globalThis !== "undefined" && globalThis.Indicators && typeof module !== "undefined") { module.exports = globalThis.Indicators; }
