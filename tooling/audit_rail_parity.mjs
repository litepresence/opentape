// tooling/audit_rail_parity.mjs — the rail must match what the original sidebar
// actually shows: same groups in the same order, same section headers, same item
// labels in the same order, same shortcuts. Ground truth is
// tooling/tv-rail-spec.json, distilled from live DOM captures.
//
// node tooling/audit_rail_parity.mjs
import { readFileSync } from 'node:fs';
import { RAIL } from '../js/tools.js';

const spec = JSON.parse(readFileSync('tooling/tv-rail-spec.json', 'utf8'));
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// The Icons group is an emoji picker: labels live in a grid, not in the DOM.
const specGroups = spec.groups.filter((g) => g.group !== 'Icons');
const ourGroups = RAIL.filter((g) => g.sections.length && g.id !== 'icons');

check('group count', specGroups.length === ourGroups.length, `spec ${specGroups.length}, ours ${ourGroups.length}`);
check('group order + labels',
  specGroups.every((g, i) => ourGroups[i] && ourGroups[i].label === g.group),
  specGroups.map((g, i) => (ourGroups[i] ? (ourGroups[i].label === g.group ? '' : `${g.group}!=${ourGroups[i].label}`) : `${g.group} missing`)).filter(Boolean).join('; '));

for (const g of specGroups) {
  const ours = ourGroups.find((x) => x.label === g.group);
  if (!ours) continue;
  const specSec = g.sections.filter((s) => s.items.length);
  const ourSec = ours.sections.filter((s) => s.items.length);
  check(`${g.group}: section count`, specSec.length === ourSec.length, `spec ${specSec.length}, ours ${ourSec.length}`);
  for (let i = 0; i < Math.min(specSec.length, ourSec.length); i += 1) {
    const s = specSec[i];
    const o = ourSec[i];
    check(`${g.group} / ${s.title || '(none)'}: title`, (s.title || '') === (o.title || ''), `spec "${s.title}", ours "${o.title}"`);
    // TV renders live counts in these labels ("Remove 0 drawings"); compare the
    // template instead, with singular/plural collapsed.
    // TV renders live counts here ("Remove 0 drawings"); expand our template the
    // way the menu does, then compare with counts and plurals collapsed.
    const norm = (t) => String(t).replace(/\b\d+\b/g, '%n').replace(/s\b/g, '');
    const labels = s.items.map((x) => norm(x.label));
    const expand = (t) => t.replace('%d', '0 drawing').replace('%i', '1 indicator');
    const oursLabels = o.items.map((x) => norm(x.dynamic ? expand(x.dynamic) : x.label));
    check(`${g.group} / ${s.title || '(none)'}: items`,
      labels.length === oursLabels.length && labels.every((l, j) => oursLabels[j] === l),
      `spec [${labels.join(', ')}] ours [${oursLabels.join(', ')}]`);
    const hot = s.items.filter((x) => x.hotkey).map((x) => `${x.label}=${x.hotkey}`);
    const ourHot = o.items.filter((x) => x.hotkey).map((x) => `${x.label}=${x.hotkey}`);
    check(`${g.group}: shortcuts`, hot.join('|') === ourHot.join('|'), `spec [${hot.join(', ')}] ours [${ourHot.join(', ')}]`);
    const tog = s.items.filter((x) => x.toggle).map((x) => x.label).sort();
    const ourTog = o.items.filter((x) => x.toggle).map((x) => x.label).sort();
    check(`${g.group}: switches`, tog.join('|') === ourTog.join('|'), `spec [${tog.join(', ')}] ours [${ourTog.join(', ')}]`);
  }
}

// Structural guarantees the UI depends on.
const ids = RAIL.flatMap((g) => g.sections.flatMap((s) => s.items.map((i) => i.id)));
check('item ids unique', ids.length === new Set(ids).size, `${ids.length} ids, ${new Set(ids).size} unique`);
check('every drawing item has a kind', RAIL.every((g) => g.sections.every((s) => s.items.every((i) => !!i.kind))));
check('every item has a label', RAIL.every((g) => g.sections.every((s) => s.items.every((i) => !!i.label))));
check('15 rail entries', RAIL.length === 15, `${RAIL.length}`);

console.log(`\n${fails ? `${fails} FAILURES` : 'all rail-parity checks passed'}`);
process.exit(fails ? 1 : 0);
