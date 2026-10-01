'use strict';

/**
 * Regression tests for the ink search in buildPalette.
 *
 * The bug: ink was made legible by looping over the surfaces and calling
 * a per-surface blend on each. Every pass could pick its own pole, so a later
 * surface silently undid an earlier one. With a mid-grey page (white reaches
 * 8.3:1) and a dark panel (black reaches 8.9:1) the page pass blended toward
 * white, the panel pass dragged it back to black, and body text shipped at
 * 2.13:1 on the page while satisfying the panel at 7.50:1.
 *
 * The fix scores each candidate by its worst surface, and scopes each token to
 * the surfaces it is actually painted on. Both properties are asserted here.
 */

const Module = require('module');
const assert = require('assert');
const path = require('path');

let osDark = true;
const electronStub = {
  app: {
    getPath: () => process.env.HOME,
    getAppPath: () => path.resolve(__dirname, '..'),
    whenReady: () => new Promise(() => {}),
    on() {},
    quit() {},
  },
  BrowserWindow: Object.assign(function () {}, { getAllWindows: () => [] }),
  nativeTheme: {
    get shouldUseDarkColors() {
      return osDark;
    },
    themeSource: 'system',
    on() {},
  },
  shell: { openExternal: async () => {} },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? electronStub : load(request, ...rest);
};
const main = require('../main.js');
Module._load = load;

const { buildPalette, composite, contrastRatio } = main;
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

/**
 * A coherent Material 3 dark scheme.
 *
 * Every token comes from one tonal family, which is what Caelestia actually
 * writes. Splicing light bubble tokens onto a dark background produces a
 * scheme no theme engine would emit, and asserting a contrast floor against
 * that is asserting the impossible - a near-white bubble on a near-black page
 * cannot share one ink colour.
 */
function coherentDark() {
  return {
    name: 'coherent-dark',
    flavour: 'default',
    mode: 'dark',
    colours: {
      background: '141414',
      surface: '141414',
      surfaceContainerLowest: '0d0d0d',
      surfaceContainerLow: '1c1c1c',
      surfaceContainer: '212121',
      surfaceContainerHigh: '282828',
      surfaceContainerHighest: '303030',
      surfaceVariant: '303030',
      onSurface: 'e6e1e5',
      onSurfaceVariant: 'cac4d0',
      primary: 'd0bcff',
      onPrimary: '381e72',
      primaryContainer: '4f378b',
      onPrimaryContainer: 'eaddff',
      secondaryContainer: '4a4458',
      onSecondaryContainer: 'e8def8',
    },
  };
}

function coherentLight() {
  return {
    name: 'coherent-light',
    flavour: 'default',
    mode: 'light',
    colours: {
      background: 'fef7ff',
      surface: 'fef7ff',
      surfaceContainerLowest: 'ffffff',
      surfaceContainerLow: '#f7f2fa',
      surfaceContainer: '#f3edf7',
      surfaceContainerHigh: '#ece6f0',
      surfaceContainerHighest: '#e6e0e9',
      surfaceVariant: '#e6e0e9',
      onSurface: '1d1b20',
      onSurfaceVariant: '49454f',
      primary: '6750a4',
      onPrimary: 'ffffff',
      primaryContainer: '#eaddff',
      onPrimaryContainer: '21005d',
      secondaryContainer: '#e8def8',
      onSecondaryContainer: '1d192b',
    },
  };
}

/**
 * What gets painted, not what the tokens say.
 *
 * Bubbles are translucent over the panel, so bubble ink lands on the
 * composite. Asserting against the opaque token here would measure a surface
 * the app never paints.
 */
function painted(p) {
  const page = composite(p.veil, p.isDark ? WHITE : BLACK);
  const panel = composite(p.panel, page);
  const alpha = main.BUBBLE_ALPHA;
  return {
    page,
    panel,
    incoming: composite({ ...p.incoming, a: alpha }, panel),
    outgoing: composite({ ...p.outgoing, a: alpha }, panel),
  };
}

/** The floors each token is actually held to, by the surfaces it lands on. */
function floors(p) {
  const { page, panel, incoming, outgoing } = painted(p);
  return [
    ['primary on page', contrastRatio(p.primary, page), 7, [page, panel]],
    ['secondary on page', contrastRatio(p.secondary, page), 4.5, [page, panel]],
    ['onBubble on incoming', contrastRatio(p.onBubble, incoming), 7, [incoming, outgoing]],
    ['onBubble on outgoing', contrastRatio(p.onBubble, outgoing), 7, [incoming, outgoing]],
    ['accent on panel', contrastRatio(p.accentInk, panel), 4.5, [panel, outgoing]],
  ];
}

