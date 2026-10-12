// tooling/gen-fallback.mjs — run once: node tooling/gen-fallback.mjs
import { writeFileSync } from 'node:fs';
const day = 86400000; let t = Date.UTC(2026, 4, 1); let p = 75500;
const rows = [];
for (let i = 0; i < 160; i++) {
  let drift = 0, vol = 0.6 + Math.random() * 0.8;
  if (i < 25) drift = 200 + Math.random() * 400;                    // May climb to ~82k
  else if (i < 32) { drift = -300; vol = 1.5; }                     // late-May fade
  else if (i < 38) { drift = -2500 - Math.random() * 2000; vol = 3 + Math.random() * 3; } // Jun crash to ~64k
  else if (i < 55) drift = (Math.random() - 0.45) * 900;            // Jun chop 60-66k
  else if (i === 60) { drift = -2500; vol = 2.5; }                  // Jul 1 low
  else if (i < 95) drift = (Math.random() - 0.42) * 700;            // 62-66k range
  else if (i < 105) { drift = 1800 + Math.random() * 1200; vol = 2 + Math.random() * 2; } // Aug 20 breakout
  else if (i < 135) drift = (Math.random() - 0.48) * 900;           // 76-86k high chop
  else drift = (82473 - p) / (160 - i) + (Math.random() - 0.5) * 500; // glide to 82473
  const o = p, c = Math.max(50000, o + drift);
  const h = Math.max(o, c) + Math.random() * 350, l = Math.min(o, c) - Math.random() * 350;
  if (i === 159) { const k = 82473 / c; rows.push({ t, o: o * k, h: h * k, l: l * k, c: 82473, v: 1.32 }); break; }
  rows.push({ t, o: +o.toFixed(0), h: +h.toFixed(0), l: +l.toFixed(0), c: +c.toFixed(0), v: +vol.toFixed(2) });
  p = c; t += day;
}
writeFileSync('data/btcusd-1d.json', JSON.stringify(rows));
console.log('wrote', rows.length, 'rows last=', rows.at(-1));
