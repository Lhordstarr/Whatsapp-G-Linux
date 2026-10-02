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
  relativeLuminance,
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
      // The opaque disc the contact initials are drawn on, NOT the painted
      // bubble: there is no alpha in that stack at all.
      ['avatar ink', palette.onAvatar, CONTRAST.onBubble, [palette.incoming, palette.outgoing]],
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

/** Remove the named functional pseudo-class groups (`:not(`, `:has(`). */
function removeGroups(selector, names) {
  let out = '';
  for (let i = 0; i < selector.length; i++) {
    if (names.some((n) => selector.startsWith(n, i))) {
      let depth = 0;
      for (; i < selector.length; i++) {
        if (selector[i] === '(') depth++;
        else if (selector[i] === ')' && --depth === 0) break;
      }
      continue;
    }
    out += selector[i];
  }
  return out;
}

const stripNot = (s) => removeGroups(s, [':not(']);

/**
 * Remove `:not(...)` and `:has(...)` groups, leaving the container identity.
 *
 * These groups say when a rule applies, not which node it applies to, and the
 * two sides of the blur/guard comparison disagree on them by design: the blur
 * excludes `:not(:has(video))`, the guard arms on `:has(video)`, and the blur
 * may narrow further still. Comparing them raw would report a coverage gap
 * that does not exist - `[tabindex="-1"]:has(div[contenteditable="true"])`
 * looks unblurred-guarded until you notice the guard holds the far wider
 * `[tabindex="-1"]:has(video)`.
 */
const stripGuards = (s) => removeGroups(s, [':not(', ':has(']);

/**
 * Split a comma-separated selector list without cutting inside parentheses,
 * so `:is(a, b) > c, d` yields two selectors rather than three.
 */
function splitSelectorList(selector) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

