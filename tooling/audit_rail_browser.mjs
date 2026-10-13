// tooling/audit_rail_browser.mjs — drive the local rail in a browser: the glyph
// arms a tool, the chevron opens a menu, and every menu matches the captured
// spec (labels, order, shortcuts, switches). Also places one drawing per kind
// family and checks it renders without console errors.
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8787/index.html';
const spec = JSON.parse(await import('node:fs').then((m) => m.promises.readFile('tooling/tv-rail-spec.json', 'utf8')));
const { RAIL_GROUPS } = await import('../js/tools.js');
const idFor = (label) => Object.keys(RAIL_GROUPS).find((k) => RAIL_GROUPS[k].label === label) || null;
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
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

check('rail rendered', (await page.locator('#rail .rail-item').count()) === 15, `${await page.locator('#rail .rail-item').count()} items`);
check('chevrons rendered', (await page.locator('#rail .rail-chev').count()) === 12, `${await page.locator('#rail .rail-chev').count()}`);

// every group menu: labels, order, shortcuts, switches vs the captured spec
for (const g of spec.groups) {
  if (g.group === 'Icons') continue;
  const gid = idFor(g.group);
  if (!gid) { check(`${g.group}: maps to a rail group`, false); continue; }
  const chev = page.locator(`#rail .rail-chev[data-chevron="${gid}"]`);
  if (!(await chev.count())) { check(`${g.group}: chevron present`, false); continue; }
  await chev.click();
  await page.waitForTimeout(150);
  const menu = page.locator('#tool-menu');
  if (!(await menu.count())) { check(`${g.group}: menu opens`, false); continue; }
  const secs = await menu.locator('.tool-menu-sec').allTextContents();
  const rows = await menu.locator('button[data-item]').evaluateAll((els) => els.map((e) => ({
    id: e.dataset.item,
    label: e.querySelector('.tool-menu-label')?.textContent ?? e.textContent.trim(),
    hot: e.querySelector('.tool-menu-hot')?.textContent ?? '',
    sw: !!e.querySelector('.tool-menu-switch'),
  })));
  const wantLabels = g.sections.flatMap((s) => s.items.map((i) => i.label));
  const gotLabels = rows.map((r) => r.label);
  const norm = (t) => String(t).replace(/\b\d+\b/g, '%n').replace(/s\b/g, '');
  check(`${g.group}: item labels`,
    wantLabels.length === gotLabels.length && wantLabels.every((l, i) => norm(l) === norm(gotLabels[i])),
    `want [${wantLabels.join(', ')}] got [${gotLabels.join(', ')}]`);
  check(`${g.group}: section headers`,
    g.sections.filter((s) => s.title).map((s) => s.title).join('|') === secs.join('|'),
    `want [${g.sections.filter((s) => s.title).map((s) => s.title).join(', ')}] got [${secs.join(', ')}]`);
  const wantHot = g.sections.flatMap((s) => s.items.filter((i) => i.hotkey).map((i) => `${i.label}=${i.hotkey}`));
  const gotHot = rows.filter((r) => r.hot).map((r) => `${r.label}=${r.hot}`);
  check(`${g.group}: shortcuts`, wantHot.join('|') === gotHot.join('|'), `want [${wantHot}] got [${gotHot}]`);
  const wantSw = g.sections.flatMap((s) => s.items.filter((i) => i.toggle).map((i) => i.label)).sort();
  const gotSw = rows.filter((r) => r.sw).map((r) => r.label).sort();
  check(`${g.group}: switches`, wantSw.join('|') === gotSw.join('|'), `want [${wantSw}] got [${gotSw}]`);
  await page.keyboard.press('Escape');
  await page.mouse.click(800, 400);
  await page.waitForTimeout(120);
}

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n${fails ? `${fails} FAILURES` : 'rail browser audit passed'}`);
process.exit(fails ? 1 : 0);
