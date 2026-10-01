'use strict';

/**
 * Regression tests for the palette pipeline in main.js.
 *
 * The shell loads WhatsApp Web in a transparent window, so everything the
 * user reads sits on a translucent panel over a desktop wallpaper. These tests
 * assert the guarantees that makes expensive: legible ink on every surface,
 * panels that actually separate from the page, and no way for a token to break
 * out of the generated stylesheet.
 *
 * Run with `npm test`. No test framework - the assertions are plain enough
 * that a dependency would cost more than it saves.
 */

const Module = require('module');
const assert = require('assert');
const path = require('path');

/*
 * main.js calls app.getPath() and reads nativeTheme at module scope, so it
 * cannot be required outside a real Electron process. Stub the module before
 * loading it, exactly as Electron would.
 */
let osDark = true;
const electronStub = {
  app: {
    getPath: () => process.env.HOME,
    getAppPath: () => path.resolve(__dirname, '..'),
    whenReady: () => new Promise(() => {}), // never resolves: no window
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

const loadMain = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return loadMain(request, ...rest);
};

const main = require('../main.js');
Module._load = loadMain;

const {
  parseColor,
  contrastRatio,
  composite,
  buildPalette,
  generateMaskCSS,
  mix,
  isDarkSurface,
} = main;

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

const CONTRAST = { primary: 7, secondary: 4.5, onBubble: 7, accent: 4.5, panelSep: 1.15 };

/**
 * The best worst-case contrast any blend of `from` could reach on `surfaces`.
 *
 * Brute-forces the same search space buildPalette uses - both poles, every
 * 0.05 step - so it reports the exact optimum rather than an approximation.
 * This is what separates "the algorithm chose badly" from "this surface set
 * admits no colour that clears the floor".
 */
function bestAchievable(from, surfaces) {
  const worstFor = (c) => surfaces.reduce((w, s) => Math.min(w, contrastRatio(c, s)), Infinity);
  let best = 0;
  for (const target of [WHITE, BLACK]) {
    for (let step = 0; step <= 1.0001; step += 0.05) {
      const worst = worstFor(mix(from, target, step));
      if (worst > best) best = worst;
    }
  }
  return best;
}

/**
 * A fixed dark scheme, modelled on the real Caelestia "dynamic" tonalspot
 * output.
 *
 * Deliberately NOT the live scheme. Expectations like "dark tokens render dark"
 * only hold if the tokens are known, and reading ~/.local/state/caelestia makes
 * the suite's pass/fail depend on whichever desktop theme the user happens to
 * be running - switching Caelestia to light turns a green suite red without a
 * single line of the shell changing. The live scheme is exercised separately,
 * for parsing only, where "whatever is on disk" is the right input.
 */
const scheme = {
  name: 'fixture-dark',
  flavour: 'default',
  mode: 'dark',
  colours: {
    background: '0f0e08',
    surface: '0f0e08',
    surfaceContainerLow: '14140c',
    surfaceContainer: '1a1a11',
    surfaceContainerHigh: '202016',
    surfaceContainerHighest: '27261a',
    surfaceVariant: '27261a',
    onSurface: 'e9e6d3',
    onSurfaceVariant: 'aeac9a',
    primary: 'cbca8e',
    primaryContainer: '555525',
    onPrimaryContainer: 'e8e7a8',
  },
};

/** Whatever Caelestia currently has on disk, for parse-level checks only. */
const liveScheme = main.loadCaelestiaScheme();

/** Derive a light-scheme variant from the real tokens. */
function lightScheme(background, tiers, primaryContainer) {
  return {
    name: 'light',
    flavour: 'default',
    mode: 'light',
    colours: {
      ...scheme.colours,
      background,
      surface: background,
      surfaceContainerLow: tiers[0],
      surfaceContainer: tiers[1],
      surfaceContainerHigh: tiers[2],
      surfaceContainerHighest: tiers[3],
      surfaceVariant: tiers[3],
      onSurface: '1b1b18',
      onSurfaceVariant: '4c4a41',
      primary: '3f5b00',
      primaryContainer: primaryContainer || 'c5ef8e',
      onPrimaryContainer: '0e2000',
    },
  };
}

/** What the compositor actually shows, as opposed to the token values. */
/**
 * main.js as source text.
 *
 * A handful of guarantees live in the Electron wiring - event registrations,
 * window options, command-line switches - where nothing is exported and there
 * is no headless way to observe them. Asserting on the source is the same
 * approach inject.test.js uses for the lifecycle hooks.
 */
const shell = require('fs').readFileSync(path.resolve(__dirname, '..', 'main.js'), 'utf8');

/**
 * What the compositor actually shows, as opposed to the token values.
 *
 * Bubbles are translucent over the panel, so the surface bubble ink actually
 * lands on is the composite - not the token. The suite previously compared ink
 * against the opaque token, which measured a surface the app stopped painting
 * and let a real regression through as a pass.
 */
function painted(palette) {
  const page = composite(palette.veil, palette.isDark ? WHITE : BLACK);
  const panel = composite(palette.panel, page);
  const alpha = main.BUBBLE_ALPHA;
  return {
    page,
    panel,
    incoming: composite({ ...palette.incoming, a: alpha }, panel),
    outgoing: composite({ ...palette.outgoing, a: alpha }, panel),
  };
}

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

/* ------------------------------------------------------------------ *
 * Token parsing
 * ------------------------------------------------------------------ */

test('parses bare Caelestia hex', () => {
  // The live scheme stores "0f0e08", with no leading '#'.
  const parsed = parseColor('0f0e08');
  assert.deepStrictEqual(parsed, { r: 15, g: 14, b: 8, a: 1 });
});

test('parses every format we accept', () => {
  assert.deepStrictEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepStrictEqual(parseColor('#00a884'), { r: 0, g: 168, b: 132, a: 1 });
  assert.deepStrictEqual(parseColor('#00a884ff'), { r: 0, g: 168, b: 132, a: 1 });
  assert.deepStrictEqual(parseColor('rgb(0, 168, 132)'), { r: 0, g: 168, b: 132, a: 1 });
  assert.strictEqual(parseColor('rgba(0,0,0,0.5)').a, 0.5);
  assert.deepStrictEqual(parseColor('white'), WHITE);
});

test('rejects junk rather than guessing', () => {
  for (const bad of ['', 'zzz', '12345', 'not a colour', null, undefined, 42, {}]) {
    assert.strictEqual(parseColor(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('every token in the live scheme parses', () => {
  if (!liveScheme) return; // nothing to check
  const unparsed = Object.entries(liveScheme.colours || {}).filter(([, v]) => parseColor(v) === null);
  assert.deepStrictEqual(unparsed, [], 'unparseable tokens present');
});

test('the live scheme, whatever it is, clears the contrast floors', () => {
  // The fixture above pins the expectations; this is the one case where the
  // tokens genuinely are whatever the user is running right now, so it is
  // asserted with the same floors but no fixed expectation about the mode.
  if (!liveScheme) return;
  const palette = buildPalette(liveScheme, null, false);
  const { page, panel, incoming: paintedIncoming, outgoing: paintedOutgoing } = painted(palette);
  // Same optimality rule as the fixture loop: the live scheme is whatever the
  // user is running, so a surface set that admits no colour at the floor must
  // be reported as optimal rather than failing the suite.
  const scopes = [
    ['primary', palette.primary, CONTRAST.primary, [page, panel]],
    ['secondary', palette.secondary, CONTRAST.secondary, [page, panel]],
    ['bubble ink', palette.onBubble, CONTRAST.onBubble, [paintedIncoming, paintedOutgoing]],
    ['accent', palette.accentInk, CONTRAST.accent, [panel, paintedOutgoing]],
  ];
  for (const [name, color, floor, surfaces] of scopes) {
    const worst = surfaces.reduce((w, s) => Math.min(w, contrastRatio(color, s)), Infinity);
    const best = bestAchievable(color, surfaces);
    const attainable = Math.min(floor, best);
    assert.ok(
      worst >= attainable - 0.05,
      `${name} manages ${worst.toFixed(2)}:1 on its worst surface; ` +
        `the best any colour can do is ${best.toFixed(2)}:1 (floor ${floor}:1)`
    );
  }
  assert.ok(contrastRatio(panel, page) >= CONTRAST.panelSep, 'panel does not separate from the page');
});

/* ------------------------------------------------------------------ *
 * Contrast primitives
 * ------------------------------------------------------------------ */

test('contrast ratio matches the WCAG reference values', () => {
  assert.strictEqual(contrastRatio(WHITE, WHITE).toFixed(2), '1.00');
  assert.strictEqual(contrastRatio(BLACK, BLACK).toFixed(2), '1.00');
  assert.strictEqual(contrastRatio(parseColor('#000000'), parseColor('#ffffff')).toFixed(2), '21.00');
  assert.strictEqual(contrastRatio(parseColor('#777777'), parseColor('#ffffff')).toFixed(2), '4.48');
});

test('ink blending hits its target and preserves hue', () => {
  // buildPalette is the only ink blender left, so exercise the blend through it
  // rather than against a helper that no longer exists: a brown token on a
  // near-black page has to come back light *and* still brown.
  const dark = buildPalette(
    {
      mode: 'dark',
      colours: {
        background: '0b0e11',
        surface: '0b0e11',
        surfaceContainerLow: '14181c',
        surfaceContainerHigh: '1c2126',
        surfaceContainerHighest: '23282e',
        surfaceVariant: '23282e',
        onSurface: '3a2a10',
        onSurfaceVariant: '2a2010',
        primary: '3a2a10',
        primaryContainer: '1c3a30',
      },
    },
    null,
    false
  );
  const { page } = painted(dark);
  const ink = dark.primary;
  assert.ok(contrastRatio(ink, page) >= CONTRAST.primary, `target not met: ${contrastRatio(ink, page).toFixed(2)}:1`);
  // Brown, not grey: the red channel must still dominate.
  assert.ok(ink.r > ink.b, 'hue was flattened toward the pole');
});

test('ink with headroom is not repainted at all', () => {
  // Nothing to blend means the token survives verbatim, so a Caelestia palette
  // that is already correct is passed straight through. Note this needs real
  // margin, not a hair's breadth: a token sitting at 7.03:1 against the floor
  // of 7:1 *should* be nudged, and the search is right to do it.
  const dark = buildPalette(
    {
      mode: 'dark',
      colours: {
        background: '0b0e11',
        surface: '0b0e11',
        surfaceContainerLow: '14181c',
        surfaceContainer: '181d22',
        surfaceContainerHigh: '1c2126',
        surfaceContainerHighest: '23282e',
        surfaceVariant: '23282e',
        onSurface: 'f7f6f2',
        onSurfaceVariant: 'aebac1',
        primary: '00a884',
        primaryContainer: '1c3a30',
      },
    },
    null,
    false
  );
  assert.deepStrictEqual(dark.primary, { ...parseColor('f7f6f2'), a: 1 });
});

/* ------------------------------------------------------------------ *
 * Palette guarantees
 * ------------------------------------------------------------------ */

/**
 * `expectDark` is the appearance implied by the *token values*, which is what
 * the pipeline treats as authoritative. It deliberately does not track the OS:
 * a dark scheme keeps rendering dark even when the desktop is light, because
 * reinterpreting dark tokens as light is what produces black-on-black.
 */
const PALETTES = [
  ['fixture dark scheme', scheme, null, false, true],
  ['fixture dark, OS light', scheme, null, true, true],
  ['synthesised light', lightScheme('fdf9ee', ['f6f2e7', 'f0ece1', 'eae6db', 'e4e0d5']), null, false, false],
  ['flat white', lightScheme('ffffff', ['f6f2e7', 'f0ece1', 'eae6db', 'e4e0d5']), null, false, false],
  ['mid-tone light', lightScheme('808080', ['8a8a8a', '949494', '9e9e9e', 'a8a8a8']), null, false, false],
  ['mid-tone bubbles', lightScheme('808080', ['8a8a8a', '949494', '9e9e9e', 'a8a8a8'], '777777'), null, false, false],
  ['everything mid-tone', lightScheme('7a7a7a', ['8a8a8a', '949494', '9e9e9e', 'a8a8a8'], '8f8f8f'), null, false, false],
  ['mid-tone teal', lightScheme('6a8a86', ['7a9a96', '8aaaa6', '9abab6', 'aacac6'], '5f7f7b'), null, false, false],
  ['hostile overrides', scheme, { primary: '3a2a10', secondary: '2b1f0a', accent: '000000', panel: '000000', incoming: '000000', outgoing: '000000' }, false, true],
  ['junk overrides', scheme, { primary: 'zzz', panel: '#12', blur: 'abc', opacity: 'abc' }, false, true],
  ['forced all-white', scheme, { primary: 'ffffff', secondary: 'fffff0', incoming: 'fffff0', outgoing: 'fffff0', panel: 'fffff0', bg: 'fffff0' }, false, false],
  ['forced all-black', scheme, { primary: '000000', secondary: '0a0a08', incoming: '0a0a08', outgoing: '0a0a08', panel: '0a0a08', bg: '0a0a08' }, false, true],
  ['no scheme at all', null, null, false, true],
  ['empty colours', { colours: {} }, null, false, true],
  ['junk tokens', { mode: 'dark', colours: { background: 'zzzz', onSurface: '12345', primary: '' } }, null, false, true],
  ['dark scheme forced light', { ...scheme, mode: 'light' }, null, true, true],
  ['light scheme forced dark', lightScheme('fdf9ee', ['f6f2e7', 'f0ece1', 'eae6db', 'e4e0d5']), null, true, false],
];

for (const [label, inputScheme, overrides, followSystem, expectDark] of PALETTES) {
  test(`palette: ${label}`, () => {
    osDark = !followSystem;
    const palette = buildPalette(inputScheme, overrides, followSystem);
    const { page, panel, incoming: paintedIncoming, outgoing: paintedOutgoing } = painted(palette);

    assert.strictEqual(palette.isDark, expectDark, `expected ${expectDark ? 'dark' : 'light'} mode`);

    // Each token is held to the surfaces it is actually painted on, and is
    // required to be *optimal* across them.
    //
    // Demanding the raw floor everywhere is demanding the impossible for some
    // surface sets. A mid-tone page (rgb 154) with a mid-tone panel (rgb 136)
    // leaves a best-case of 5.92:1 - no colour reaches 7:1 on both, because
    // they sit on opposite sides of the point where white and black tie. The
    // old all-surfaces chain only appeared to satisfy those cases by
    // abandoning some other surface, which is the bug this replaced. So: clear
    // the floor wherever it is reachable, and match the optimum exactly where
    // it is not.
    const scopes = [
      ['primary', palette.primary, CONTRAST.primary, [page, panel]],
      ['secondary', palette.secondary, CONTRAST.secondary, [page, panel]],
      ['bubble ink', palette.onBubble, CONTRAST.onBubble, [paintedIncoming, paintedOutgoing]],
      ['accent', palette.accentInk, CONTRAST.accent, [panel, paintedOutgoing]],
    ];

    for (const [name, color, floor, surfaces] of scopes) {
      const worst = surfaces.reduce((w, s) => Math.min(w, contrastRatio(color, s)), Infinity);
      const best = bestAchievable(color, surfaces);
      const attainable = Math.min(floor, best);
      assert.ok(
        worst >= attainable - 0.05,
        `${name} manages ${worst.toFixed(2)}:1 on its worst surface; ` +
          `the best any colour can do is ${best.toFixed(2)}:1 (floor ${floor}:1)`
      );
    }

    // A panel that matches the page is invisible; glass needs tonal distance.
    assert.ok(
      contrastRatio(panel, page) >= CONTRAST.panelSep,
      `panel separation is ${contrastRatio(panel, page).toFixed(2)}:1, needs ${CONTRAST.panelSep}:1`
    );
  });
}

test('tokens win over the declared mode string', () => {
  // A dark scheme with mode: "light" must not render black ink on a dark page.
  osDark = false;
  const palette = buildPalette({ ...scheme, mode: 'light' }, null, true);
  assert.strictEqual(palette.isDark, true, 'appearance must follow the tokens');
  const { page } = painted(palette);
  assert.ok(contrastRatio(palette.primary, page) >= CONTRAST.primary);
});

/* ------------------------------------------------------------------ *
 * Generated stylesheet
 * ------------------------------------------------------------------ */

test('stylesheet is structurally sound', () => {
  const css = generateMaskCSS(scheme, null, false);
  const opens = (css.match(/\{/g) || []).length;
  const closes = (css.match(/\}/g) || []).length;
  assert.strictEqual(opens, closes, 'unbalanced braces');
  assert.ok(!/NaN|undefined|Infinity/.test(css), 'invalid number in output');
  assert.ok(css.includes('color-scheme:'), 'missing color-scheme');
});

test('stylesheet reaches the nested bubble divs', () => {
  // WhatsApp paints the inner div; the row class alone would lose the cascade.
  const css = generateMaskCSS(scheme, null, false);
  assert.ok(/\.message-in > div/.test(css), 'incoming bubble rule missing');
  assert.ok(/\.message-out > div/.test(css), 'outgoing bubble rule missing');
  assert.ok(css.includes('backdrop-filter:'), 'glass filter missing');
});

/* ------------------------------------------------------------------ *
 * Theme-leak overrides
 *
 * WhatsApp layers its own palette on top of ours in four places that a
 * plain variable override does not reach: the bubble element has moved
 * between builds, the chat wallpaper is an image rather than a colour,
 * and the message tail is tinted from its own palette. Each of those has
 * failed in the wild by leaving a green artefact on an otherwise themed
 * background, so each is pinned here.
 * ------------------------------------------------------------------ */

/**
 * Split the stylesheet into top-level rules, with comments blanked out.
 *
 * Blanking (rather than deleting) keeps every index valid, and it matters:
 * the comments in generateMaskCSS quote selectors and declarations verbatim,
 * so a naive substring search matches the prose describing a rule instead of
 * the rule itself. @media blocks nest, hence the depth counter.
 */
function parseRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  const rules = [];
  let selector = '';
  let depth = 0;
  let start = 0;

  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '{') {
      if (depth === 0) {
        selector = clean.slice(start, i).trim();
        start = i + 1;
      }
      depth += 1;
    } else if (clean[i] === '}' && --depth === 0) {
      rules.push({ selector, body: clean.slice(start, i) });
      start = i + 1;
    }
  }
  return rules;
}

/**
 * The first rule mentioning `marker` in either its selector list or its body.
 *
 * Both halves are searched because a test may be pointing at a selector
 * (`#main > div`) or at a declaration (`background-image: none`), and in the
 * second case the marker sits inside a block whose selector is far above it.
 */
function ruleFor(css, marker) {
  const hit = parseRules(css).find(
    (r) => r.selector.includes(marker) || r.body.includes(marker)
  );
  assert.ok(hit, `no rule mentions ${marker}`);
  return hit;
}

/** Render a colour the way the stylesheet does, for exact-match assertions. */
function rgb(c) {
  return `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)})`;
}

test('bubble ink clears its floor on the painted bubble, not the token', () => {
  // The whole reason painted() composites is that the app emits an alpha. If
  // the stylesheet goes back to opaque fills, every painted-surface assertion
  // above silently starts measuring a surface the app no longer draws, and
  // they all still pass - so the alpha is pinned here directly.
  const css = generateMaskCSS(scheme, null, false);
  const alpha = main.BUBBLE_ALPHA;
  assert.ok(alpha < 1, `BUBBLE_ALPHA is ${alpha}, so nothing is translucent`);

  // Both the custom properties AND the element rules. A stylesheet can declare
  // a translucent property and then paint opaque bubbles straight onto the real
  // elements - and the elements are what the user actually sees.
  for (const token of ['--incoming-background', '--outgoing-background']) {
    const declared = css.slice(css.indexOf(token));
    assert.ok(declared.length, `${token} is not set`);
    assert.ok(
      new RegExp(`${token}:[^;]*rgba\\(`).test(declared),
      `${token} is not emitted as an rgba fill`
    );
  }

  const outgoing = parseRules(css).find(
    (r) => r.selector.includes('[data-id]') && r.selector.includes('message-out')
  );
  assert.ok(outgoing, 'no outgoing bubble rule found');
  assert.ok(
    /background-color:\s*rgba\(/.test(outgoing.body),
    'outgoing bubbles are not painted with an rgba fill'
  );
  // Matched on [data-id]: the comment block above the bubbles quotes
  // "message-in" verbatim, so a looser selector finds the prose instead.
  const incoming = parseRules(css).find(
    (r) => r.selector.includes('[data-id]') && r.selector.includes('message-in')
  );
  assert.ok(incoming, 'no incoming bubble rule found');
  assert.ok(
    /background-color:\s*rgba\(/.test(incoming.body),
    'incoming bubbles are not painted with an rgba fill'
  );
  assert.ok(
    !/background-color:\s*rgb\(/.test(incoming.body),
    'incoming bubbles are still opaque, so the painted-surface maths is fiction'
  );
});

test('kills the tiled chat wallpaper', () => {
  // background-image is a different property from background-color, so the
  // colour override alone leaves the doodle pattern showing through the glass.
  const rule = ruleFor(generateMaskCSS(scheme, null, false), 'background-image: none');
  assert.ok(
    /background-image:\s*none\s*!important/.test(rule.body),
    'wallpaper image is not cleared with !important'
  );
  for (const node of ['#main', '#main > div', '[data-asset-chat-background="true"]']) {
    assert.ok(rule.selector.includes(node), `chat wallpaper is not cleared on ${node}`);
  }
});

test('conversation area is translucent and explicitly un-blurred', () => {
  // It sits inside the already-blurred #main AND it scrolls. A nested
  // backdrop-filter re-samples the parent's filtered result on every frame the
  // content moves, which is the whole cost of the frame budget on a long
  // thread. `none` is stated rather than merely omitted so that a later rule
  // cannot re-introduce a blur on the scroller by cascade.
  const rule = ruleFor(generateMaskCSS(scheme, null, false), '[data-asset-chat-background="true"]');
  assert.ok(/background-color/.test(rule.body), 'conversation area has no background');
  assert.ok(
    /backdrop-filter:\s*none\s*!important/.test(rule.body),
    'the scrolling conversation area is not explicitly denied a backdrop-filter'
  );
});

test('glass panes that do not scroll still carry the blur', () => {
  // The un-blurred scroller only reads as glass if something behind it is
  // actually blurred. Guarding against this rule disappearing along with the
  // chatter above.
  const rule = ruleFor(generateMaskCSS(scheme, null, false), '#side');
  assert.ok(
    /backdrop-filter:\s*blur\(/.test(rule.body),
    'the static panes lost their blur, so the conversation overlay has nothing to show'
  );
});

test('the blur is not applied to any scrolling node', () => {
  // Guard against the obvious "fix" for jank: putting a blur back on the
  // message list. Every selector carrying a blur must be a static pane.
  const scrollers = [
    '#main > span > div',
    '[data-asset-chat-background="true"]',
    '[data-animated-message-list]',
    '.message-list',
  ];
  const blurred = parseRules(generateMaskCSS(scheme, null, false)).filter((r) =>
    /backdrop-filter:\s*blur\(/.test(r.body)
  );
  assert.ok(blurred.length, 'no rule carries a blur at all');
  for (const rule of blurred) {
    for (const node of scrollers) {
      assert.ok(
        !rule.selector.includes(node),
        `a blur landed on the scrolling node ${node}`
      );
    }
  }
});

test('layer promotion is scoped to the scroller, not applied globally', () => {
  // A universal promote makes every bubble in a long thread its own texture,
  // which costs more than the jank it was meant to remove.
  const rules = parseRules(generateMaskCSS(scheme, null, false));
  const promoted = rules.filter((r) => /translateZ\(0\)/.test(r.body));
  assert.ok(promoted.length, 'nothing is promoted to its own layer');

  // Every promoted selector is inspected, not just whether one rule is safe -
  // a single blanket `div { translateZ(0) }` would otherwise hide behind a
  // correctly-scoped rule elsewhere in the sheet.
  // Unscoped means "not anchored to an id, a class or an attribute". A bare
  // type or universal selector promotes every matching node in a long thread,
  // which costs more memory than the jank it was meant to remove.
  const ANCHORED = /[#.[a-zA-Z]/;
  for (const rule of promoted) {
    for (const sel of rule.selector.split(',').map((s) => s.trim())) {
      assert.ok(sel, 'empty selector in a promotion rule');
      assert.ok(sel !== '*', 'layer promotion is applied to a universal selector');
      assert.ok(
        ANCHORED.test(sel),
        `layer promotion uses the unscoped selector "${sel}", which promotes every node`
      );
      assert.ok(
        sel.includes('#main') || sel.includes('message-') || sel.includes('data-asset'),
        `promotion selector "${sel}" is not scoped to a chat element`
      );
    }
  }
});

test('rAF is not throttled when the window loses focus', () => {
  // Chromium drops occluded/unfocused windows to a crawl. A chat window
  // sitting behind another one then stops compositing, which presents as
  // choppy scrolling once the user brings it forward again - the same
  // symptom as a compositing problem and a much cheaper fix.
  const opts = shell.match(/webPreferences:\s*\{([\s\S]*?)\n {4}\}/);
  assert.ok(opts, 'webPreferences block not found');
  assert.ok(
    /backgroundThrottling:\s*false/.test(opts[1]),
    'backgroundThrottling is left at the default, so an unfocused window stalls'
  );
});

test('the compositor is never forced onto the CPU', () => {
  // The regression this guards: a software-rendering flag added to work around
  // the old jank, which silently pins a long thread to CPU rasterisation.
  // The identifier appears twice outside comments: once in this file's own
  // prose and once as the guard that SKIPS the switches when acceleration is
  // already off. What must not exist is a statement that calls it.
  const code = shell.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/^[^\n]*\bdisableHardwareAcceleration\s*\(\s*\)/m.test(code),
    'hardware acceleration is disabled outright'
  );
  assert.ok(
    !/disable-gpu-compositing|disable-software-rasterizer|in-process-gpu/.test(shell),
    'a switch forces the compositor off the GPU'
  );
  for (const gpuFlag of ['enable-gpu-rasterization', 'ignore-gpu-blocklist', 'enable-zero-copy']) {
    assert.ok(shell.includes(gpuFlag), `${gpuFlag} is not requested`);
  }
});

test('gpu switches are appended before any window exists', () => {
  // After app.whenReady() the first frame may already have composited, and a
  // late switch does not retroactively promote anything.
  const applied = shell.indexOf('enableHardwareAcceleration();');
  const window = shell.indexOf('createWindow();');
  assert.ok(applied !== -1 && window !== -1, 'expected both the call and the window');
  assert.ok(applied < window, 'gpu switches are appended after the window was created');
});

test('the scroller is promoted and isolated from repaint', () => {
  const rule = parseRules(generateMaskCSS(scheme, null, false)).find(
    (r) => /translateZ\(0\)/.test(r.body) && /overscroll-behavior/.test(r.body)
  );
  assert.ok(rule, 'the message list is not promoted for scrolling');
  assert.ok(/#main > div/.test(rule.selector), 'the chat scroller is not among the promoted nodes');
});

/* ------------------------------------------------------------------ *
 * Status / media overlays
 *
 * Regression: the status viewer stopped playing while still being marked as
 * viewed. Layer promotion and contain: paint both make an element a containing
 * block for fixed-position descendants, and contain: paint also clips to the
 * element's own box - so promoting an ancestor of the full-viewport status
 * player left it with no usable surface. The read-receipt is sent by the SPA
 * on open, not on playback, which is why the failure looked like "viewed but
 * not played" rather than "status did not open".
 * ------------------------------------------------------------------ */

test('no promoted or contained node can contain a video', () => {
  // Every promotion must exclude a video subtree. Asserted over every
  // selector, because one unguarded selector is enough to break playback.
  const rules = parseRules(generateMaskCSS(scheme, null, false));
  const promoting = rules.filter((r) => /translateZ\(0\)|contain:\s*paint/.test(r.body));
  assert.ok(promoting.length, 'nothing is promoted, so this guard is measuring nothing');

  for (const rule of promoting) {
    // Bubbles are exempt: a bubble is never an overlay, and the status viewer
    // never renders inside one.
    if (rule.selector.includes('.message-in') || rule.selector.includes('.message-out')) continue;

    for (const sel of rule.selector.split(',').map((s) => s.trim())) {
      assert.ok(
        /:not\(:has\(video\)\)/.test(sel),
        `overlay-affecting promotion on "${sel}" with no video exclusion`
      );
    }
  }
});

test('contain: paint is never used', () => {
  // It was the cheapest-looking win and it is the one that clips. transform
  // alone already keeps the list on its own layer, so paint containment buys
  // nothing and risks hiding an overlay entirely.
  for (const rule of parseRules(generateMaskCSS(scheme, null, false))) {
    assert.ok(
      !/contain:\s*paint/.test(rule.body),
      `contain: paint reintroduced on "${rule.selector.slice(0, 60)}"`
    );
  }
});

test('the status viewer keeps its own surfaces', () => {
  // The opt-out is two rules by design. Appearance and containment fail
  // differently, so they are guarded differently: resetting the pane's colours
  // on every reachable container would mean an inline video message drops its
  // bubble fill, while resetting containment is invisible and therefore safe to
  // apply everywhere the stylesheet can reach.
  const css = generateMaskCSS(scheme, null, false);

  const surface = ruleFor(css, 'background-image: initial');
  assert.ok(
    /:has\(video\)/.test(surface.selector),
    'the surface reset is not scoped to a video subtree'
  );
  assert.ok(
    /background-image:\s*initial\s*!important/.test(surface.body),
    'the status player is left with background-image: initial unset'
  );
  assert.ok(
    /background-color:\s*transparent\s*!important/.test(surface.body),
    'the panel tint is not cleared under the video surface'
  );

  const containment = ruleFor(css, 'contain: none');
  for (const [property, value] of [
    ['backdrop-filter', 'none'],
    ['-webkit-backdrop-filter', 'none'],
  ]) {
    assert.ok(
      new RegExp(`${property}:\\s*${value}\\s*!important`).test(containment.body),
      `the status player is left with ${property}: ${value} unset`
    );
  }
});

/**
 * Regression: status played as background audio with no picture.
 *
 * The opt-out used to name three containers while the pane rule reaches five
 * and the promotion rule six, so a player mounted anywhere else still got
 * backdrop-filter. Every one of transform / backdrop-filter / filter /
 * perspective / contain / will-change makes an element the containing block for
 * its fixed-position descendants, so a `position: fixed; inset: 0` player stops
 * resolving against the viewport and anchors to an inner box instead - silently,
 * because the video keeps decoding and only the picture disappears.
 *
 * Asserted against the pane and promotion selectors themselves rather than a
 * copied list, so adding a pane without adding it to the guard fails here.
 */
test('every container the sheet paints or promotes is video-guarded', () => {
  const css = generateMaskCSS(scheme, null, false);

  // The properties that re-anchor or hide a fixed overlay. Anything the sheet
  // sets on a container has to be undone when that container holds a video.
  const CONTAINING_BLOCK_PROPS = [
    'transform',
    'backdrop-filter',
    '-webkit-backdrop-filter',
    'filter',
    'perspective',
    'will-change',
    'contain',
    'backface-visibility',
  ];

  const guard = ruleFor(css, 'contain: none');
  const guarded = guard.selector
    .replace(/^:is\(/, '')
    .replace(/\):has\(video\)$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(guarded.length >= 8, `the guard covers only ${guarded.length} containers`);

  // Every selector in the sheet that paints or promotes a container.
  const targeted = new Set();
  for (const rule of parseRules(css)) {
    const hazardous = CONTAINING_BLOCK_PROPS.filter((p) =>
      new RegExp(`(?:^|\\s)${p}\\s*:\\s*(?!none|auto|visible)`).test(rule.body)
    );
    if (!hazardous.length) continue;
    for (const sel of rule.selector.split(',').map((s) => s.trim()).filter(Boolean)) {
      // Strip the guards and pseudos: what matters is the base selector.
      const base = sel
        .replace(/:not\([^)]*\)/g, '')
        .replace(/:has\([^)]*\)/g, '')
        .replace(/:is\([^)]*\)/g, '')
        .trim();
      if (base) targeted.add(base);
    }
  }

  assert.ok(targeted.size, 'no hazardous rules found, so this guard is measuring nothing');
  for (const sel of targeted) {
    assert.ok(
      guarded.includes(sel),
      `"${sel}" carries a containing-block property but is not in the video guard`
    );
  }
});

test('bubble ink clears its floor on the painted bubble, not the token', () => {
  // Bubbles are translucent over the panel. Hardening the token while painting
  // a composite can walk the painted surface back into the dead zone, and
  // checking ink against the opaque token would never notice - the token would
  // look perfect while the text shipped unreadable.
  // The mid-tone cases are the load-bearing ones: their tokens are chosen so
  // the dead zone is cleared in token space, and only the composite falls back
  // into it. A fixture set without them passes even when the hardening is
  // reverted to token-space, which is exactly the regression this guards.
  const cases = [
    ['fixture dark', scheme, false],
    ['synthesised light', lightScheme('fdf9ee', ['f6f2e7', 'f0ece1', 'eae6db', 'e4e0d5']), false],
    ['mid-tone bubbles', lightScheme('808080', ['8a8a8a', '949494', '9e9e9e', 'a8a8a8'], '777777'), false],
    ['mid-tone teal', lightScheme('6a8a86', ['7a9a96', '8aaaa6', '9abab6', 'aacac6'], '5f7f7b'), false],
    ['mid-tone everything', lightScheme('7a7a7a', ['8a8a8a', '949494', '9e9e9e', 'a8a8a8'], '8f8f8f'), false],
  ];
  // Glass over hostile overrides: an opaque mid-grey bubble on a dark page is
  // the combination where translucency visibly pulls the painted surface back
  // toward the dead zone, and the token itself still looks perfectly fine.
  const overrides = [
    ['near-opaque bubbles', { incoming: '808080', outgoing: '808080' }],
    ['pale bubbles on a dark scheme', { incoming: 'cccccc', outgoing: 'dddddd' }],
    ['dark bubbles on a light scheme', { incoming: '2a2a2a', outgoing: '1a1a1a' }],
  ];
  for (const [label, o] of overrides) {
    const palette = buildPalette(
      label.includes('light') ? lightScheme('fdf9ee', ['f6f2e7', 'f0ece1', 'eae6db', 'e4e0d5']) : scheme,
      o,
      false
    );
    const { incoming, outgoing } = painted(palette);
    for (const [name, bubble] of [
      ['incoming', incoming],
      ['outgoing', outgoing],
    ]) {
      const value = contrastRatio(palette.onBubble, bubble);
      const best = Math.max(contrastRatio(WHITE, bubble), contrastRatio(BLACK, bubble));
      assert.ok(
        value >= Math.min(CONTRAST.onBubble, best) - 0.05,
        `${label}/${name}: painted bubble gives ${value.toFixed(2)}:1, ` +
          `best possible ${best.toFixed(2)}:1 (floor ${CONTRAST.onBubble}:1)`
      );
    }
  }

  for (const [label, inputScheme, followSystem] of cases) {
    osDark = !followSystem;
    const palette = buildPalette(inputScheme, null, followSystem);
    const { incoming, outgoing } = painted(palette);
    for (const [name, bubble] of [
      ['incoming', incoming],
      ['outgoing', outgoing],
    ]) {
      const value = contrastRatio(palette.onBubble, bubble);
      const best = Math.max(
        contrastRatio(WHITE, bubble),
        contrastRatio(BLACK, bubble)
      );
      assert.ok(
        value >= Math.min(CONTRAST.onBubble, best) - 0.05,
        `${label}/${name}: painted bubble gives ${value.toFixed(2)}:1, ` +
          `best possible ${best.toFixed(2)}:1 (floor ${CONTRAST.onBubble}:1)`
      );
    }
  }
});

test('the accent clears its floor on the painted outgoing bubble', () => {
  // Read receipts are ticks on the outgoing bubble as composited, so the
  // accent has to be checked against the paint, not the token.
  const palette = buildPalette(scheme, null, false);
  const { outgoing } = painted(palette);
  const value = contrastRatio(palette.accentInk, outgoing);
  const best = Math.max(contrastRatio(WHITE, outgoing), contrastRatio(BLACK, outgoing));
  assert.ok(
    value >= Math.min(CONTRAST.accent, best) - 0.05,
    `accent is ${value.toFixed(2)}:1 on the painted outgoing bubble, best ${best.toFixed(2)}:1`
  );
});

test('conversation rule cannot repaint the compose bar', () => {
  // #main > div out-specifies the footer rule (ID beats type selector at any
  // source order), so the composer has to be excluded from it explicitly.
  const rule = ruleFor(generateMaskCSS(scheme, null, false), '#main > div');
  assert.ok(/:not\(:has\(footer\)\)/.test(rule.selector), 'footer is not excluded');
  assert.ok(
    /:not\(:has\(\[contenteditable="true"\]\)\)/.test(rule.selector),
    'composer is not excluded'
  );
});

test('bubbles match build-hashed class names', () => {
  // Some builds emit message-in-3f8ac1; a bare class selector cannot match it,
  // so the bubble rule needs both forms.
  //
  // Asserted against the bubble rule specifically, not the whole sheet. The
  // tail selectors also mention message-in, so a global substring check would
  // happily pass on those while the bubble fill went back to WhatsApp's green.
  const rules = parseRules(generateMaskCSS(scheme, null, false));
  for (const dir of ['in', 'out']) {
    const bubble = rules.find(
      (r) => r.selector.includes('[data-id]') && r.selector.includes(`message-${dir}`)
    );
    assert.ok(bubble, `no bubble rule for message-${dir}`);
    assert.ok(
      bubble.selector.includes(`div[class*="message-${dir}"]`),
      `message-${dir} fill cannot reach a build-hashed class name`
    );
    assert.ok(
      bubble.selector.includes(`.message-${dir} > div`),
      `message-${dir} fill cannot reach the nested bubble div`
    );
    assert.ok(
      /background-color\s*:/.test(bubble.body),
      `message-${dir} bubble rule paints no fill at all`
    );
  }
});

test('tails take the bubble fill, not the ink colour', () => {
  // The wedge is part of the bubble. Painting it with the text colour is the
  // subtler version of the same green-leak bug.
  const p = buildPalette(scheme, null, false);
  const css = generateMaskCSS(scheme, null, false);
  for (const [dir, fill] of [
    ['in', p.incoming],
    ['out', p.outgoing],
  ]) {
    const rule = ruleFor(css, `div[class*="message-${dir}"] [data-icon^="tail-"]`);
    assert.ok(rule.body.includes(rgb(fill)), `message-${dir} tail is not the bubble fill`);
    assert.ok(
      !rule.body.includes(rgb(p.onBubble)),
      `message-${dir} tail uses the ink colour instead of the fill`
    );
  }
});

test('tails are forced on span, svg and path', () => {
  // Builds differ in where the fill lives: some inherit currentColor into the
  // svg, others hardcode it on the path. Missing either leaves a green wedge.
  const p = buildPalette(scheme, null, false);
  const css = generateMaskCSS(scheme, null, false);
  for (const [dir, fill] of [
    ['in', p.incoming],
    ['out', p.outgoing],
  ]) {
    const rule = ruleFor(css, `div[class*="message-${dir}"] [data-icon^="tail-"] svg`);
    assert.ok(rule.selector.includes('svg'), `message-${dir} svg not targeted`);
    assert.ok(rule.selector.includes('path'), `message-${dir} path not targeted`);
    assert.ok(rule.body.includes(rgb(fill)), `message-${dir} svg/path fill is wrong`);
  }
});

test('tail rules land after the blanket icon rule', () => {
  // The readability net paints every [data-icon] with body-secondary ink.
  // Source order has to agree with the cascade, not just rely on specificity.
  const css = generateMaskCSS(scheme, null, false);
  const rules = parseRules(css);
  const net = rules.findIndex((r) => r.selector.includes('body [data-icon]'));
  const tail = rules.findIndex((r) => r.selector.includes('[data-icon^="tail-"]'));
  assert.notStrictEqual(net, -1, 'icon readability net missing');
  assert.notStrictEqual(tail, -1, 'tail rules missing');
  assert.ok(net < tail, 'the icon readability net is painted after the tails and wins on order');
});

test('numeric overrides are clamped, not interpolated', () => {
  const payload = '9999px; } body { color: red';
  const css = generateMaskCSS(scheme, { blur: payload, opacity: '50', saturate: '9000' }, false);

  // The generated sheet legitimately contains a `body {` rule, so the check
  // has to be for the payload itself surviving, not for that selector.
  assert.ok(!css.includes(payload), 'payload echoed into the stylesheet');
  assert.ok(!css.includes('color: red'), 'injected declaration is live');
  assert.ok(/blur\(80px\)/.test(css), 'blur not clamped to 80px');
  assert.ok(/saturate\(400%\)/.test(css), 'saturate not clamped to 400%');
  // An alpha of 1 is emitted as opaque rgb(), so nothing should carry one.
  // Parse each rgba() properly: the alpha is the last component, and the
  // channel digits must not be mistaken for it.
  for (const match of css.matchAll(/rgba\(([^)]+)\)/g)) {
    const parts = match[1].split(',').map((p) => parseFloat(p.trim()));
    const alpha = parts[parts.length - 1];
    assert.ok(
      alpha > 0 && alpha <= 1,
      `alpha out of range in ${match[0]}: ${alpha}`
    );
  }
  assert.ok(!/NaN|undefined/.test(css));
});

test('token values cannot break out of the comment header', () => {
  const hostile = {
    ...scheme,
    name: 'x */ } body { color: red } /*',
    flavour: 'y */ .z { display: none } /*',
  };
  const clean = generateMaskCSS(scheme, null, false);
  const evil = generateMaskCSS(hostile, null, false);

  const body = (css) => css.slice(css.indexOf('*/') + 2);
  assert.strictEqual(body(evil), body(clean), 'stylesheet body changed: payload escaped the comment');
  assert.ok(!/display:\s*none/.test(body(evil)), 'injected rule is live');
});

test('hostile tokens are ignored, not applied', () => {
  const hostile = { mode: 'dark', colours: { ...scheme.colours, primary: 'cbca8e;}html{display:none' } };
  const css = generateMaskCSS(hostile, null, false);
  assert.ok(!/html\s*\{/.test(css), 'injected selector is live');
  assert.ok(!/cbca8e;\}/.test(css), 'hostile token reached the stylesheet');
});

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n${failures.length}/${total} FAILED:\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`\nall ${total} tests pass (${PALETTES.length} palettes verified against the painted result)`);
console.log(
  'expectations pinned to the dark fixture; live Caelestia scheme checked for parsing and contrast: ' +
    (liveScheme ? `"${liveScheme.name}" (${liveScheme.mode})` : 'not present')
);
