// tooling/tv_menu_capture.mjs — capture the ORIGINAL sidebar group menus.
//
// Facts only, for clean-room measurement. What the probing established:
//  * A signup interstitial (div.modal-*/wrap-*/backdrop-*, fixed, full viewport)
//    covers the chart and swallows every click. It has no close control, so we
//    detach its wrapper before measuring.
//  * Each rail icon has a chevron button (aria-label = group name, 11x34, at the
//    icon's right edge). The icon body arms a tool (anonymous sessions hit a
//    paywall); the chevron opens the tool menu.
//  * Menus are icon grids with section headers; item names live in tooltips /
//    aria-labels, so we read both plus a screenshot per group.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const endpoint = process.argv[2] || 'http://127.0.0.1:9333';
const url = process.argv[3] || 'https://www.tradingview.com/chart/?symbol=BITSTAMP%3ABTCUSD';
const filter = process.argv[4] || ''; // optional substring filter on the group name
const browser = await chromium.connectOverCDP(endpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('tradingview.com')) || (await ctx.newPage());
await page.setViewportSize({ width: 1920, height: 950 }).catch(() => {});
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

const unblock = () =>
  page.evaluate(() => {
    let n = 0;
    for (const sel of [
      'div[class*="modal-RnsOUUv3"]',
      'div[class*="backdrop-RnsOUUv3"]',
      'div[class*="wrap-RnsOUUv3"]',
      'div[class*="container-RnsOUUv3"]',
    ]) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width > 400 && r.height > 400) { el.remove(); n += 1; }
      }
    }
    return n;
  });

const dismissCoach = () =>
  page.evaluate(() => {
    let n = 0;
    for (const b of document.querySelectorAll('button')) {
      if (/got it/i.test(b.textContent || '') && b.getBoundingClientRect().width > 10) { b.click(); n += 1; }
    }
    return n;
  });

console.log('detached interstitials:', await unblock());
await dismissCoach();

// icon -> chevron pairing, straight from the live DOM
const icons = await page.evaluate(() => {
  const out = [];
  for (const b of document.querySelectorAll('button[aria-label]')) {
    const r = b.getBoundingClientRect();
    if (r.left > 70 || r.width < 40 || r.width > 60) continue;
    const ctrl = b.closest('div[class*="control-"]');
    const pair = [...(ctrl?.querySelectorAll('button[aria-label]') || [])];
    if (pair.length !== 2 || pair[0] !== b) continue;
    const cr = pair[1].getBoundingClientRect();
    out.push({
      icon: b.getAttribute('aria-label').slice(0, 46),
      group: pair[1].getAttribute('aria-label').slice(0, 46),
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      cx: Math.round(cr.x + cr.width / 2), cy: Math.round(cr.y + cr.height / 2),
    });
  }
  return out.sort((a, b) => a.y - b.y);
});
console.log('rail groups:', icons.map((i) => `${i.group} <- ${i.icon}`).join(' | '));
const targets = filter ? icons.filter((i) => i.group.toLowerCase().includes(filter.toLowerCase())) : icons;

// Everything to the right of the rail that looks like a menu row / item.
const readMenu = () =>
  page.evaluate(() => {
    const rows = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.left < 56 || r.left > 900) continue;
      if (r.width < 8 || r.height < 8 || r.top < 24 || r.top > 940) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const leaf = el.children.length === 0 ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
      const label = (aria || title || leaf).trim();
      if (!label || label.length > 48) continue;
      rows.push({ label, aria, text: leaf, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName.toLowerCase() });
    }
    return rows;
  });

const report = {};
for (const i of targets) {
  await page.keyboard.press('Escape').catch(() => {});
  await unblock();
  await dismissCoach();
  await page.mouse.move(600, 700);
  await page.waitForTimeout(300);
  await page.mouse.move(i.x, i.y); // hover reveals the chevron
  await page.waitForTimeout(700);
  await page.mouse.move(i.cx, i.cy);
  await page.waitForTimeout(250);
  await page.mouse.click(i.cx, i.cy); // chevron opens the menu
  await page.waitForTimeout(1300);
  const rows = await readMenu();
  const slug = i.group.toLowerCase().replace(/[^a-z]+/g, '-');
  report[i.group] = { icon: i.icon, railY: i.y, rows };
  console.log(`\n===== ${i.group} (icon "${i.icon}") : ${rows.length} labels =====`);
  const seen = new Set();
  for (const r of rows.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const k = `${r.x},${r.y},${r.label}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  ${String(r.x).padStart(4)},${String(r.y).padStart(4)} ${String(r.w).padStart(3)}x${String(r.h).padStart(2)} ${r.tag.padEnd(6)} ${r.label}`);
  }
  await page.screenshot({ path: `tooling/shots/tv-menu-${slug}.png`, clip: { x: 0, y: 24, width: 1000, height: 920 } });
}

writeFileSync(`tooling/tv-menu-capture${filter ? '-' + filter.replace(/[^a-z0-9]+/gi, '-') : ''}.json`, JSON.stringify(report, null, 1));
console.log('\nwrote tooling/tv-menu-capture' + (filter ? '-' + filter : '') + '.json');
await browser.close();
