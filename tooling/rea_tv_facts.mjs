// tooling/rea_tv_facts.mjs — REA-inspired factual extraction from TradingView's
// public chart page (layout measurements only: no code copying, no assets).
// Usage: node tooling/rea_tv_facts.mjs [url] [out.png]
// Requires: Playwright chromium (already a devDependency).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const url = process.argv[2] || 'https://www.tradingview.com/chart/?symbol=BITSTAMP%3ABTCUSD&interval=D';
const out = process.argv[3] || 'tooling/shots/tv-real-1920.png';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
// Wait for the chart canvas to exist and carry pixels (not blank).
await page.waitForSelector('canvas', { timeout: 45000 });
await page.waitForTimeout(9000);

const facts = await page.evaluate(() => {
  const cssVars = {};
  for (const sheet of document.styleSheets) {
    let rules = [];
    try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheet
    for (const r of rules) {
      if (r.selectorText === ':root' || r.selectorText === 'html') {
        for (const p of r.style) if (p.startsWith('--tv')) cssVars[p] = r.style.getPropertyValue(p).trim();
      }
    }
  }
  const cs = getComputedStyle(document.body);
  const btn = document.querySelector('[class*=button][class*=toolbar], header button, [role=toolbar] button');
  const probe = (el) => {
    if (!el || typeof el === 'string') el = el ? document.querySelector(el) : null;
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { font: s.fontFamily, size: s.fontSize, color: s.color, bg: s.backgroundColor, w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    title: document.title,
    bodyFont: cs.fontFamily, bodyColor: cs.color, bodyBg: cs.backgroundColor,
    tvVars: cssVars, tvVarCount: Object.keys(cssVars).length,
    canvases: document.querySelectorAll('canvas').length,
    toolbarBtn: btn ? { text: (btn.textContent || btn.getAttribute('aria-label') || '').trim().slice(0, 60), ...probe(btn) } : null,
    fonts: [...new Set([...document.fonts].map(f => f.family))].slice(0, 12),
  };
});

mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out });
await browser.close();
console.log(JSON.stringify(facts, null, 1));
console.log('saved', out);
