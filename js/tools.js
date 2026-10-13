// js/tools.js — the left rail, mirroring the original sidebar's structure.
//
// Every rail icon is a *group*: clicking the icon arms its current tool, the
// chevron at the icon's right edge opens the tool menu. Menus carry section
// headers, keyboard shortcuts and switches, exactly as measured on the live
// chart (labels/order captured by tooling/tv_menu_capture.mjs, distilled by
// tooling/derive_rail_spec.mjs into tooling/tv-rail-spec.json).
//
// Group shape: { id, label, sections: [{ title, items: [...] }] }
// Item shape:  { id, label, kind, anchors, hotkey?, toggle?, action? }
//   kind    — renderer id used by js/overlay.js
//   anchors — clicks needed to place it (0 = mode/action, not a drawing)
//   action  — non-drawing command name handled by js/ui.js
//
// Icons are our own simple line glyphs (clean-room), not copies.

export const RAIL = [
  {
    id: 'cursors',
    label: 'Cursors',
    icon: 'cross',
    sections: [{
      title: '',
      items: [
        { id: 'cross', label: 'Cross', kind: 'cursor', anchors: 0, action: 'cursor:cross' },
        { id: 'dot', label: 'Dot', kind: 'cursor', anchors: 0, action: 'cursor:dot' },
        { id: 'arrow-cursor', label: 'Arrow', kind: 'cursor', anchors: 0, action: 'cursor:arrow' },
        { id: 'demonstration', label: 'Demonstration', kind: 'cursor', anchors: 0, action: 'cursor:demo' },
        { id: 'magic', label: 'Magic', kind: 'cursor', anchors: 0, action: 'cursor:magic' },
        { id: 'eraser', label: 'Eraser', kind: 'cursor', anchors: 0, action: 'cursor:eraser' },
        { id: 'values-tooltip', label: 'Values tooltip on long press', kind: 'switch', anchors: 0, toggle: 'valuesTooltip' },
      ],
    }],
  },
  {
    id: 'lines',
    label: 'Trend tools',
    icon: 'trend',
    sections: [
      {
        title: 'Lines',
        items: [
          { id: 'trend', label: 'Trendline', kind: 'segment', anchors: 2, hotkey: 'Alt + T' },
          { id: 'ray', label: 'Ray', kind: 'ray', anchors: 2 },
          { id: 'info', label: 'Info line', kind: 'infoline', anchors: 2 },
          { id: 'extended', label: 'Extended line', kind: 'extended', anchors: 2 },
          { id: 'angle', label: 'Trend angle', kind: 'angle', anchors: 2 },
          { id: 'horizontal', label: 'Horizontal line', kind: 'hline', anchors: 1, hotkey: 'Alt + H' },
          { id: 'hray', label: 'Horizontal ray', kind: 'hray', anchors: 1, hotkey: 'Alt + J' },
          { id: 'vertical', label: 'Vertical line', kind: 'vline', anchors: 1, hotkey: 'Alt + V' },
          { id: 'crossline', label: 'Crossline', kind: 'crossline', anchors: 1, hotkey: 'Alt + C' },
        ],
      },
      {
        title: 'Channels',
        items: [
          { id: 'parallel', label: 'Parallel channel', kind: 'channel', anchors: 3 },
          { id: 'regression', label: 'Regression trend', kind: 'regression', anchors: 2 },
          { id: 'flattop', label: 'Flat top/bottom', kind: 'flattop', anchors: 3 },
          { id: 'disjoint', label: 'Disjoint channel', kind: 'disjoint', anchors: 3 },
        ],
      },
      {
        title: 'Pitchforks',
        items: [
          { id: 'pitchfork', label: 'Pitchfork', kind: 'pitchfork', anchors: 3 },
          { id: 'schiff', label: 'Schiff pitchfork', kind: 'pitchfork', anchors: 3, variant: 'schiff' },
          { id: 'modschiff', label: 'Modified Schiff pitchfork', kind: 'pitchfork', anchors: 3, variant: 'modified' },
          { id: 'inside', label: 'Inside pitchfork', kind: 'pitchfork', anchors: 3, variant: 'inside' },
        ],
      },
    ],
  },
  {
    id: 'fib',
    label: 'Gann and Fibonacci tools',
    icon: 'fib',
    sections: [
      {
        title: 'Fibonacci',
        items: [
          { id: 'fib', label: 'Fib retracement', kind: 'fib', anchors: 2, hotkey: 'Alt + F' },
          { id: 'fibext', label: 'Trend-based fib extension', kind: 'fibext', anchors: 2 },
          { id: 'fibchannel', label: 'Fib channel', kind: 'fibchannel', anchors: 3 },
          { id: 'fibtime', label: 'Fib time zone', kind: 'fibtime', anchors: 2 },
          { id: 'fibfan', label: 'Fib speed resistance fan', kind: 'fibfan', anchors: 2 },
          { id: 'fibtimebased', label: 'Trend-based fib time', kind: 'fibtimebased', anchors: 2 },
          { id: 'fibcircles', label: 'Fib circles', kind: 'fibcircles', anchors: 2 },
          { id: 'fibspiral', label: 'Fib spiral', kind: 'fibspiral', anchors: 2 },
          { id: 'fibarcs', label: 'Fib speed resistance arcs', kind: 'fibarcs', anchors: 2 },
          { id: 'fibwedge', label: 'Fib wedge', kind: 'fibwedge', anchors: 2 },
          { id: 'pitchfan', label: 'Pitchfan', kind: 'pitchfan', anchors: 3 },
        ],
      },
      {
        title: 'Gann',
        items: [
          { id: 'gannbox', label: 'Gann box', kind: 'gannbox', anchors: 2 },
          { id: 'gannsqrfixed', label: 'Gann square fixed', kind: 'gannbox', anchors: 2, variant: 'square-fixed' },
          { id: 'gannsqr', label: 'Gann square', kind: 'gannbox', anchors: 2, variant: 'square' },
          { id: 'gannfan', label: 'Gann fan', kind: 'gannfan', anchors: 2 },
        ],
      },
    ],
  },
  {
    id: 'patterns',
    label: 'Patterns',
    icon: 'xabcd',
    sections: [
      {
        title: 'Chart patterns',
        items: [
          { id: 'xabcd', label: 'XABCD pattern', kind: 'poly', anchors: 5, labels: ['X', 'A', 'B', 'C', 'D'] },
          { id: 'cypher', label: 'Cypher pattern', kind: 'poly', anchors: 5, labels: ['X', 'A', 'B', 'C', 'D'] },
          { id: 'headshoulders', label: 'Head and shoulders', kind: 'poly', anchors: 6 },
          { id: 'abcd', label: 'ABCD pattern', kind: 'poly', anchors: 4, labels: ['A', 'B', 'C', 'D'] },
          { id: 'trianglepattern', label: 'Triangle pattern', kind: 'poly', anchors: 4 },
          { id: 'threedrives', label: 'Three drives pattern', kind: 'poly', anchors: 6 },
        ],
      },
      {
        title: 'Elliott waves',
        items: [
          { id: 'elliott12345', label: 'Elliott impulse wave (1·2·3·4·5)', kind: 'poly', anchors: 6, labels: ['1', '2', '3', '4', '5'] },
          { id: 'elliottABC', label: 'Elliott correction wave (A·B·C)', kind: 'poly', anchors: 4, labels: ['A', 'B', 'C'] },
          { id: 'elliottABCDE', label: 'Elliott triangle wave (A·B·C·D·E)', kind: 'poly', anchors: 6, labels: ['A', 'B', 'C', 'D', 'E'] },
          { id: 'elliottWXY', label: 'Elliott double combo wave (W·X·Y)', kind: 'poly', anchors: 4, labels: ['W', 'X', 'Y'] },
          { id: 'elliottWXYXZ', label: 'Elliott triple combo wave (W·X·Y·X·Z)', kind: 'poly', anchors: 6, labels: ['W', 'X', 'Y', 'X', 'Z'] },
        ],
      },
      {
        title: 'Cycles',
        items: [
          { id: 'cyclic', label: 'Cyclic lines', kind: 'cyclic', anchors: 3 },
          { id: 'timecycles', label: 'Time cycles', kind: 'timecycles', anchors: 2 },
          { id: 'sineline', label: 'Sine line', kind: 'sine', anchors: 2 },
        ],
      },
    ],
  },
  {
    id: 'forecast',
    label: 'Forecasting and measurement tools',
    icon: 'forecast',
    sections: [
      {
        title: 'Forecasting',
        items: [
          { id: 'longpos', label: 'Long position', kind: 'position', anchors: 2, variant: 'long' },
          { id: 'shortpos', label: 'Short position', kind: 'position', anchors: 2, variant: 'short' },
          { id: 'posforecast', label: 'Position forecast', kind: 'position', anchors: 3 },
          { id: 'barspattern', label: 'Bars pattern', kind: 'barspattern', anchors: 3 },
          { id: 'ghostfeed', label: 'Ghost feed', kind: 'ghostfeed', anchors: 2 },
          { id: 'sector', label: 'Sector', kind: 'sector', anchors: 2 },
        ],
      },
      {
        title: 'Volume-based',
        items: [
          { id: 'vwap', label: 'Anchored VWAP', kind: 'vwap', anchors: 1 },
          { id: 'volprofilefixed', label: 'Fixed range volume profile', kind: 'volprofile', anchors: 2, variant: 'fixed' },
          { id: 'volprofileanchored', label: 'Anchored volume profile', kind: 'volprofile', anchors: 2, variant: 'anchored' },
        ],
      },
      {
        title: 'Measurers',
        items: [
          { id: 'pricerange', label: 'Price range', kind: 'pricerange', anchors: 2 },
          { id: 'daterange', label: 'Date range', kind: 'daterange', anchors: 2 },
          { id: 'daterangeprice', label: 'Date and price range', kind: 'daterange', anchors: 2, variant: 'price' },
        ],
      },
    ],
  },
  {
    id: 'shapes',
    label: 'Geometric shapes',
    icon: 'brush',
    sections: [
      {
        title: 'Brushes',
        items: [
          { id: 'brush', label: 'Brush', kind: 'brush', anchors: 2 },
          { id: 'highlighter', label: 'Highlighter', kind: 'brush', anchors: 2, variant: 'highlight' },
        ],
      },
      {
        title: 'Arrows',
        items: [
          { id: 'arrowmarker', label: 'Arrow marker', kind: 'arrow', anchors: 2, variant: 'marker' },
          { id: 'arrow', label: 'Arrow', kind: 'arrow', anchors: 2 },
          { id: 'arrmarkup', label: 'Arrow mark up', kind: 'arrow', anchors: 2, variant: 'up' },
          { id: 'arrmarkdown', label: 'Arrow mark down', kind: 'arrow', anchors: 2, variant: 'down' },
        ],
      },
      {
        title: 'Shapes',
        items: [
          { id: 'rect', label: 'Rectangle', kind: 'rect', anchors: 2 },
          { id: 'rotrect', label: 'Rotated rectangle', kind: 'rotrect', anchors: 2 },
          { id: 'path', label: 'Path', kind: 'poly', anchors: 4 },
          { id: 'circle', label: 'Circle', kind: 'ellipse', anchors: 2, variant: 'circle' },
          { id: 'ellipse', label: 'Ellipse', kind: 'ellipse', anchors: 2 },
          { id: 'polyline', label: 'Polyline', kind: 'poly', anchors: 4 },
          { id: 'triangle', label: 'Triangle', kind: 'poly', anchors: 3, close: true },
          { id: 'arc', label: 'Arc', kind: 'arc', anchors: 2 },
          { id: 'curve', label: 'Curve', kind: 'poly', anchors: 3, smooth: true },
          { id: 'doublecurve', label: 'Double curve', kind: 'poly', anchors: 4, smooth: true },
        ],
      },
    ],
  },
  {
    id: 'text',
    label: 'Annotation tools',
    icon: 'text',
    sections: [
      {
        title: 'Text and notes',
        items: [
          { id: 'text', label: 'Text', kind: 'text', anchors: 1 },
          { id: 'note', label: 'Note', kind: 'note', anchors: 1 },
          { id: 'pricenote', label: 'Price note', kind: 'pricenote', anchors: 1 },
          { id: 'pin', label: 'Pin', kind: 'pin', anchors: 1 },
          { id: 'table', label: 'Table', kind: 'table', anchors: 1 },
          { id: 'callout', label: 'Callout', kind: 'callout', anchors: 2 },
          { id: 'comment', label: 'Comment', kind: 'note', anchors: 1, variant: 'comment' },
          { id: 'pricelabel', label: 'Price label', kind: 'pricelabel', anchors: 1 },
          { id: 'signpost', label: 'Signpost', kind: 'signpost', anchors: 2 },
          { id: 'flag', label: 'Flag mark', kind: 'flag', anchors: 2 },
        ],
      },
      {
        title: 'Content',
        items: [
          { id: 'image', label: 'Image', kind: 'image', anchors: 1 },
          { id: 'post', label: 'Post', kind: 'post', anchors: 1 },
          { id: 'idea', label: 'Idea', kind: 'post', anchors: 1, variant: 'idea' },
        ],
      },
    ],
  },
  {
    id: 'icons',
    label: 'Icons',
    icon: 'icon',
    picker: 'emoji',
    sections: [{
      title: '',
      items: [{ id: 'emoji', label: 'Emoji', kind: 'emoji', anchors: 0, action: 'open:emoji' }],
    }],
  },

  // Rail icons with no flyout: they act immediately.
  { id: 'measure', label: 'Measure', icon: 'measure', direct: true, sections: [] },
  { id: 'zoom', label: 'Zoom in', icon: 'zoom', direct: true, sections: [] },

  {
    id: 'magnets',
    label: 'Magnets',
    icon: 'magnet',
    sections: [{
      title: '',
      items: [
        { id: 'weak', label: 'Weak magnet', kind: 'mode', anchors: 0, action: 'magnet:weak' },
        { id: 'strong', label: 'Strong magnet', kind: 'mode', anchors: 0, action: 'magnet:strong' },
        { id: 'snapindicators', label: 'Snap to indicators', kind: 'switch', anchors: 0, toggle: 'snapIndicators' },
      ],
    }],
  },
  { id: 'stay', label: 'Keep drawing', icon: 'stay', direct: true, sections: [] },
  {
    id: 'lock',
    label: 'Lock options',
    icon: 'lock',
    sections: [{
      title: '',
      items: [
        { id: 'lockdrawings', label: 'Lock drawings', kind: 'mode', anchors: 0, action: 'lock:drawings' },
        { id: 'lockindicators', label: 'Lock indicators', kind: 'mode', anchors: 0, action: 'lock:indicators' },
        { id: 'lockall', label: 'Lock all', kind: 'mode', anchors: 0, action: 'lock:all' },
      ],
    }],
  },
  {
    id: 'hide',
    label: 'Hide options',
    icon: 'hide',
    sections: [{
      title: '',
      items: [
        { id: 'hidedrawings', label: 'Hide drawings', kind: 'mode', anchors: 0, action: 'hide:drawings' },
        { id: 'hideindicators', label: 'Hide indicators', kind: 'mode', anchors: 0, action: 'hide:indicators' },
        { id: 'hidepositions', label: 'Hide positions and orders', kind: 'mode', anchors: 0, action: 'hide:positions' },
        { id: 'hideall', label: 'Hide all', kind: 'mode', anchors: 0, action: 'hide:all' },
      ],
    }],
  },
  {
    id: 'remove',
    label: 'Remove options',
    icon: 'remove',
    sections: [{
      title: '',
      items: [
        { id: 'removedrawings', label: 'Remove drawings', kind: 'mode', anchors: 0, action: 'remove:drawings', dynamic: 'Remove %d' },
        { id: 'removeindicators', label: 'Remove indicators', kind: 'mode', anchors: 0, action: 'remove:indicators', dynamic: 'Remove %n indicator' },
        { id: 'removeall', label: 'Remove drawings and indicators', kind: 'mode', anchors: 0, action: 'remove:all', dynamic: 'Remove %d & %i' },
        { id: 'removelocked', label: 'Always remove locked drawings', kind: 'switch', anchors: 0, toggle: 'removeLocked' },
      ],
    }],
  },
];

