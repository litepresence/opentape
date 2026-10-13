// tooling/audit_drawings.mjs — every rail drawing tool is real: place, select,
// move, edit an anchor, delete, and survive a reload. Uses the ?debug hook.
// Usage: node tooling/audit_drawings.mjs [baseUrl]
import { chromium } from 'playwright';

const base = (process.argv[2] || 'http://localhost:8787/').replace(/\/$/, '');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', d => d.accept('A'));
await page.goto(base + '/index.html?debug', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && window.__tv.rows().length > 0, null, { timeout: 30000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && window.__tv.rows().length > 0, null, { timeout: 30000 });
await page.waitForTimeout(800);

const fails = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!cond) fails.push(name);
};
const drawings = () => page.evaluate(() => (window.__tv.view.get().drawings || []).map(d => ({ id: d.id, type: d.type, n: (d.points || []).length })));
const tool = () => page.evaluate(() => window.__tv.view.get().tool || 'cross');
const box = await page.locator('#overlay').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const clickAt = async (x, y) => { await page.mouse.click(x, y); await page.waitForTimeout(220); };
const selectTool = async (t) => { await page.click(`#rail button[data-tool="${t}"]`); await page.waitForTimeout(150); };

// --- placement per tool ---
await selectTool('trend');
await clickAt(cx - 200, cy - 60); await clickAt(cx + 200, cy + 60);
let ds = await drawings();
check('trend places 2 anchors', ds.filter(d => d.type === 'trend' && d.n === 2).length === 1, JSON.stringify(ds));