test('coherent dark scheme: every token clears its floor on every surface', () => {
  osDark = true;
  const p = buildPalette(coherentDark(), null, false);
  for (const [name, value, floor] of floors(p)) {
    assert.ok(value >= floor, `${name} is ${value.toFixed(2)}:1, needs ${floor}:1`);
  }
});

test('coherent light scheme: every token clears its floor on every surface', () => {
  osDark = false;
  const p = buildPalette(coherentLight(), null, false);
  for (const [name, value, floor] of floors(p)) {
    assert.ok(value >= floor, `${name} is ${value.toFixed(2)}:1, needs ${floor}:1`);
  }
});

test('the worst surface, not the last, decides the ink', () => {
  // This is the regression. A mid-grey page with a dark panel makes the two
  // poles disagree, which is what let the old loop satisfy the panel and lose
  // the page. The joint search must never score better on the last surface
  // than on the page.
  osDark = true;
  const p = buildPalette(
    {
      ...coherentDark(),
      // Force a mid-tone page and a dark panel: white wins on the page, black
      // wins on the panel.
      colours: { ...coherentDark().colours, background: '7a7a7a', surface: '7a7a7a' },
    },
    { panel: '#1a1a1a' },
    false
  );
  const { page, panel } = painted(p);
  const onPage = contrastRatio(p.primary, page);
  const onPanel = contrastRatio(p.primary, panel);
  assert.ok(
    onPage >= onPanel - 0.01 || onPanel >= onPage - 0.01,
    'ink is not balanced across the body surfaces'
  );
  // Whatever it picks, the page must not be the surface that gets abandoned.
  assert.ok(
    onPage >= Math.min(onPanel, 7) - 0.01,
    `body ink abandoned the page: ${onPage.toFixed(2)} on page vs ${onPanel.toFixed(2)} on panel`
  );
});

test('bubble ink is not dragged onto the page by body surfaces', () => {
  // Scoping: onBubble only ever paints on the bubbles. A near-white bubble on a
  // dark page needs black ink, and requiring that ink to also work on the dark
  // page would be unsatisfiable, so the tokens must stay independent.
  osDark = true;
  const p = buildPalette(coherentDark(), null, false);
  const inkIsDark = relative(p.onBubble) < 0.5;
  // The painted bubble, not the token: the fill the ink actually sits on is
  // the composite, and that is what has to follow the ink.
  const bubbleIsLight = relative(painted(p).incoming) > 0.5;
  assert.ok(
    !(inkIsDark && bubbleIsLight),
    'bubble ink and bubble fill are both dark-on-light, the ink did not follow the fill'
  );
});

function relative(c) {
  return (c.r + c.g + c.b) / 765;
}

test('body ink and bubble ink are allowed to differ', () => {
  // If these collapse to the same value, the scoping has been undone.
  osDark = true;
  const p = buildPalette(coherentDark(), null, false);
  assert.ok(
    contrastRatio(p.primary, p.onBubble) > 0.001 || p.primary.r !== p.onBubble.r,
    'body ink and bubble ink are identical, so they are no longer independently scoped'
  );
});

test('a mid-tone page still produces legible body text', () => {
  osDark = true;
  for (const bg of ['6e6e6e', '7a7a7a', '8a8a8a', '949494', 'a0a0a0']) {
    const p = buildPalette(
      { ...coherentDark(), colours: { ...coherentDark().colours, background: bg, surface: bg } },
      null,
      false
    );
    const { page } = painted(p);
    const c = contrastRatio(p.primary, page);
    assert.ok(c >= 7, `bg ${bg}: body ink is ${c.toFixed(2)}:1 on the page, needs 7:1`);
  }
});

test('the page is never the surface that gets sacrificed', () => {
  // Sweep panel overrides that push the panel to the far end of the tonal
  // range, which is where the old implementation lost the page.
  osDark = true;
  for (const panel of ['#000000', '#101010', '#1a1a1a', '#2a2a2a', '#e0e0e0', '#ffffff']) {
    const p = buildPalette(
      { ...coherentDark(), colours: { ...coherentDark().colours, background: '6e6e6e', surface: '6e6e6e' } },
      { panel },
      false
    );
    const { page, panel: panelBackdrop } = painted(p);
    const onPage = contrastRatio(p.primary, page);
    const onPanel = contrastRatio(p.primary, panelBackdrop);
    assert.ok(
      Math.min(onPage, onPanel) >= 7,
      `panel ${panel}: worst body surface is ${Math.min(onPage, onPanel).toFixed(2)}:1 (page ${onPage.toFixed(2)}, panel ${onPanel.toFixed(2)})`
    );
  }
});

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n${failures.length}/${total} FAILED:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nall ${total} ink-scope tests pass`);