export const RAIL_GROUPS = Object.fromEntries(RAIL.map((g) => [g.id, g]));

// The Icons group has no menu rows of its own: its glyph opens the emoji
// picker, and the chosen emoji arms this tool.
const HIDDEN_ITEMS = [
  { id: 'icon', label: 'Icon', kind: 'icon', anchors: 1, group: 'icons', groupLabel: 'Icons' },
];

const ALL_ITEMS = [
  ...RAIL.flatMap((g) => g.sections.flatMap((s) => s.items.map((i) => ({ ...i, group: g.id, groupLabel: g.label })))),
  ...HIDDEN_ITEMS,
];

export const ITEMS = Object.fromEntries(ALL_ITEMS.map((i) => [i.id, i]));
export const ITEM_LIST = ALL_ITEMS;

export function groupOf(tool) {
  return ITEM_LIST.find((i) => i.id === tool)?.group || null;
}
export function firstToolOf(groupId) {
  const g = RAIL_GROUPS[groupId];
  return g?.sections[0]?.items[0]?.id || null;
}
export function anchorsOf(tool) {
  const it = ITEMS[tool];
  return it && it.anchors > 1 ? it.anchors : 2;
}

// --- rail glyphs (our own line art) -----------------------------------------
const GLYPHS = {
  cross: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
  trend: 'M4 20L20 4M4 20L20 20',
  fib: 'M4 5h16M4 10h11M4 15h8M4 20h16',
  xabcd: 'M4 18l4-9 4 6 3-4 5 3',
  forecast: 'M3 17h6M15 17h6M9 15l4-8 4 8',
  brush: 'M3 18c4 0 4-7 8-7s4 5 9 3',
  text: 'M8 4h8M12 4v16',
  icon: 'M12 3l2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8z',
  measure: 'M3 15.5L15.5 3 21 8.5 8.5 21zM7 14l1.8 1.8M10 11l1.8 1.8M13 8l1.8 1.8',
  zoom: 'M11 4a7 7 0 100 14 7 7 0 000-14zM16 16l5 5',
  magnet: 'M6 3v9a6 6 0 0012 0V3',
  stay: 'M4 20l1-4L16 5l3 3L8 19l-4 1z',
  lock: 'M5 11h14v9H5zM8 11V8a4 4 0 018 0v3',
  hide: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
  remove: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
};

export function iconSvg(name, cls = '') {
  const d = GLYPHS[name] || GLYPHS.trend;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ''}><path d="${d}"/></svg>`;
}
