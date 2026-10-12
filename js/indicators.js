// js/indicators.js
export function sma(rows, n) { return rows.map((_, i) => i + 1 < n ? null : rows.slice(i + 1 - n, i + 1).reduce((a, r) => a + r.c, 0) / n); }
export function ema(rows, n) { const k = 2 / (n + 1); let e = rows[0]?.c ?? 0; return rows.map((r, i) => { e = i === 0 ? r.c : r.c * k + e * (1 - k); return i + 1 < n ? null : e; }); }
export function rsi(rows, n = 14) {
  let g = 0, l = 0; return rows.map((r, i) => {
    if (i === 0) return null;
    const ch = r.c - rows[i - 1].c; g = (g * (n - 1) + Math.max(0, ch)) / n; l = (l * (n - 1) + Math.max(0, -ch)) / n;
    return i < n ? null : 100 - 100 / (1 + (l === 0 ? 100 : g / l));
  });
}