// body drag in isolation (trend is the only drawing at this point)
await page.keyboard.press('Escape');
const beforeMove = await page.evaluate(() => JSON.stringify(window.__tv.view.get().drawings.find(d => d.type === 'trend').points));
await page.mouse.move(cx, cy); await page.mouse.down();
await page.mouse.move(cx + 60, cy + 30, { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(250);
const afterMove = await page.evaluate(() => JSON.stringify(window.__tv.view.get().drawings.find(d => d.type === 'trend').points));
check('drawing body drags', beforeMove !== afterMove);
check('drawing selected on click', !!(await page.evaluate(() => window.__tv.view.get().selectedId)));
await page.keyboard.press('Escape');

// anchor edit in isolation (the trend is still the only drawing)
const ap = await page.evaluate(() => {
  const v = window.__tv.view.get();
  const c = document.querySelector('#overlay');
  const sliced = window.__tv.rows().filter(r => r.t >= v.visible.from && r.t <= v.visible.to);
  const d = v.drawings[0];
  const step = c.width / sliced.length;
  const i = sliced.findIndex(r => r.t >= d.points[0].t);
  const x = i * step + step / 2;
  const y = (1 - (d.points[0].p - v.price.min) / (v.price.max - v.price.min)) * c.height;
  const r = c.getBoundingClientRect();
  return { x: r.left + x * (r.width / c.width), y: r.top + y * (r.height / c.height) };
});
await page.mouse.click(cx, cy);                       // re-select it
await page.waitForTimeout(200);
const p0 = await page.evaluate(() => JSON.stringify(window.__tv.view.get().drawings[0].points[0]));
await page.mouse.move(ap.x, ap.y); await page.mouse.down();
await page.mouse.move(ap.x + 40, ap.y + 30, { steps: 5 }); await page.mouse.up();
await page.waitForTimeout(250);
const p1 = await page.evaluate(() => JSON.stringify(window.__tv.view.get().drawings[0].points[0]));
check('anchor handle drags', p0 !== p1, `${p0} -> ${p1}`);
await page.keyboard.press('Escape');

await selectTool('fib');
await clickAt(cx - 180, cy + 40); await clickAt(cx + 180, cy - 80);
ds = await drawings();
check('fib places 2 anchors', ds.filter(d => d.type === 'fib' && d.n === 2).length === 1);

await page.click('#rail button[data-tool="shape"]');
await page.click('#shape-menu button:has-text("Horizontal line")');
await clickAt(cx, cy - 120);
ds = await drawings();
check('horizontal places 1 anchor', ds.filter(d => d.type === 'horizontal' && d.n === 1).length === 1);

await selectTool('prediction');
await clickAt(cx - 100, cy + 90); await clickAt(cx + 60, cy + 20);
ds = await drawings();
check('prediction places 2 anchors', ds.filter(d => d.type === 'prediction' && d.n === 2).length === 1);

await selectTool('text');
await clickAt(cx + 60, cy - 120);
ds = await drawings();
check('text places', ds.filter(d => d.type === 'text' && d.n === 1).length === 1);

await selectTool('icon');
await clickAt(cx + 120, cy - 120);
ds = await drawings();
check('icon places', ds.filter(d => d.type === 'icon' && d.n === 1).length === 1);

await selectTool('xabcd');
for (let i = 0; i < 5; i++) await clickAt(cx - 200 + i * 90, cy + (i % 2 ? -70 : 70));
ds = await drawings();
check('xabcd places 5 anchors', ds.filter(d => d.type === 'xabcd' && d.n === 5).length === 1, JSON.stringify(ds.filter(d => d.type === 'xabcd')));

// shape submenu → rectangle + ellipse
await page.click('#rail button[data-tool="shape"]');
await page.waitForTimeout(200);
check('shape submenu opens', await page.locator('#shape-menu button').count() === 5);
await page.click('#shape-menu button:has-text("Rectangle")');
await clickAt(cx - 150, cy - 150); await clickAt(cx + 150, cy + 20);
ds = await drawings();
check('rect places 2 anchors', ds.filter(d => d.type === 'rect' && d.n === 2).length === 1);
await page.click('#rail button[data-tool="shape"]');
await page.click('#shape-menu button:has-text("Ellipse")');
await clickAt(cx + 200, cy - 120); await clickAt(cx + 340, cy + 40);
ds = await drawings();
check('ellipse places 2 anchors', ds.filter(d => d.type === 'ellipse' && d.n === 2).length === 1);

// freehand brush: mousedown + moves + up
await selectTool('brush');
await page.mouse.move(cx - 100, cy);
await page.mouse.down();
for (let i = 0; i < 8; i++) await page.mouse.move(cx - 100 + i * 25, cy + Math.sin(i) * 40);
await page.mouse.up();
await page.waitForTimeout(250);
ds = await drawings();
const brush = ds.find(d => d.type === 'brush');
check('brush is freehand (many points, not 2)', brush && brush.n >= 5, JSON.stringify(brush));

// --- selection, move, anchor edit, delete ---
const selected = await page.evaluate(() => window.__tv.view.get().selectedId);
check('drawing selected on click', !!selected);

const countBefore = (await drawings()).length;
await page.keyboard.press('Delete');
await page.waitForTimeout(200);
const countAfter = (await drawings()).length;
check('Delete removes selection', countAfter === countBefore - 1, `${countBefore}->${countAfter}`);

// --- stay in drawing mode ---
await page.keyboard.press('Escape');
await page.click('#rail button[data-tool="stay"]');   // turn OFF
await page.click('#rail button[data-tool="shape"]');
await page.click('#shape-menu button:has-text("Horizontal line")');
await clickAt(cx, cy + 200);
check('stay off returns to cross after placement', (await tool()) === 'cross', await tool());
await page.click('#rail button[data-tool="stay"]');   // back ON
await page.click('#rail button[data-tool="shape"]');
await page.click('#shape-menu button:has-text("Horizontal line")');
await clickAt(cx, cy + 240);
check('stay on keeps tool after placement', (await tool()) === 'horizontal', await tool());
await page.keyboard.press('Escape');

// --- persistence across reload ---
const saved = await drawings();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tv && window.__tv.rows().length > 0, null, { timeout: 30000 });
await page.waitForTimeout(800);
const restored = await drawings();
check('drawings persist across reload', restored.length === saved.length, `${saved.length}->${restored.length}`);
check('types survive reload', JSON.stringify(restored.map(d => d.type).sort()) === JSON.stringify(saved.map(d => d.type).sort()));

// --- hardening: a malformed record must not freeze the chart ---
await page.evaluate(() => {
  const v = window.__tv.view;
  v.set({ drawings: [...v.get().drawings, { id: 'bad1', type: 'trend', points: [{ t: 1, p: 2 }] }] });
});
await page.waitForTimeout(300);
const beforeEvents = errors.length;
await page.mouse.move(cx, cy);            // hover must still work
await page.waitForTimeout(200);
await page.mouse.move(cx + 40, cy + 20);
await page.mouse.down(); await page.mouse.move(cx - 120, cy + 60, { steps: 5 }); await page.mouse.up();
await page.waitForTimeout(300);
check('malformed drawing causes no page errors', errors.length === beforeEvents, JSON.stringify(errors.slice(beforeEvents)));
const stillWorks = await page.evaluate(() => /^O \d/.test(document.querySelector('#ohlc')?.textContent || ''));
check('crosshair/pan survive a malformed drawing', stillWorks);

// --- body drag must track the cursor exactly (no cumulative drift) ---
// Run on a fresh page: the measurement must not depend on what else is drawn.
{
  const p2 = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await p2.goto(base + '/index.html?debug', { waitUntil: 'networkidle' });
  await p2.waitForFunction(() => window.__tv && window.__tv.rows().length > 0, null, { timeout: 30000 });
  await p2.evaluate(() => localStorage.clear());
  await p2.reload({ waitUntil: 'networkidle' });
  await p2.waitForFunction(() => window.__tv && window.__tv.rows().length > 0, null, { timeout: 30000 });
  await p2.waitForTimeout(800);
  // magnet off so the price axis can't snap the anchor away from the cursor
  await p2.click('#rail button[data-tool="magnet"]');
  const b2 = await p2.locator('#overlay').boundingBox();
  const x2 = b2.x + b2.width / 2, y2 = b2.y + b2.height / 2;
  await p2.click('#rail button[data-tool="trend"]');
  await p2.mouse.click(x2 - 250, y2 - 100); await p2.waitForTimeout(200);
  await p2.mouse.click(x2 + 50, y2 - 20); await p2.waitForTimeout(300);
  await p2.keyboard.press('Escape');
  const pt = await p2.evaluate(() => {
    const v = window.__tv.view.get(); const d = v.drawings[v.drawings.length - 1];
    const sliced = window.__tv.rows().filter(r => r.t >= v.visible.from && r.t <= v.visible.to);
    const c = document.querySelector('#overlay');
    const step = c.width / sliced.length;
    const xFor = (t) => {
      const n = sliced.length;
      if (t <= sliced[0].t) return step / 2;
      if (t >= sliced[n - 1].t) return (n - 1) * step + step / 2;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sliced[m].t <= t) lo = m; else hi = m; }
      const t0 = sliced[lo].t, t1 = sliced[hi].t;
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return (lo + f) * step + step / 2;
    };
    const yFor = (pr) => (1 - (pr - v.price.min) / (v.price.max - v.price.min)) * c.height;
    const r = c.getBoundingClientRect();
    const scale = r.width / c.width;
    return {
      grab: { x: r.left + xFor((d.points[0].t + d.points[1].t) / 2) * scale, y: r.top + yFor((d.points[0].p + d.points[1].p) / 2) * (r.height / c.height) },
      start: { x: xFor(d.points[0].t), y: yFor(d.points[0].p) },
    };
  });
  await p2.mouse.move(pt.grab.x, pt.grab.y); await p2.mouse.down();
  for (let i = 1; i <= 12; i++) await p2.mouse.move(pt.grab.x - i * 12, pt.grab.y + i * 4);
  await p2.mouse.up();
  await p2.waitForTimeout(300);
  const end = await p2.evaluate(() => {
    const v = window.__tv.view.get(); const d = v.drawings[v.drawings.length - 1];
    const sliced = window.__tv.rows().filter(r => r.t >= v.visible.from && r.t <= v.visible.to);
    const c = document.querySelector('#overlay');
    const step = c.width / sliced.length;
    const xFor = (t) => {
      const n = sliced.length;
      if (t <= sliced[0].t) return step / 2;
      if (t >= sliced[n - 1].t) return (n - 1) * step + step / 2;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sliced[m].t <= t) lo = m; else hi = m; }
      const t0 = sliced[lo].t, t1 = sliced[hi].t;
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return (lo + f) * step + step / 2;
    };
    return { x: xFor(d.points[0].t), y: (1 - (d.points[0].p - v.price.min) / (v.price.max - v.price.min)) * c.height };
  });
  const dx = end.x - pt.start.x, dy = end.y - pt.start.y;
  check('body drag tracks the cursor (no cumulative drift)', Math.abs(dx + 144) < 8 && Math.abs(dy - 48) < 8,
    `anchor moved ${dx.toFixed(1)},${dy.toFixed(1)} px; pointer moved -144,+48`);
  await p2.close();
}

console.log('ERRORS:', JSON.stringify(errors));
if (errors.length) fails.push('console-errors');
await browser.close();
if (fails.length) { console.error('FAILED:', fails.join(', ')); process.exit(1); }
console.log('drawings audit ok');