/** The members of a leading `:is(...)`, with the wrapper stripped. */
function splitIsList(selector) {
  const sel = selector.trim();
  if (!sel.startsWith(':is(')) return [sel];
  // Walk to the paren that closes the :is(), rather than matching greedily -
  // these selectors routinely end in :not(:has(video)), and a greedy .* would
  // swallow that and report the rule as having no blur targets at all.
  let depth = 0;
  let close = -1;
  for (let i = 0; i < sel.length; i++) {
    if (sel[i] === '(') depth++;
    else if (sel[i] === ')' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1) return [sel];
  const inner = sel.slice(4, close);
  const tail = sel.slice(close + 1);
  return splitSelectorList(inner).map((part) => part + tail);
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
        .replace(/:is\(/g, '')
        .replace(/\)/g, '')
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
 * WhatsApp Design System tokens
 *
 * The chat list does not read the legacy token set this sheet has always
 * written. It resolves its colour through --WDS-* custom properties, and an
 * undeclared custom property has no value at all - it falls through to
 * whatever WhatsApp's own cascade computed. That failure is invisible in a
 * screenshot of the pane as a whole (the surfaces *are* themed) and obvious
 * once you look for it: stock WhatsApp green in the avatar rings.
 *
 * So these are pinned from the DOM. The list is what a real chat-list subtree
 * references, transcribed from the rendered markup rather than guessed from a
 * token name - a property invented from a plausible-looking name would satisfy
 * every test below while changing nothing on screen.
 * ------------------------------------------------------------------ */

/** Every custom property the :root rule declares, with its raw value. */
function customProps(css) {
  const root = parseRules(css).find((r) => r.selector === ':root');
  assert.ok(root, 'stylesheet has no :root rule');
  const props = new Map();
  for (const m of root.body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    props.set(m[1], m[2].trim());
  }
  return props;
}

const WDS_TOKENS = [
  '--WDS-content-deemphasized',
  '--WDS-components-outline-profile-photo',
  '--WDS-persistent-activity-indicator',
  '--WDS-systems-status-seen',
  '--WDS-components-profile-photo-surface-green',
  '--WDS-components-profile-photo-content-green',
  '--WDS-components-profile-photo-surface-cobalt',
  '--WDS-components-profile-photo-content-cobalt',
];

test('every WDS token the chat list reads is declared', () => {
  const props = customProps(generateMaskCSS(scheme, null, false));

  for (const name of WDS_TOKENS) {
    assert.ok(props.has(name), `${name} is read by the chat list but never declared`);

    // A declared-but-empty or var()-valued property is the same failure as an
    // undeclared one, and it is invisible to a plain "is it there" check.
    const value = props.get(name);
    assert.match(value, /^rgb\(/, `${name} resolves to "${value}", not a colour`);
    assert.ok(
      !/\b(?:var|initial|inherit|unset)\b/.test(value),
      `${name} defers to something else: "${value}"`
    );
    // Undeclared custom properties inherit through the cascade, so a value
    // without !important loses to anything WhatsApp sets on a closer ancestor.
    assert.ok(
      value.endsWith('!important'),
      `${name} can be overridden by WhatsApp's own cascade without !important`
    );
  }
});

test('WDS tokens are fed from the resolved palette, never a literal', () => {
  // If one of these is ever hand-written into the template it will keep
  // working, keep passing every contrast test, and stop following the scheme.
  const palette = buildPalette(scheme, null, false);
  const props = customProps(generateMaskCSS(scheme, null, false));
  const resolved = new Set(
    ['veil', 'panel', 'incoming', 'outgoing', 'primary', 'secondary', 'onBubble', 'onAvatar', 'accentInk'].map(
      (k) => rgb(palette[k])
    )
  );

  for (const name of WDS_TOKENS) {
    const value = props.get(name).replace(' !important', '');
    assert.ok(resolved.has(value), `${name} is "${value}", which is not a palette colour`);
  }
});

test('the status ring reads as a ring, not a solid disc', () => {
  // Two roles, two tokens. Asserting the two *colours* differ would be wrong:
  // a palette whose accent resolves onto its secondary ink is legitimate, and
  // WhatsApp's own ring collapses the same way. What must hold is that the
  // sheet wires them to different roles in the first place - a copy-paste that
  // pointed both at the accent would pass a distinctness check on some
  // palettes and fail on others.
  const palette = buildPalette(scheme, null, false);
  const props = customProps(generateMaskCSS(scheme, null, false));

  assert.strictEqual(props.get('--WDS-persistent-activity-indicator'), `${rgb(palette.secondary)} !important`);
  assert.strictEqual(props.get('--WDS-systems-status-seen'), `${rgb(palette.accentInk)} !important`);

  // The accent is also what the sheet already spends on read receipts and the
  // send button, so "seen" landing on it keeps one accent in the app.
  assert.ok(
    props.get('--accent') === props.get('--WDS-systems-status-seen'),
    'the seen token no longer matches the app accent'
  );
});

test('avatar ink is verified on the opaque disc, not the painted bubble', () => {
  // The whole reason onAvatar exists. Contact initials are drawn on an opaque
  // disc with no bubble alpha in the stack, so the painted-bubble ink is the
  // wrong reference for it - and on the live scheme the two disagree by enough
  // to matter: the painted reference lands under the 7:1 AAA floor that the
  // opaque one clears.
  const seen = [];
  let diverged = 0;

  for (const [, inputScheme, overrides, followSystem] of PALETTES) {
    osDark = !followSystem;
    const palette = buildPalette(inputScheme, overrides, followSystem);
    const worstFor = (ink) =>
      [palette.incoming, palette.outgoing].reduce((w, s) => Math.min(w, contrastRatio(ink, s)), Infinity);
    const worst = worstFor(palette.onAvatar);
    const best = bestAchievable(palette.primary, [palette.incoming, palette.outgoing]);
    assert.ok(
      worst >= Math.min(CONTRAST.onBubble, best) - 0.05,
      `avatar ink manages ${worst.toFixed(2)}:1 on the worst disc; the best any colour can do is ${best.toFixed(2)}:1`
    );

    if (rgb(palette.onAvatar) !== rgb(palette.onBubble)) {
      diverged += 1;
      seen.push({ opaque: worst, painted: worstFor(palette.onBubble) });
    }
  }

  // If the two never diverged, onAvatar would be a second name for onBubble
  // and the opaque reference would be untested - which is the failure this
  // whole field exists to prevent.
  assert.ok(
    diverged > 0,
    `onAvatar never differs from onBubble across ${PALETTES.length} palettes, so it is not testing anything new`
  );
  // And the divergence has to have cost something: at least one palette where
  // the ink that clears the opaque disc does NOT clear the floor once it is
  // measured against the painted bubble. Without that, borrowing onBubble
  // would have been correct and the extra field is noise.
  assert.ok(
    seen.some((s) => s.opaque >= CONTRAST.onBubble && s.painted < CONTRAST.onBubble),
    'onAvatar only ever diverges upward; borrowing onBubble would have been fine'
  );
});

test('chat-list ink is keyed on stable handles, not build hashes', () => {
  // WhatsApp's chat-list classes are build hashes and turn over on every
  // release; the data-testids have not. A selector written against either
  // hashed class in the transcribed markup would pass every other test here and
  // match nothing on the next build.
  const css = generateMaskCSS(scheme, null, false);

  for (const rule of parseRules(css)) {
    const hashed = rule.selector.match(/\.x[0-9a-z]{6,}/g);
    assert.ok(!hashed, `selector "${rule.selector}" is keyed on a build hash (${hashed})`);
  }

  const rule = ruleFor(css, '[data-testid="cell-frame-primary-detail"]');
  for (const testid of [
    'cell-frame-primary-detail',
    'cell-frame-secondary',
    'last-msg-status',
    'icon-unread-count',
    'icon-mentions',
    'chat-msg-symbol',
  ]) {
    assert.ok(rule.selector.includes(`[data-testid="${testid}"]`), `chat-list rule drops ${testid}`);
  }
  // The count text is a grandchild of the labelled wrapper, so naming only the
  // wrapper leaves the digits inheriting body ink.
  assert.ok(
    rule.selector.includes('[data-testid="icon-unread-count"] span'),
    'the unread count text is not reached'
  );

  // Colour only. A background or a filter here would put a containing-block
  // property on an unpromoted node, and the video guard above has no entry for
  // it - the generic guard test would catch that, but this says why the list
  // is allowed to be short.
  assert.match(rule.body.trim(), /^color:\s*rgb\([^)]+\)\s*!important;?$/, `chat-list rule sets more than ink: ${rule.body.trim()}`);
});

/* ------------------------------------------------------------------ *
 * Tint
 *
 * The tint exists because the palettes these tokens come from put almost no
 * chroma in their neutrals, which over a desktop wallpaper reads as neutral
 * grey however correct the palette is. The property that makes it affordable
 * is that it holds relative luminance: every guarantee in this file is a
 * contrast ratio, contrastRatio() reads luminance alone, so a tint that does
 * not move it cannot spend anything.
 * ------------------------------------------------------------------ */

const chroma = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);

/** Sweep the tint across a spread of colours and check what it may not move. */
test('the tint holds relative luminance', () => {
  const colours = [
    '#000000', '#ffffff', '#808080', '#130d09', '#281d17', '#1a120d',
    '#74482d', '#005c4b', '#f6b997', '#8c4d4b', '#00a884', '#d9fdd3',
  ];
  const hues = [0, 21.5, 120, 240, 359];

  for (const hex of colours) {
    const color = parseColor(hex);
    for (const amount of [0.1, 0.35, 0.6, 0.85, 1]) {
      for (const hue of hues) {
        const tinted = main.tintSurface(color, hue, amount);
        const drift = Math.abs(relativeLuminance(tinted) - relativeLuminance(color));
        // 24 bisection steps land well inside this; the tolerance is here to
        // catch an actual regression (a dropped step, a clamp that bites), not
        // to absorb a fuzzy fit.
        assert.ok(
          drift <= relativeLuminance(color) * 0.005 + 1e-4,
          `${hex} at tint ${amount} hue ${hue}: luminance drifted ${drift.toFixed(6)} (${relativeLuminance(color).toFixed(6)} -> ${relativeLuminance(tinted).toFixed(6)})`
        );
      }
    }
  }
});

test('the tint adds chroma, and only chroma', () => {
  // Dark neutrals are where the tint has headroom: a near-black has almost no
  // chroma to lose, so there is room to add some without touching luminance.
  for (const hex of ['#130d09', '#281d17', '#1a120d']) {
    const color = parseColor(hex);
    let previous = chroma(color);
    for (const amount of [0.2, 0.4, 0.6, 0.8, 1]) {
      const tinted = main.tintSurface(color, 21.5, amount);
      assert.ok(
        chroma(tinted) > previous,
        `${hex}: chroma fell from ${previous.toFixed(0)} to ${chroma(tinted).toFixed(0)} at tint ${amount}`
      );
      previous = chroma(tinted);
    }
  }
});

test('tint: 0 leaves the untinted path byte-identical', () => {
  // The regression guard for the whole feature. If tinting ever leaked into
  // the untinted path, every surface in the app would shift and none of the
  // other assertions here would notice - they all check contrast, and a shift
  // that holds luminance holds contrast too. So this compares raw values
  // against the scheme's own tokens rather than re-deriving an expectation.
  const off = buildPalette(scheme, { tint: 0 }, false);
  assert.strictEqual(rgb(off.veil), rgb(parseColor(scheme.colours.background)), 'veil');
  assert.strictEqual(rgb(off.incoming), rgb(parseColor(scheme.colours.surfaceContainerLow)), 'incoming');

  // And the helper is a pass-through at zero, not a round trip through HSL
  // that happens to land on the same numbers.
  const color = parseColor('202016');
  assert.deepStrictEqual(main.tintSurface(color, 59, 0), color);
});

test('the tint reaches the neutrals and stops at the outgoing bubble', () => {
  // primaryContainer is already the most saturated token a tonal scheme has,
  // and that bubble is the one place the app's own colour is meant to survive,
  // so it has to come through the tint untouched. Comparing across two tint
  // values rather than against the raw token: at tint 0 the tint is a no-op
  // everywhere, so asserting against the token says nothing about which
  // surfaces the tint was allowed to reach.
  const off = buildPalette(scheme, { tint: 0 }, false);
  const on = buildPalette(scheme, { tint: 1 }, false);

  for (const key of ['veil', 'panel', 'incoming']) {
    assert.notStrictEqual(rgb(on[key]), rgb(off[key]), `${key} was not tinted`);
  }
  assert.strictEqual(rgb(on.outgoing), rgb(off.outgoing), 'outgoing was tinted');
});

test('the tint costs no contrast budget', () => {
  // The point of holding luminance. If tinting moved it, the dead-zone escape
  // would spend alpha to compensate - which is exactly the trade the tint is
  // supposed to avoid - and the ink would have to move with it.
  const off = buildPalette(scheme, { tint: 0 }, false);
  const on = buildPalette(scheme, { tint: 1 }, false);

  assert.strictEqual(on.veil.a, off.veil.a, 'the veil gave up alpha to carry the tint');
  assert.strictEqual(on.panel.a, off.panel.a, 'the panel gave up alpha to carry the tint');

  for (const key of ['primary', 'secondary', 'onBubble', 'onAvatar', 'accentInk']) {
    assert.strictEqual(on[key].r, off[key].r, `${key} moved`);
    assert.strictEqual(on[key].g, off[key].g, `${key} moved`);
    assert.strictEqual(on[key].b, off[key].b, `${key} moved`);
  }

  // And the surfaces the tint DOES move must still clear their floors, on the
  // painted result, at the maximum tint rather than at the default.
  const surfaces = painted(on);
  assert.ok(contrastRatio(on.primary, surfaces.page) >= CONTRAST.primary);
  assert.ok(contrastRatio(on.primary, surfaces.panel) >= CONTRAST.primary);
  assert.ok(contrastRatio(on.secondary, surfaces.panel) >= CONTRAST.secondary);
  assert.ok(contrastRatio(on.onBubble, surfaces.incoming) >= CONTRAST.onBubble);
  assert.ok(contrastRatio(on.onBubble, surfaces.outgoing) >= CONTRAST.onBubble);
  assert.ok(contrastRatio(on.panel, surfaces.page) >= CONTRAST.panelSep);
});

test('the tint reaches the glass surfaces', () => {
  // A tint that only moved the bubbles would leave the complaint exactly where
  // it started: the page and the panes are the surfaces drawn over the
  // wallpaper, so they are the ones that show the desktop's colour instead of
  // the scheme's.
  const off = painted(buildPalette(scheme, { tint: 0 }, false));
  const on = painted(buildPalette(scheme, { tint: 1 }, false));
  assert.ok(chroma(on.page) > chroma(off.page), `page chroma ${chroma(off.page).toFixed(0)} -> ${chroma(on.page).toFixed(0)}`);
  assert.ok(chroma(on.panel) > chroma(off.panel), `panel chroma ${chroma(off.panel).toFixed(0)} -> ${chroma(on.panel).toFixed(0)}`);
});

test('the tint falls back rather than failing on junk', () => {
  // colors.json is hand-written. `tint` and `tintColor` are read from it, so
  // both have to survive a typo without taking the palette down with them.
  for (const overrides of [{ tint: 'abc' }, { tint: null }, { tint: -5 }, { tint: 99 }, { tintColor: 'zzz' }]) {
    const p = buildPalette(scheme, overrides, false);
    assert.ok(Number.isFinite(p.veil.a) && Number.isFinite(p.veil.r), `junk ${JSON.stringify(overrides)} broke the veil`);
    assert.ok(chroma(painted(p).panel) > 0);
  }
});

test('a light scheme keeps a legible page when tinted', () => {
  // Light mode is where the tint has the least room: near a fixed luminance of
  // white the sRGB gamut carries very little chroma, so the veil barely moves
  // and the panel does. That is arithmetic, not a bug - but it must not cost
  // legibility on the way, which the default does apply.
  const light = lightScheme('fdf9ee', ['f6f2e7', 'f0ece1', 'eae6db', 'e4e0d5']);
  for (const amount of [0, 0.6, 1]) {
    const p = buildPalette(light, { tint: amount }, false);
    const s = painted(p);
    assert.ok(contrastRatio(p.primary, s.page) >= CONTRAST.primary, `page at tint ${amount}`);
    assert.ok(contrastRatio(p.primary, s.panel) >= CONTRAST.primary, `panel at tint ${amount}`);
    assert.ok(contrastRatio(p.panel, s.page) >= CONTRAST.panelSep, `separation at tint ${amount}`);
  }
});

test('the sidebar pane carries the blur under its current id', () => {
  // The pane was renamed #side -> #pane-side. Nothing about that rename is
  // loud: the sheet keeps parsing, every other assertion here still passes,
  // and the only symptom is that the sidebar quietly stops being glass and
  // falls back to whatever the host paints. That is the failure this pins.
  const rule = ruleFor(generateMaskCSS(scheme, null, false), '#pane-side');
  assert.ok(
    /backdrop-filter:\s*blur\(/.test(rule.body),
    'the sidebar pane is named but carries no blur, so it is not glass'
  );
  assert.ok(
    /background-color/.test(rule.body),
    'the sidebar pane is named but has no surface of its own'
  );
});

test('every blurred pane is also covered by the video guard', () => {
  // OVERLAY_CONTAINERS exists so that a selector added to a blur rule cannot
  // be forgotten in the guard. Asserting the two lists agree is what keeps
  // that comment honest: the moment one gains a selector the other does not, a
  // video inside that pane gets blurred and then re-anchored off-screen.
  const rules = parseRules(generateMaskCSS(scheme, null, false));

  const blurred = [];
  for (const rule of rules) {
    if (!/backdrop-filter:\s*blur\(/.test(rule.body)) continue;
    for (const sel of splitSelectorList(stripGuards(rule.selector))) {
      for (const part of splitIsList(sel)) blurred.push(part);
    }
  }
  assert.ok(blurred.length, 'nothing carries a blur at all');

  // The guard is the rule that arms *on* a video. The other none-rule in the
  // sheet is a :not(:has(video)) exclusion, which suppresses nothing on its
  // own - matching it here would make this pass vacuously. Strip :not() first,
  // since the substring :has(video) occurs inside the exclusion too.
  const guard = rules.find(
    (r) =>
      /backdrop-filter:\s*none\s*!important/.test(r.body) &&
      /:has\(video\)/.test(stripNot(r.selector))
  );
  assert.ok(guard, 'no rule suppresses the blur for panes holding a video');
  const guarded = new Set(
    splitSelectorList(guard.selector).flatMap((s) => splitIsList(s)).map(stripGuards)
  );
  for (const sel of blurred) {
    assert.ok(
      guarded.has(sel),
      `${sel} is blurred but absent from the video guard, so a video there is silently re-anchored`
    );
  }
});

test('the search rules survive the host restacking its own wrappers', () => {
  // Two dumps of the same search field, weeks of WhatsApp apart, differ by two
  // wrapper divs and seven classes on the container. Anything written as a
  // structural path - `> div > div input`, or the hashed classes on the way
  // down - would match on one build and silently match nothing on the other,
  // which is the same failure as keying on a build hash and just as quiet. The
  // anchor is the stable testid and every step after it is a descendant step,
  // so the depth the host happens to use is not this sheet's problem.
  const css = generateMaskCSS(scheme, null, false);
  const rules = parseRules(css).filter((r) => /chat-list-search-container/.test(r.selector));
  assert.ok(rules.length >= 2, `expected both search rules, found ${rules.length}`);
  for (const rule of rules) {
    for (const sel of splitSelectorList(rule.selector)) {
      assert.ok(
        /chat-list-search-container"\]\s*\S/.test(sel),
        `${sel} is not anchored on the search container's testid`
      );
      assert.ok(
        !/[>+~]/.test(sel),
        `${sel} walks the host's nesting positionally, so a restack breaks it`
      );
    }
  }
});

test('the search field text is named, because a form control cannot inherit', () => {
  // Measured: rgb(255,255,255), the UA's fieldtext - brighter than any ink the
  // palette defines and the same in every scheme. A form control has a colour
  // set on it directly, so no ancestor's declaration reaches it; the input has
  // to be a target. Typed text is what you came to read, so body ink.
  const css = generateMaskCSS(scheme, null, false);
  const p = buildPalette(scheme, null, false);
  const rule = ruleFor(css, 'search-container"] input');
  assert.ok(rule, 'the search input is named by no rule at all');
  assert.ok(rule.body.includes(rgb(p.primary)), 'typed text is not body ink');
});

test('the search placeholder has a rule of its own, on the right surface', () => {
  // ::placeholder is not inherited - it is a separate UA declaration - so
  // naming the input does nothing for it. Left alone it measured
  // rgb(117,117,117): a fixed grey, about 4.2:1 on the pane, under the AA
  // floor for text this size and identical in every scheme because it never
  // consults one. Assert the rule exists *and* is anchored to the search
  // container, because a bare ::placeholder would repaint every placeholder on
  // every surface in the app, including ones this sheet has not measured.
  const css = generateMaskCSS(scheme, null, false);
  const p = buildPalette(scheme, null, false);
  const rule = ruleFor(css, '::placeholder');
  assert.ok(rule, 'the placeholder has no rule, so it keeps the UA grey');
  assert.ok(
    /search-container"\]\s*input::placeholder$/.test(rule.selector.trim()),
    `the placeholder rule is not scoped to the search field: ${rule.selector.trim()}`
  );
  assert.ok(rule.body.includes(rgb(p.secondary)), 'the placeholder is not supporting ink');
});

test('the filter bar gets palette ink, and the selected tab reads as primary', () => {
  // All five measured rgb(255,255,255) - the UA fieldtext - along with every
  // label, both counts and the chevron. The pane header rule is scoped to the
  // pane's direct children on purpose, and these sit five and six levels down,
  // so this is a separate rule rather than an oversight in that one.
  const css = generateMaskCSS(scheme, null, false);
  const p = buildPalette(scheme, null, false);
  const base = ruleFor(css, 'chat-list-filters');
  assert.ok(base, 'the filter bar is named by no rule at all');
  assert.ok(base.body.includes(rgb(p.secondary)), 'unselected filter tabs are not supporting ink');

  // One undifferentiated strip would drop the distinction the host draws with
  // colour, so the selected tab is promoted. Keyed on aria-selected, which is
  // in the markup rather than inferred from a class.
  const selected = ruleFor(css, 'aria-selected="true"');
  assert.ok(selected, 'no rule distinguishes the selected filter tab');
  assert.ok(selected.body.includes(rgb(p.primary)), 'the selected filter tab is not body ink');
});

test('the filter bar keeps both handles, because neither one covers all five buttons', () => {
  // The host wraps these inconsistently. The overflow chevron
  // (additional-filters) sits outside any filter-button wrapper, and the Groups
  // entry in the overflow menu (label_item_3) carries no aria-controls at all.
  // Either handle alone leaves exactly one button back on the UA's white
  // fieldtext, and nothing else in the suite would notice - so name which one
  // goes missing, rather than just that something did.
  const rule = ruleFor(generateMaskCSS(scheme, null, false), 'chat-list-filters');
  const targets = splitSelectorList(rule.selector).flatMap((s) => splitIsList(s));
  assert.ok(
    targets.some((s) => /\[aria-label="chat-list-filters"\] button/.test(s)),
    'the tablist-label handle is gone, so additional-filters (the overflow chevron) is unthemed again'
  );
  assert.ok(
    targets.some((s) => /\[data-testid="filter-button"\] button/.test(s)),
    'the filter-button handle is gone, so label_item_3 (Groups, in the overflow menu) is unthemed again'
  );
  // Same reasoning as the search field: the host is free to restack these, and
  // a positional selector would match on one build and nothing on the next.
  for (const sel of targets) {
    assert.ok(!/[>+~]/.test(sel), `${sel} walks the host's nesting positionally`);
  }
});

test('the pane header buttons get ink, and the label span is named too', () => {
  // Measured in a real browser: nothing in the sheet named a <button>, so the
  // label resolved to rgb(0,0,0) - black ink on a dark panel. The label text
  // sits one level below the button inside a [role="group"] wrapper with no
  // colour set in between, so naming only the button would leave the text
  // exactly where it was.
  const rule = ruleFor(generateMaskCSS(scheme, null, false), '> button');
  const p = buildPalette(scheme, null, false);
  assert.ok(
    rule.body.includes(rgb(p.primary)),
    'the pane header buttons are not painted in primary ink'
  );
  assert.ok(
    rule.selector.includes('> button span'),
    'the label span inside the button is not named, so the text is left unstyled'
  );
});

test('the pane header button rule cannot reach a nested button', () => {
  // A bare `button` selector would also claim the composer, the attach and
  // emoji pickers and the send button, each of which already carries ink of
  // its own. The direct-child combinator off a pane id is the entire reason
  // the rule is safe, so pin both halves of it rather than trust either.
  const rule = ruleFor(generateMaskCSS(scheme, null, false), '> button');
  const selectors = splitSelectorList(rule.selector).flatMap((s) => splitIsList(s));
  assert.ok(selectors.length, 'no button selector found to check');
  for (const sel of selectors) {
    const anchor = sel.match(/^(.*?)>\s*button(.*)$/);
    assert.ok(anchor, `${sel} does not anchor on a direct-child button`);
    assert.ok(
      /#(side|pane-side)$/.test(anchor[1].trim()),
      `${sel} is not anchored directly to the pane id`
    );
    // The only thing allowed to follow is the label span itself. Anything with
    // a second combinator, a descendant step, or a compound class chain would
    // be reaching past the pane's own header buttons into a nested control.
    assert.ok(
      /^\s*(span|\[[^\]]+\])?$/.test(anchor[2]),
      `${sel} reaches past the pane's own header buttons into a nested control`
    );
  }
});

test('the encryption footer and its link are two different inks', () => {
  // The notice is supporting text, so it is secondary. The link is the one
  // colour in the sidebar that the host resolves on its own terms - it is an
  // <a>, so on a build that routes links through --teal it already agrees,
  // and on a build that does not, naming the element is the only thing
  // pinning it. Collapsing the two would leave a footnote-coloured link, or
  // a body-coloured one, and the second is what the user sees.
  const css = generateMaskCSS(scheme, null, false);
  const p = buildPalette(scheme, null, false);
  const notice = ruleFor(css, 'chatlist-e2e-message"]');
  const link = ruleFor(css, 'chatlist-e2e-message-link"]');
  assert.notStrictEqual(link.selector, notice.selector, 'notice and link share one rule');
  assert.ok(notice.body.includes(rgb(p.secondary)), 'the footer notice is not secondary ink');
  assert.ok(link.body.includes(rgb(p.accentInk)), 'the footer link is not the accent');
});

test('the row context chevron is named in its own right, not left to its cell', () => {
  // The chevron sits inside cell-frame-secondary, which this sheet already
  // names - so it reads as covered and is not. It is a <button>, and the UA
  // stylesheet puts a colour on form controls directly; a declaration on the
  // element beats an inherited one however specific the ancestor's selector is.
  // Measured, it was rgb(0,0,0) while its parent cell was already on-token.
  // So the selector has to be a target of the rule in its own right: adding it
  // to the list is the fix, and inheriting from the cell is not.
  const rule = ruleFor(generateMaskCSS(scheme, null, false), 'context-btn');
  assert.ok(rule, 'the row context chevron is named by no rule at all');
  const targets = splitSelectorList(rule.selector).flatMap((s) => splitIsList(s));
  assert.ok(
    targets.includes('[data-testid="context-btn"]'),
    `the chevron is only reached by inheritance, which the UA beats: ${rule.selector.trim()}`
  );
  assert.ok(
    rule.body.includes(rgb(buildPalette(scheme, null, false).secondary)),
    'the chevron is not supporting ink'
  );
});

test('the chevron is not folded into the pane header button rule', () => {
  // The header buttons are scoped by position - direct children of the pane -
  // precisely so a blanket `button` selector cannot flatten the composer, the
  // attach and emoji pickers and the send button, each of which carries ink of
  // its own. A row chevron is not a header control, so it belongs to the row
  // rules; parking it in the header rule would be the same overreach by
  // another route, and the scoping is the part worth protecting.
  const header = ruleFor(generateMaskCSS(scheme, null, false), '> button');
  assert.ok(
    !/context-btn/.test(header.selector),
    `the chevron is being coloured by the header rule: ${header.selector.trim()}`
  );
});

test('nothing in the chat list resolves to a colour that is not a token', () => {
  // The failure this catches is not a wrong hue, it is an unnamed element:
  // anything the sheet does not name falls through to the host or the UA, and
  // a subtree of build-hashed classes has a lot of room for that to happen
  // without any assertion noticing. Every ink the sheet emits for this
  // subtree has to be one the palette actually defines.
  const p = buildPalette(scheme, null, false);
  const known = new Set(
    [p.primary, p.secondary, p.accentInk, p.outgoing, p.incoming, p.onAvatar]
      .map((c) => rgb(c))
  );
  const rules = parseRules(generateMaskCSS(scheme, null, false));
  for (const rule of rules) {
    if (!/chat|list|bubble|footer|pane|button|e2e|mentions|unread|last-msg|cell-frame/.test(rule.selector)) {
      continue;
    }
    const m = rule.body.match(/color:\s*(rgb\([^)]*\))/g);
    if (!m) continue;
    for (const decl of m) {
      const value = decl.replace(/color:\s*/, '').trim();
      assert.ok(
        known.has(value),
        `${rule.selector.trim()} paints ${value}, which is not a palette ink`
      );
    }
  }
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
