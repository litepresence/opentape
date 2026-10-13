// tooling/derive_rail_spec.mjs — turn the raw DOM captures into one canonical
// spec of the ORIGINAL left rail. Facts only: group order, section titles,
// item labels and order, hotkeys. Run after tv_menu_capture.mjs.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const files = readdirSync('tooling').filter((f) => /^tv-menu-capture.*\.json$/.test(f));
const merged = {};
for (const f of files) {
  const data = JSON.parse(readFileSync(`tooling/${f}`, 'utf8'));
  for (const [group, v] of Object.entries(data)) {
    if (!merged[group] || v.rows.length > merged[group].rows.length) merged[group] = v;
  }
}

// A rail group is a flyout panel anchored at the rail's right edge: every row
// shares one left edge just right of the rail (x=56..60) and one panel width.
// Selecting on the modal width keeps the panel title chip and the chart legend
// out, whatever vertical offset the panel happens to open at.
const PANEL_MIN_X = 54;
const PANEL_MAX_X = 62;
const inPanelColumn = (r) =>
  r.x >= PANEL_MIN_X && r.x <= PANEL_MAX_X && r.w >= 100 && r.w <= 360 && r.y > 30 && r.y < 905;

// Rows that are switches rather than one-shot tools.
const TOGGLES = new Set([
  'Values tooltip on long press',
  'Snap to indicators',
  'Always remove locked drawings',
  'Stay in drawing mode',
]);

const HOTKEY = /^Alt \+ [A-Z]$/;

const rail = [];
for (const [group, v] of Object.entries(merged).sort((a, b) => (a[1].railY ?? 0) - (b[1].railY ?? 0))) {
  const column = v.rows.filter(inPanelColumn);
  // the panel width is the one shared by the most rows
  const tally = new Map();
  for (const r of column) tally.set(r.w, (tally.get(r.w) || 0) + 1);
  const panelW = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const rows = column.filter((r) => r.w === panelW);
  if (!rows.length) {
    rail.push({ group, icon: v.icon, sections: [], unmapped: 'no panel rows captured' });
    continue;
  }
  // keep the first label per (y, label); nested spans duplicate their parent row
  const uniq = [];
  const seen = new Set();
  for (const r of rows.slice().sort((a, b) => a.y - b.y)) {
    const k = `${r.y}|${r.label}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(r);
  }
  const sections = [];
  let cur = null;
  for (const r of uniq) {
    // h<=26 rows are section headers; they title a section, not an item
    if (r.h <= 26) {
      cur = { title: r.label, items: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) { cur = { title: '', items: [] }; sections.push(cur); }
    // the shortcut chip is a sibling leaf on the same row ("Alt + T")
    const hot = v.rows.find((x) => HOTKEY.test(x.label) && x.y >= r.y - 6 && x.y <= r.y + 26 && x.x > r.x);
    cur.items.push({ label: r.label, hotkey: hot ? hot.label : '', toggle: TOGGLES.has(r.label) });
  }
  rail.push({ group, icon: v.icon, sections: sections.filter((s) => s.items.length) });
}

// The Icons group does not expose DOM labels: it opens an emoji/sticker/icon
// picker (category tabs across the top, Emojis / Stickers / Icons tabs at the
// bottom — see tooling/shots/tv-menu-icons.png). Recorded from that screenshot.
for (const g of rail) {
  if (g.group === 'Icons') g.picker = 'emoji';
}

const spec = {
  source: 'tradingview.com/chart/?symbol=BITSTAMP%3ABTCUSD (anonymous session, 1920x950)',
  capturedBy: 'tooling/tv_menu_capture.mjs',
  note: 'Labels/order only — no code or assets copied. Icons grid renders as an emoji picker.',
  groups: rail,
};
writeFileSync('tooling/tv-rail-spec.json', `${JSON.stringify(spec, null, 1)}\n`);
console.log(`${rail.length} groups, ${rail.reduce((n, g) => n + g.sections.reduce((m, s) => m + s.items.length, 0), 0)} items`);
for (const g of rail) {
  console.log(`\n${g.group}  (rail icon: ${g.icon})`);
  for (const s of g.sections) {
    console.log(`  [${s.title || '—'}]`);
    for (const i of s.items) console.log(`    ${i.label}${i.hotkey ? `  ${i.hotkey}` : ''}${i.toggle ? '  [toggle]' : ''}`);
  }
}
