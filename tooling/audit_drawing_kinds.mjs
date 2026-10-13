// tooling/audit_drawing_kinds.mjs — place one drawing of EVERY rail tool that
// anchors on the chart and prove it paints. A tool that silently draws nothing
// is worse than a missing one.
//
// Both endpoints are measured as steady states (pointer parked, no pending
// rubber-band), otherwise the preview overlay makes the counts meaningless.
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8787/index.html';
const { ITEM_LIST } = await import('../js/tools.js');

const PLACEABLE = ITEM_LIST.filter((i) => i.anchors > 0);
const FREEFORM = new Set(['brush', 'highlighter']);
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => d.accept('')); // text tools prompt for a caption
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

const box = await page.locator('#overlay').boundingBox();
const at = (fx, fy) => ({ x: Math.round(box.x + box.width * fx), y: Math.round(box.y + box.height * fy) });
// spread anchors across the pane so multi-anchor shapes stay well-formed
const anchorSpots = (n) => Array.from({ length: n }, (_, k) => {
  const fx = 0.28 + (k % 4) * 0.11;
  const fy = 0.28 + Math.floor(k / 4) * 0.14 + (k % 2) * 0.05;
  return at(fx, fy);
});

const inked = () => page.evaluate(() => {
  const c = document.querySelector('#overlay');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n += 1;
  return n;
});
// settle: park the pointer on the toolbar (no crosshair, no pending preview)
const settle = async () => {
  await page.mouse.move(box.x + box.width / 2, box.y - 30);
  await page.waitForTimeout(220);
};

// Wipe the pane through the real Remove menu first: once a translucent fill
// covers the pane, "pixels that became non-transparent" stops responding to a
// new thin line, so every tool has to be measured on a clean canvas.
const clearAll = async () => {
  const chev = page.locator('#rail .rail-chev[data-chevron="remove"]');
  if (await chev.count()) {
    await chev.click();
    await page.waitForTimeout(140);
    const btn = page.locator('#tool-menu button[data-item="removeall"]');
    if (await btn.count()) await btn.click();
  }
  await settle();
};

const blank = [];
for (const item of PLACEABLE) {
  const gid = item.group;
  await clearAll();
  const chev = page.locator(`#rail .rail-chev[data-chevron="${gid}"]`);
  if (item.id === 'icon') {
    // Icons has no menu rows: the glyph opens the emoji picker.
    await page.click('#rail .rail-btn[data-group-id="icons"]');
    await page.waitForTimeout(160);
    await page.locator('#emoji-picker button').first().click();
  } else if (await chev.count()) {
    await chev.click();
    await page.waitForTimeout(140);
    const btn = page.locator(`#tool-menu button[data-item="${item.id}"]`);
    if (!(await btn.count())) { check(`${item.id}: menu item`, false); continue; }
    await btn.click();
  } else {
    await page.evaluate((id) => document.querySelector(`#rail .rail-btn[data-group-id="${id}"]`)?.click(), gid);
  }
  await page.waitForTimeout(80);
  await settle();
  const before = await inked();
  if (FREEFORM.has(item.id)) {
    // freehand tools collect a drag, not discrete clicks
    const [a, b] = anchorSpots(2);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let k = 1; k <= 8; k += 1) {
      await page.mouse.move(a.x + ((b.x - a.x) * k) / 8, a.y + ((b.y - a.y) * k) / 8 + (k % 2 ? 12 : -12));
      await page.waitForTimeout(25);
    }
    await page.mouse.up();
  } else {
    for (const p of anchorSpots(item.anchors)) {
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(80);
    }
  }
  await settle();
  const after = await inked();
  // a caption glyph or a small pin is legitimately a couple of hundred pixels
  const drew = before < 200 && after > 100;
  if (!drew) blank.push(`${item.id}(${item.kind}) ${before}->${after}`);
  check(`${item.id} (${item.kind})`, drew, drew ? '' : `ink ${before}->${after}`);
}

check('every anchored tool paints', blank.length === 0, blank.join('; '));
check('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

const drawn = await page.evaluate(() => JSON.parse(localStorage.getItem('opentape-layout-v1') || '{}').drawings?.length ?? 0);
console.log(`\nplacements recorded: ${drawn}`);
await browser.close();
console.log(`${fails ? `${fails} FAILURES` : `all ${PLACEABLE.length} drawing tools paint`}`);
process.exit(fails ? 1 : 0);
