// tooling/verify_studies_modal.mjs — Task 2: modular modal + unlimited drawings.
// GREEN requires: 3 SMA instances (10/20/50, distinct colors) render (active
// cards === 3 + persisted studies), 3 horizontals + 2 trends placed without
// reselecting, Escape returns to cross, zero pageerrors.
import { chromium } from 'playwright';
import { pickTool, openMenu, clickGlyph } from './rail_helpers.mjs';
import { mkdirSync } from 'node:fs';
mkdirSync('tooling/shots', { recursive: true });
const target = process.argv[2] || 'http://localhost:8787/';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(target, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#ohlc')?.textContent?.includes('O '), null, { timeout: 15000 });

  // --- Modal: open, add 3 SMA instances ---
  await page.click('#ind-btn');
  await page.waitForSelector('#ind-dialog[open]', { timeout: 10000 });
  await page.waitForSelector('#ind-groups [data-study-row]', { timeout: 10000 });
  // Task-7 checkboxes must be gone.
  const legacyBoxes = await page.locator('#ind-dialog input[data-ind]').count();
  if (legacyBoxes !== 0) throw new Error(`Task-7 checkboxes still present (${legacyBoxes})`);

  const addSma = page.locator('#ind-groups button[data-add="sma"]');
  await addSma.waitFor({ timeout: 10000 });
  await addSma.click();
  await addSma.click();
  await addSma.click();
  await page.waitForFunction(
    () => document.querySelectorAll('#ind-active-list .ind-card').length === 3,
    null, { timeout: 10000 });
  console.log('active cards === 3');

  // Set periods 10/20/50 via per-param number inputs.
  const periodInputs = page.locator('#ind-active-list .ind-card input[data-param="period"]');
  if ((await periodInputs.count()) !== 3) throw new Error('expected 3 period inputs');
  for (const [i, period] of [10, 20, 50].entries()) {
    await periodInputs.nth(i).fill(String(period));
    await periodInputs.nth(i).dispatchEvent('change');
  }
  await page.waitForTimeout(300);

  // Distinct colors via color inputs (set value + fire input/change).
  const colorInputs = page.locator('#ind-active-list .ind-card input[data-color]');
  if ((await colorInputs.count()) !== 3) throw new Error('expected 3 color inputs');
  const colors = ['#ff0000', '#00ff00', '#0000ff'];
  for (const [i, c] of colors.entries()) {
    await colorInputs.nth(i).evaluate((el, val) => {
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, c);
  }
  await page.waitForTimeout(500);

  // Browse badge shows 3 for sma.
  const badge = await page.locator('#ind-groups [data-study-row="sma"] [data-count]').first().textContent();
  if (!String(badge || '').includes('3')) throw new Error(`sma badge expected 3, got ${badge}`);

  // Persisted studies: 3 sma instances with periods + colors.
  const persisted = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('opentape-layout-v1') || localStorage.getItem('tv-clone-layout-v1') || 'null'); }
    catch { return null; }
  });
  const studies = persisted && persisted.studies;
  if (!Array.isArray(studies) || studies.length < 3) throw new Error('persisted studies missing 3 instances');
  const smaPeriods = studies.filter((s) => s && s.id === 'sma').map((s) => s.params && s.params.period).sort((a, b) => a - b);
  if (JSON.stringify(smaPeriods.slice(-3)) !== JSON.stringify([10, 20, 50])) {
    throw new Error('persisted sma periods mismatch: ' + JSON.stringify(smaPeriods));
  }
  console.log('3 SMA instances (10/20/50, distinct colors) persisted');

  // Assert 3 lines actually render in distinct colors on the base canvas.
  const hits = await page.evaluate(() => {
    const cv = document.querySelector('#base');
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const targets = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
    const found = [false, false, false];
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const t = targets[k];
        if (Math.abs(d[i] - t[0]) < 12 && Math.abs(d[i + 1] - t[1]) < 12 && Math.abs(d[i + 2] - t[2]) < 12) found[k] = true;
      }
      if (found.every(Boolean)) break;
    }
    return found;
  });
  if (!hits.every(Boolean)) throw new Error('expected 3 SMA lines in distinct colors, got ' + JSON.stringify(hits));
  console.log('3 SMA lines render in distinct colors');

  await page.screenshot({ path: 'tooling/shots/studies-modal-dialog.png' });
  // Close modal.
  await page.click('#ind-dialog button[value="close"]');
  await page.waitForTimeout(400);

  // --- Drawings: unlimited placement without reselecting ---
  const drawingsCount = () => page.evaluate(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('opentape-layout-v1') || localStorage.getItem('tv-clone-layout-v1') || 'null');
      return (raw && raw.drawings && raw.drawings.length) || 0;
    } catch { return 0; }
  });
  const overlayBox = await page.locator('#overlay').boundingBox();
  if (!overlayBox) throw new Error('no overlay box');
  const clickOverlay = async (fx, fy) => {
    await page.mouse.click(overlayBox.x + overlayBox.width * fx, overlayBox.y + overlayBox.height * fy);
    await page.waitForTimeout(150);
  };

  const beforeH = await drawingsCount();
  await pickTool(page, 'horizontal');
  // One tool selection, three placements (no reselect).
  await clickOverlay(0.3, 0.3);
  await clickOverlay(0.5, 0.5);
  await clickOverlay(0.7, 0.4);
  const afterH = await drawingsCount();
  if (afterH - beforeH !== 3) throw new Error(`expected +3 horizontals, got +${afterH - beforeH}`);
  // Tool must still be selected (unlimited-placement guarantee). The rail
  // highlights the group that OWNS the armed tool — horizontal line lives in
  // "Trend tools", so that glyph carries the active state.
  const hActive = await page.locator('#rail .rail-btn[data-group-id="lines"].active').count();
  if (hActive !== 1) throw new Error('horizontal tool did not stay selected across placements');
  console.log('3 horizontals placed without reselecting');

  const beforeT = await drawingsCount();
  await clickGlyph(page, 'lines');
  // Two trends = 4 clicks (anchor + endpoint each), single tool selection.
  await clickOverlay(0.25, 0.6);
  await clickOverlay(0.4, 0.4);
  await clickOverlay(0.55, 0.55);
  await clickOverlay(0.75, 0.35);
  const afterT = await drawingsCount();
  if (afterT - beforeT !== 2) throw new Error(`expected +2 trends, got +${afterT - beforeT}`);
  const tActive = await page.locator('#rail .rail-btn[data-group-id="lines"].active').count();
  if (tActive !== 1) throw new Error('trend tool did not stay selected across placements');
  console.log('2 trends placed without reselecting');

  // --- Escape returns to cross ---
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const crossActive = await page.locator('#rail .rail-btn[data-group-id="cursors"].active').count();
  if (crossActive !== 1) throw new Error('Escape did not return to cross tool');
  console.log('Escape returns to cross');

  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tooling/shots/studies-modal-1920.png' });
  // --- color regressions (fresh debug page; needs the __tv hook) ---
  {
    const target = (process.argv[2] || 'http://localhost:8787/').replace(/\/$/, '');
    const cp = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const cpErrors = [];
    cp.on('pageerror', e => cpErrors.push(String(e)));
    await cp.goto(target + '/index.html?debug', { waitUntil: 'networkidle' });
    await cp.waitForFunction(() => window.__tv && window.__tv.rows().length > 0, null, { timeout: 30000 });
    await cp.waitForTimeout(700);
    // auto palette must vary per instance (regression: SMA mesh was all blue)
    await cp.evaluate(() => {
      window.__tv.view.set({ studies: [
        { uid: 'm1', id: 'sma', params: { period: 10 }, color: null, visible: true },
        { uid: 'm2', id: 'sma', params: { period: 20 }, color: null, visible: true },
        { uid: 'm3', id: 'sma', params: { period: 50 }, color: null, visible: true },
      ] });
    });
    await cp.waitForTimeout(700);
    const mesh = await cp.evaluate(() => {
      const c = document.querySelector('#base');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const near = (r, g, b) => { let n = 0; for (let i = 0; i < d.length; i += 4) { if (d[i+3] < 200) continue; if (Math.abs(d[i]-r) < 26 && Math.abs(d[i+1]-g) < 26 && Math.abs(d[i+2]-b) < 26) n++; } return n; };
      return { blue: near(0x29, 0x62, 0xFF), orange: near(0xFF, 0x6D, 0x00), purple: near(0x9C, 0x27, 0xB0) };
    });
    const distinct = [mesh.blue, mesh.orange, mesh.purple].filter((n) => n > 500).length;
    if (distinct < 2) { console.error('MESH COLORS FAIL', JSON.stringify(mesh)); await cp.close(); process.exit(1); }
    console.log(`auto palette across 3 SMA instances: ${JSON.stringify(mesh)}`);
    // an explicit color must actually paint
    await cp.evaluate(() => {
      window.__tv.view.set({ studies: [{ uid: 'c1', id: 'sma', params: { period: 20 }, color: '#ff0000', visible: true }] });
    });
    await cp.waitForTimeout(600);
    const red = await cp.evaluate(() => {
      const c = document.querySelector('#base');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) { if (d[i+3] < 200) continue; if (d[i] > 200 && d[i+1] < 70 && d[i+2] < 70) n++; }
      return n;
    });
    if (red < 500) { console.error('EXPLICIT COLOR FAIL, red px =', red); await cp.close(); process.exit(1); }
    console.log('explicit #ff0000 instance painted', red, 'red px');
    if (cpErrors.length) { console.error('color page errors', cpErrors); await cp.close(); process.exit(1); }
    await cp.close();
  }

  if (errors.length) { console.error('PAGE ERRORS', errors); process.exit(1); }
  console.log('modal verify ok, no page errors');
} finally {
  await browser.close();
}
