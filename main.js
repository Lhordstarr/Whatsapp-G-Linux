'use strict';

/**
 * WhatsApp Glass Native
 * ------------------------------------------------------------------
 * Electron shell around WhatsApp Web themed from the live Caelestia
 * (Material 3) colour scheme, with contrast guarantees and desktop
 * appearance sync.
 *
 * Palette resolution, in priority order:
 *   1. ~/.local/state/caelestia/scheme.json   (the live Material 3 scheme)
 *   2. ./colors.json                          (optional hand-tweaks on top)
 *   3. built-in WhatsApp defaults
 *
 * Then every text token is contrast-checked against every surface it can
 * land on and blended until it clears its WCAG floor. Caelestia palettes are
 * well built, but a wallpaper-driven scheme can still put `onSurfaceVariant`
 * or `primary` too close to a bubble background, and that is the failure this
 * file exists to prevent.
 */

const { app, BrowserWindow, nativeTheme, shell } = require('electron');
const path = require('path');
const fs = require('fs');

/* ================================================================== *
 * Paths & constants
 * ================================================================== */

const CAELESTIA_SCHEME_PATH = path.join(
  app.getPath('home'),
  '.local/state/caelestia/scheme.json'
);
const OVERRIDE_FILE = path.join(__dirname, 'colors.json');

const STYLE_ID = 'whatsapp-glass-mask';
const TARGET_ORIGIN = 'https://web.whatsapp.com';
const WINDOW = { width: 1280, height: 850 };

/**
 * Safari user-agent, sent instead of the real Chromium one.
 *
 * This is a string, not an engine: Electron embeds Chromium and that cannot be
 * swapped, so the page is still rendered by Blink. The point is to make
 * WhatsApp Web serve the Safari build - the layout it was designed against -
 * rather than to get WebKit behaviour. Anything that depends on real WebKit
 * will not appear.
 *
 * `sec-ch-ua` client hints are rewritten to match (see applySafariUA): a Safari
 * UA next to Chromium's `sec-ch-ua` is a contradiction, and the hint headers
 * take precedence for capability detection on several CDNs.
 */
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.4 Safari/605.1.15';

/** Client hints that contradict a Safari UA and have to be replaced. */
const SAFARI_SEC_CH_UA = '" Not A;Brand";v="99", "Safari";v="17"';
const SAFARI_SEC_CH_UA_MOBILE = '?0';
const SAFARI_SEC_CH_UA_PLATFORM = '"macOS"';

const DEBOUNCE_MS = 120; // editors fire several events per save
const POLL_MS = 2000; // safety net for editors that replace the inode
const LOG_TAIL = 4;

/** WCAG floors: AAA for body/bubble text, AA for supporting text. */
const CONTRAST = {
  primary: 7,
  secondary: 4.5,
  onBubble: 7,
  accent: 4.5,
};

/**
 * Minimum separation between a glass panel and the page behind it.
 * Material 3 tonal palettes run deliberately flat (surface == background),
 * so we walk the elevation ladder for the first tier that reads as a panel.
 */
const MIN_PANEL_SEPARATION = 1.15;

/**
 * How translucent the message bubbles are painted over the blurred pane.
 *
 * buildPalette hardens and verifies bubble ink against the bubble composited
 * at exactly this alpha (see bubbleFor), so the contrast guarantee holds on
 * the painted surface and not merely on the opaque token. Measured drift from
 * the opaque-token result is ~0.5:1, which is why the palette code cannot
 * simply keep checking the token.
 *
 * Near-opaque by intent: bubbles read as glass mostly through the pane behind
 * them, and a very transparent fill buys little while putting bubble ink at
 * the mercy of whatever is on the desktop wallpaper.
 */
const BUBBLE_ALPHA = 0.94;

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

/** Ordered low -> high elevation. Works in light and dark schemes alike. */
const ELEVATION_LADDER = [
  'surfaceContainerLow',
  'surfaceContainer',
  'surfaceContainerHigh',
  'surfaceContainerHighest',
  'surfaceBright',
  'surfaceVariant',
];

/* ================================================================== *
 * Colour maths
 * ================================================================== */

const NAMED_COLORS = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: WHITE,
  black: BLACK,
};

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Parse a colour into { r, g, b, a }.
 *
 * Caelestia writes tokens as BARE 6-digit hex ("0f0e08", no '#'), so bare
 * hex is the primary format here. #rgb / #rgba / #rrggbb / #rrggbbaa /
 * rgb() / rgba() and a few keywords are accepted too.
 *
 * Returns null on anything unrecognised so callers fall back to a known-good
 * default instead of emitting broken CSS.
 */
function parseColor(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, raw)) {
    return { ...NAMED_COLORS[raw] };
  }

  const isHashPrefixed = raw[0] === '#';
  if (isHashPrefixed || /^[0-9a-f]+$/.test(raw)) {
    let hex = isHashPrefixed ? raw.slice(1) : raw;
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    }
    if (hex.length !== 6 && hex.length !== 8) return null;
    if (!/^[0-9a-f]+$/.test(hex)) return null;

    const packed = parseInt(hex.slice(0, 6), 16);
    return {
      r: (packed >> 16) & 255,
      g: (packed >> 8) & 255,
      b: packed & 255,
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }

  const fn = raw.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;

    const channel = (token) =>
      token.endsWith('%') ? (parseFloat(token) / 100) * 255 : parseFloat(token);

    const [r, g, b] = parts.slice(0, 3).map(channel);
    if (![r, g, b].every((v) => Number.isFinite(v))) return null;

    let a = 1;
    if (parts.length >= 4) {
      a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    }

    return {
      r: clamp(r, 0, 255),
      g: clamp(g, 0, 255),
      b: clamp(b, 0, 255),
      a: clamp(Number.isFinite(a) ? a : 1, 0, 1),
    };
  }

  return null;
}

function toLinear(channel) {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance. */
function relativeLuminance({ r, g, b }) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.1 contrast ratio, 1..21. */
function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Per-channel blend in sRGB, the same space CSS color-mix() uses. */
function mix(from, to, amount) {
  const t = clamp(amount, 0, 1);
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
    a: from.a + (to.a - from.a) * t,
  };
}

/** Flatten a translucent layer onto an opaque one to get the real backdrop. */
function composite(over, under) {
  const a = clamp(over.a, 0, 1);
  return {
    r: over.r * a + under.r * (1 - a),
    g: over.g * a + under.g * (1 - a),
    b: over.b * a + under.b * (1 - a),
    a: 1,
  };
}

function toRgbString({ r, g, b }) {
  return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
}

function toRgbaString({ r, g, b, a }) {
  if (a >= 1) return toRgbString({ r, g, b });
  const alpha = Math.round(clamp(a, 0, 1) * 1000) / 1000;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

/* ================================================================== *
 * Palette assembly
 * ================================================================== */

/** Pick a user/M3 token when it parses, else the supplied fallback. */
function resolveTint(source, fallback) {
  return parseColor(source) || parseColor(fallback);
}

/** Numeric slider that clamps junk rather than trusting the file. */
function resolveNumber(value, fallback, lo, hi) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, lo, hi);
}

/**
 * Strip anything that could terminate a CSS comment.
 *
 * The scheme name and the chosen panel token are interpolated into a comment
 * header for diagnostics, and both come from a file another process writes.
 * A name containing a comment terminator would otherwise close the comment
 * early and let its contents be parsed as live CSS.
 */
function commentSafe(value) {
  return typeof value === 'string' ? value.replace(/[*/\r\n]+/g, '').trim() : '';
}

/**
 * Choose a panel colour with real elevation.
 *
 * `surface` is never usable on its own: Caelestia sets surface == background
 * in most tonal schemes, which renders the sidebar, header and chat area in
 * one flat colour. Walk the elevation ladder for the first tier that
 * separates from the page background, falling back to the highest tier.
 *
 * If no tier in the palette separates far enough - light tonal schemes are
 * very flat at the low end - blend the closest tier away from the background
 * until it does. Glass needs *some* tonal difference to read as a panel.
 *
 * The reference is the solid background token, deliberately *not* the
 * wallpaper composite. Elevation describes the relationship between the panel
 * and the page it sits on; the wallpaper only matters for text legibility.
 */
function choosePanel(tokens, pageBackground) {
  const away = pole(pageBackground); // white on a dark page, black on a light one

  let best = null;
  for (const key of ELEVATION_LADDER) {
    const tier = parseColor(tokens[key]);
    if (!tier) continue;

    const ratio = contrastRatio(tier, pageBackground);
    if (ratio >= MIN_PANEL_SEPARATION) return { color: tier, token: key };

    if (!best || ratio > best.ratio) best = { color: tier, token: key, ratio };
  }

  // Nothing in the palette separates enough: nudge the closest tier away from
  // the background until it does.
  if (best) {
    for (let step = 0.1; step <= 1.0001; step += 0.1) {
      const lifted = mix(best.color, away, step);
      if (contrastRatio(lifted, pageBackground) >= MIN_PANEL_SEPARATION) {
        return { color: lifted, token: `${best.token} (lifted)` };
      }
    }
  }

  return { color: mix(pageBackground, away, 0.12), token: 'synthesised' };
}

/**
 * Pull a panel back onto the page's side of the tonal mid-point.
 *
 * Body text is a single colour on both the page and the panel, so those two
 * surfaces have to want the same ink pole. A panel that crosses the mid-point
 * away from the page - a pale sidebar on a near-black page - removes that
 * option: white reaches 8:1 on the page and 2:1 on the panel, black is the
 * reverse, and no single value clears the floor on both. Elevation ladders
 * that sit beside the background never do this, but a wallpaper-driven scheme
 * or a hand-written `colors.json` can, and the surface that pays for it is the
 * page.
 *
 * Two conditions, not one. Separation alone is not enough: a panel can clear
 * MIN_PANEL_SEPARATION while sitting in the dead zone, where it is on the right
 * side of the mid-point but too close to the page's own tone for *any* ink to
 * reach the body floor. rgb(114) over rgb(89) separates at 1.47:1 and tops out
 * at 4.8:1 - separated, and still unreadable. So a candidate has to both read
 * as a panel and leave room for legible ink, which is the same escape
 * hardenSurface gives the page.
 *
 * Searches alpha and lift together, preferring the least alteration that
 * satisfies both. Failing that, the best partial on-side candidate wins:
 * losing the panel's edge is better than losing body text, and on-side is
 * non-negotiable.
 */
function alignPanelToPage(panelPick, pageBackdrop, readabilityPole) {
  const pageIsDark = isDarkSurface(pageBackdrop);
  const toward = pole(readabilityPole); // into the page's own tonal family

  let fallback = null;
  for (let alpha = 0.45; alpha <= 1.0001; alpha += 0.05) {
    for (let step = 0; step <= 1.0001; step += 0.05) {
      const candidate = { ...mix(panelPick.color, toward, step), a: Math.min(alpha, 1) };
      const painted = composite(candidate, pageBackdrop);
      if (isDarkSurface(painted) !== pageIsDark) continue;

      const separation = contrastRatio(painted, pageBackdrop);
      const reachable = Math.max(contrastRatio(WHITE, painted), contrastRatio(BLACK, painted));
      // Normalised so neither requirement can outweigh the other.
      const score = Math.min(separation / MIN_PANEL_SEPARATION, reachable / CONTRAST.primary);

      if (score >= 1) return { panel: candidate, panelBackdrop: painted };
      if (!fallback || score > fallback.score) {
        fallback = { panel: candidate, panelBackdrop: painted, score };
      }
    }
  }
  return fallback;
}

/** Whichever pole contrasts with `color`, for pushing it off the background. */
function pole(color) {
  return isDarkSurface(color) ? WHITE : BLACK;
}

/**
 * Push a surface out of the mid-tone dead zone.
 *
 * Between roughly 0.18 and 0.45 luminance, neither white nor black text can
 * reach 4.5:1 - the far pole is simply too close. A mid-grey bubble is
 * unusable at any text colour, so the surface itself has to move toward the
 * page's pole before its ink can be made legible. Returns the original colour
 * untouched when one of the poles would already have worked.
 */
function hardenSurface(surface, referencePole, target) {
  const reachable = Math.max(
    contrastRatio(WHITE, surface),
    contrastRatio(BLACK, surface)
  );
  if (reachable >= target) return surface;

  for (let step = 0.05; step <= 1.0001; step += 0.05) {
    const candidate = mix(surface, referencePole, step);
    const best = Math.max(contrastRatio(WHITE, candidate), contrastRatio(BLACK, candidate));
    if (best >= target) return { ...candidate, a: 1 };
  }
  return referencePole;
}

/**
 * Invert `composite()`: find the veil that paints `backdrop` over `wallpaper`.
 *
 * Keeps the transparency budget where it can - prefer the requested alpha, and
 * only climb toward opaque when the maths cannot otherwise land. If even a
 * fully opaque veil cannot reproduce the target (a backdrop lighter or darker
 * than both colour and wallpaper allow), fall back to painting it directly.
 */
function veilFor(backdrop, wallpaper, preferredAlpha) {
  for (let alpha = clamp(preferredAlpha, 0, 1); alpha <= 1.0001; alpha += 0.05) {
    const a = Math.min(alpha, 1);
    if (a <= 0) continue;
    const channels = ['r', 'g', 'b'].map((key) => (backdrop[key] - wallpaper[key] * (1 - a)) / a);
    if (!channels.every((v) => v >= -0.5 && v <= 255.5)) continue;

    const color = {
      r: clamp(channels[0], 0, 255),
      g: clamp(channels[1], 0, 255),
      b: clamp(channels[2], 0, 255),
    };
    const painted = composite({ ...color, a }, wallpaper);
    if (
      Math.abs(painted.r - backdrop.r) < 0.6 &&
      Math.abs(painted.g - backdrop.g) < 0.6 &&
      Math.abs(painted.b - backdrop.b) < 0.6
    ) {
      return { ...color, a };
    }
  }

  // Unreachable within the transparency budget: paint the backdrop itself.
  // The blur still samples the desktop, so the glass look survives.
  return { r: backdrop.r, g: backdrop.g, b: backdrop.b, a: 1 };
}

/**
 * Which appearance the tokens actually describe.
 *
 * The declared mode string is not trustworthy on its own: `followSystem` can
 * ask for light while Caelestia still has dark tokens on disk. Deciding from
 * the background's own luminance is self-healing - the pole and color-scheme
 * always agree with the colours that will actually be painted.
 */
const DARK_LUMINANCE_CUTOFF = 0.18;

function isDarkSurface(color) {
  return relativeLuminance(color) < DARK_LUMINANCE_CUTOFF;
}

/**
 * Build the resolved, contrast-checked palette.
 *
 * `wallpaper` is the pessimistic backdrop assumption - bright behind dark
 * mode, dark behind light mode. Checking contrast against that composite is
 * what makes legibility independent of the desktop wallpaper.
 */
function buildPalette(scheme, overrides, followSystem) {
  const tokens = (scheme && scheme.colours) || {};

  // 1. Appearance. Caelestia pins a resolved mode, but the OS wins when the
  //    scheme is unpinned (or the user opts into it) - and the background's
  //    own luminance gets the final say, so tokens and color-scheme can never
  //    disagree. A dark scheme forced into light mode is the failure that
  //    would otherwise produce black text on a near-black panel.
  const schemeMode = typeof scheme?.mode === 'string' ? scheme.mode.toLowerCase() : '';
  const schemePinned = schemeMode === 'dark' || schemeMode === 'light';
  const requestedDark = !schemePinned || followSystem ? nativeTheme.shouldUseDarkColors : schemeMode === 'dark';

  // 2. Surfaces. bg -> veil -> panel, matching what actually gets painted.
  const o = overrides || {};
  const bg = resolveTint(o.bg ?? tokens.background, requestedDark ? '#0b0e11' : '#f0f2f5');

  // The tokens decide the appearance, not the requested mode.
  const isDark = isDarkSurface(bg);
  const mode = isDark ? 'dark' : 'light';
  const wallpaper = isDark ? WHITE : BLACK;

  const veilAlpha = resolveNumber(o.veil, isDark ? 0.74 : 0.86, 0, 1);
  const panelAlpha = resolveNumber(o.opacity, isDark ? 0.55 : 0.72, 0.05, 1);
  const blur = Math.round(resolveNumber(o.blur, 20, 0, 80));
  const saturate = resolveNumber(o.saturate, 180, 100, 400);

  // Text is measured against this composite, and the composite can land
  // mid-tone even when the scheme itself is not: an 0.86 veil of mid grey over
  // a black wallpaper is still mid grey, where neither white nor black ink
  // clears 4.5:1. The fix is to make the veil more opaque until the page
  // escapes the dead zone, rather than picking an unreachable ink colour.
  const reachableAgainst = (color) =>
    Math.max(contrastRatio(WHITE, color), contrastRatio(BLACK, color));

  let veil = { ...bg, a: veilAlpha };
  let pageBackdrop = composite(veil, wallpaper);

  // Escape the dead zone: raise the veil's opacity until the painted page can
  // support legible ink at all.
  if (reachableAgainst(pageBackdrop) < CONTRAST.primary) {
    for (let alpha = veil.a + 0.05; alpha <= 1.0001; alpha += 0.05) {
      const candidate = { ...bg, a: alpha };
      if (reachableAgainst(composite(candidate, wallpaper)) >= CONTRAST.primary) {
        veil = candidate;
        pageBackdrop = composite(candidate, wallpaper);
        break;
      }
    }
  }

  // A mid-tone background at full opacity is still unusable, so push the page
  // itself to the nearest pole. The veil is then *re-derived* from that target
  // so what gets painted is exactly what the contrast maths assumed - fixing
  // the guarantee to a backdrop nobody renders would be worse than no fix.
  let readabilityPole = isDarkSurface(pageBackdrop) ? WHITE : BLACK;
  const legibleBackdrop = hardenSurface(pageBackdrop, readabilityPole, CONTRAST.primary);
  if (legibleBackdrop !== pageBackdrop) {
    pageBackdrop = legibleBackdrop;
    veil = veilFor(pageBackdrop, wallpaper, veilAlpha);
    // Re-derive: hardening can carry the page across the mid-point (a mid-grey
    // background has to end up on one side or the other), and a pole taken from
    // the pre-hardening side then points the wrong way for everything
    // downstream - bubble fills get pushed away from the page's tone and the
    // panel repair drags the panel off the page instead of onto its side.
    readabilityPole = isDarkSurface(pageBackdrop) ? WHITE : BLACK;
  }

  // Elevation is judged against the solid background, not the wallpaper.
  const panelPick = parseColor(o.panel)
    ? { color: parseColor(o.panel), token: 'colors.json' }
    : choosePanel(tokens, bg);

  // The panel is translucent, so its *painted* result is what has to separate
  // - not the opaque token. Solve for lift and alpha together, since raising
  // alpha alone barely moves a low-contrast tint.
  let panel = { ...panelPick.color, a: panelAlpha };
  let panelBackdrop = composite(panel, pageBackdrop);
  if (contrastRatio(panelBackdrop, pageBackdrop) < MIN_PANEL_SEPARATION) {
    for (let alpha = 0.5; alpha <= 1.0001 && contrastRatio(panelBackdrop, pageBackdrop) < MIN_PANEL_SEPARATION; alpha += 0.1) {
      for (let step = 0; step <= 1.0001; step += 0.1) {
        const candidate = { ...mix(panelPick.color, readabilityPole, step), a: Math.min(alpha, 1) };
        if (contrastRatio(composite(candidate, pageBackdrop), pageBackdrop) >= MIN_PANEL_SEPARATION) {
          panel = candidate;
          panelBackdrop = composite(candidate, pageBackdrop);
          break;
        }
      }
    }
  }

  // If the panel ended up on the opposite side of the mid-point from the page,
  // no single body ink can serve both. Pull it back before choosing any text.
  if (isDarkSurface(panelBackdrop) !== isDarkSurface(pageBackdrop)) {
    const aligned = alignPanelToPage(panelPick, pageBackdrop, readabilityPole);
    if (aligned) {
      panel = aligned.panel;
      panelBackdrop = aligned.panelBackdrop;
    }
  }

  // Bubbles are painted translucent over the blurred pane, so the surface the
  // ink lands on is the bubble composited onto the panel - not the bubble
  // token. hardenSurface() checks the token instead, which is deliberate: the
  // ink search blends in opaque space and needs an opaque reference.
  //
  // The bubble is therefore hardened against the surface it is actually painted
  // on, and each step re-composites. That keeps the guarantee honest if
  // BUBBLE_ALPHA ever drops far enough for the panel to matter - at the
  // current 0.94 the two spaces agree on every palette in the suite, which a
  // 7,920-case sweep confirmed, so this is insurance rather than a fix.
  const paintBubble = (token) => composite({ ...token, a: BUBBLE_ALPHA }, panelBackdrop);

  const bubbleFor = (raw) => {
    let token = { ...raw, a: 1 };
    if (reachableAgainst(paintBubble(token)) >= CONTRAST.onBubble) return token;

    for (let step = 0.05; step <= 1.0001; step += 0.05) {
      const candidate = mix(token, readabilityPole, step);
      if (reachableAgainst(paintBubble(candidate)) >= CONTRAST.onBubble) {
        return { ...candidate, a: 1 };
      }
    }
    return readabilityPole; // opaque pole: no translucent blend can be worse
  };

  // A mid-tone primaryContainer (which tonal palettes do produce) is pushed
  // out of the dead zone before any ink is chosen for it.
  const incoming = bubbleFor(
    resolveTint(o.incoming ?? tokens.surfaceContainerLow, isDark ? '#202c33' : '#ffffff')
  );
  const outgoing = bubbleFor(
    resolveTint(o.outgoing ?? tokens.primaryContainer, isDark ? '#005c4b' : '#d9fdd3')
  );

  // 3. Text. Caelestia's own pairings are correct (onSurface/onSurfaceVariant,
  //    onPrimaryContainer), so honour them and only intervene when a surface
  //    pairing would otherwise fall under the floor.
  const primary = resolveTint(o.primary ?? tokens.onSurface, isDark ? '#e9edef' : '#111b21');
  const secondary = resolveTint(o.secondary ?? tokens.onSurfaceVariant, isDark ? '#aebac1' : '#667781');
  const accent = resolveTint(o.accent ?? tokens.primary, '#00a884');

  // Each token is only ever painted on a subset of these surfaces, and it has
  // to clear its floor on all of them. Scoping matters: body text sits on the
  // page and the panel, bubble text sits on the two bubbles, and the accent
  // appears on the panel and as ticks on an outgoing bubble. One search across
  // all four would over-constrain every token - bubble ink dragged onto the
  // page, body ink onto the bubbles - and when a panel is much lighter than the
  // page behind it the two regions genuinely want different ink.
  const bodySurfaces = [pageBackdrop, panelBackdrop];
  // Painted, not token. Read receipts and tick marks sit on the outgoing
  // bubble as it is composited onto the panel, so that is the surface the
  // accent has to clear against too.
  const bubbleSurfaces = [paintBubble(incoming), paintBubble(outgoing)];
  const accentSurfaces = [panelBackdrop, paintBubble(outgoing)];

  const readable = (color, target, scope) => {
    const base = { ...color, a: 1 };
    if (!scope.length) return base;

    const worstAgainst = (candidate) =>
      scope.reduce((worst, surface) => Math.min(worst, contrastRatio(candidate, surface)), Infinity);

    let best = base;
    let bestScore = worstAgainst(base);
    if (bestScore >= target) return base;

    // Blend distance is the outer loop, and the search stops at the first
    // candidate that clears the floor on *every* surface. Stepping outward from
    // the token is what keeps a Caelestia tint recognisable - scoring purely by
    // worst-case contrast instead would send every non-compliant colour on a
    // dark page to pure white, since white maximises the score by
    // construction, and throw the palette out with the legibility.
    //
    // `best` is only reached when nothing clears the floor at any distance, and
    // then it is the least-bad candidate rather than whichever one came last.
    for (let step = 0.05; step <= 1.0001; step += 0.05) {
      for (const candidatePole of [readabilityPole, pole(readabilityPole)]) {
        const candidate = mix(base, candidatePole, step);
        const score = worstAgainst(candidate);
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
        if (score >= target) return candidate;
      }
    }
    return best;
  };

  return {
    mode,
    isDark,
    // The name and token label land in a CSS comment, so they are stripped of
    // anything that could terminate it early.
    source: scheme ? `${commentSafe(scheme.name) || 'caelestia'}/${commentSafe(scheme.flavour) || 'default'}` : 'fallback',
    panelToken: commentSafe(panelPick.token),
    veil,
    panel,
    incoming,
    outgoing,
    blur,
    saturate,
    primary: readable(primary, CONTRAST.primary, bodySurfaces),
    secondary: readable(secondary, CONTRAST.secondary, bodySurfaces),
    // Bubble ink is checked against both bubbles; outgoing text also has to
    // survive on the primaryContainer fill, which M3 does not guarantee at
    // AAA for every tonal spot.
    onBubble: readable(primary, CONTRAST.onBubble, bubbleSurfaces),
    accentInk: readable(accent, CONTRAST.accent, accentSurfaces),
  };
}

/* ================================================================== *
 * CSS generation
 * ================================================================== */

/**
 * Every container this stylesheet can paint or promote, in one list.
 *
 * The status viewer is a viewport-fixed overlay around a <video>, and
 * `transform` / `backdrop-filter` / `filter` / `perspective` / `contain` /
 * `will-change` each make an element the containing block for its
 * fixed-position descendants. One of those on an ancestor of the player
 * re-anchors it away from the viewport, which is silent: the video keeps
 * decoding and the audio keeps playing while the picture is never seen.
 *
 * This was previously handled by an opt-out naming three containers while the
 * pane and promotion rules below reach five and six respectively, so any mount
 * point outside those three still got a blur. The list is the whole reachable
 * set, and it is the only place that says so - a selector added to the glass
 * rules must be added here too, or the guarantee quietly stops holding.
 */
const OVERLAY_CONTAINERS = [
  '#side',
  '#main',
  'header',
  '._akbd',
  '[role="region"]',
  'footer',
  '[data-asset-chat-background="true"]',
  '.message-list',
  '[data-animated-message-list]',
  '.message-in',
  '.message-out',
];

function generateMaskCSS(scheme, overrides, followSystem) {
  const p = buildPalette(scheme, overrides, followSystem);

  const veil = toRgbaString(p.veil);
  const veilLifted = toRgbaString({ ...p.veil, a: clamp(p.veil.a + 0.08, 0, 1) });
  const panel = toRgbaString(p.panel);
  const filter = `blur(${p.blur}px) saturate(${Math.round(p.saturate)}%)`;

  return `
/* ===================================================================
   WhatsApp Glass Native - ${p.source} (${p.mode})
   panel token: ${p.panelToken}
   Regenerated on OS appearance change and on scheme.json edits.
   =================================================================== */

:root {
  color-scheme: ${p.mode} !important;

  /* App surfaces */
  --app-background: ${veil} !important;
  --background-default: ${veil} !important;
  --background-default-hover: ${veilLifted} !important;
  --drawer-background: ${panel} !important;
  --side-background: ${panel} !important;
  --panel-background: ${panel} !important;
  --panel-header-background: ${panel} !important;
  --rich-text-panel-background: ${panel} !important;
  --conversation-panel-background: ${veil} !important;
  --header: ${panel} !important;
  --compose-input-background: ${veilLifted} !important;
  --dropdown-background: ${panel} !important;

  /* Bubbles - translucent over the blurred pane. buildPalette verifies ink
     against the opaque tokens, so alpha stays inside what that guarantee
     survives; see BUBBLE_ALPHA. */
  --incoming-background: ${toRgbaString({ ...p.incoming, a: BUBBLE_ALPHA })} !important;
  --outgoing-background: ${toRgbaString({ ...p.outgoing, a: BUBBLE_ALPHA })} !important;

  /* Text - contrast verified against every surface above */
  --primary-strong: ${toRgbString(p.primary)} !important;
  --primary-title: ${toRgbString(p.primary)} !important;
  --secondary-strong: ${toRgbString(p.secondary)} !important;
  --secondary: ${toRgbString(p.secondary)} !important;
  --title: ${toRgbString(p.primary)} !important;
  --panel-header-color: ${toRgbString(p.primary)} !important;
  --conversation-panel-color: ${toRgbString(p.primary)} !important;
  --compose-input-color: ${toRgbString(p.primary)} !important;

  /* Accent - used for links, read receipts and the send button */
  --accent: ${toRgbString(p.accentInk)} !important;
  --teal: ${toRgbString(p.accentInk)} !important;
  --teal-hover: ${toRgbString(p.accentInk)} !important;
  --teal-light: ${toRgbString(p.accentInk)} !important;
  --icon: ${toRgbString(p.secondary)} !important;
  --icon-lighter: ${toRgbString(p.secondary)} !important;
  --bubble-meta: ${toRgbString(p.secondary)} !important;

  /* Hairlines come from the panel tint, not a hard grey */
  --border-list: ${toRgbaString({ ...p.panel, a: 0.45 })} !important;
  --conversation-header-border: ${toRgbaString({ ...p.panel, a: 0.45 })} !important;
  --conversation-panel-border: ${toRgbaString({ ...p.panel, a: 0.45 })} !important;
}

/* Let the desktop wallpaper through so the blur has something to sample. */
html, body, #app, .app-wrapper-web, div[valign="top"] {
  background: transparent !important;
}

body {
  color: ${toRgbString(p.primary)} !important;
}

#app .two, #app .three {
  background: transparent !important;
}

/* ---------------------------------------------------------------------
 * Frosted glass: static panes
 *
 * These are fixed panes. They blur the desktop wallpaper exactly once and
 * the result is cached until something behind them changes, so the cost is
 * paid on resize / theme change rather than per frame.
 * ------------------------------------------------------------------- */
#side, #main, header, ._akbd, [role="region"] {
  background-color: ${panel} !important;
  backdrop-filter: ${filter} !important;
  -webkit-backdrop-filter: ${filter} !important;
}

/* ---------------------------------------------------------------------
 * Conversation area: translucent, but NOT blurred
 *
 * The rule that looks like an oversight is the load-bearing one here.
 *
 * This subtree is what scrolls. A backdrop-filter samples everything painted
 * behind it, so putting one on a scrolling node forces the compositor to
 * re-run the blur for the region on every frame the content moves - that is
 * the single most expensive way to use backdrop-filter, and on a long thread
 * it is the whole cost of the frame budget. It was almost certainly the cause
 * of the choppy scrolling rather than anything about hardware acceleration.
 *
 * So the blur lives on the static pane above, and this node is a
 * translucent overlay sitting on top of it. The pane's already-blurred
 * result shows through the alpha, which is what still reads as frosted
 * glass, but the blur itself is computed once instead of once per frame.
 *
 * The :not() guards are not padding. #main's child structure has moved
 * between WhatsApp releases; if the direct child is the scroller AND an
 * ancestor of the compose box, this rule would out-specify the footer rule
 * below - an ID beats a type selector at any source order - and repaint the
 * compose bar as conversation surface. Excluding any child containing a
 * composer makes it a no-op in that layout rather than a regression.
 *
 * The tint is the PANEL colour, not the veil. The veil is what sits between
 * the wallpaper and the page background; stacking it a second time on top of
 * the pane that is already veiled lands nearer opaque and reads as flat grey.
 * The panel tint at its own alpha is the translucent value that belongs
 * directly on a blurred surface, and it is what actually lets the blur
 * through - which is the whole point of the effect.
 *
 * Body ink was measured against pageBackdrop and panelBackdrop rather than
 * against this overlay. That is deliberate, and it is the reason the overlay
 * is not simply the veil: paint it at the panel's alpha and it sits between
 * the two surfaces the ink was checked against, with the panel's contrast on
 * one side and the page's on the other.
 * ------------------------------------------------------------------- */
[data-asset-chat-background="true"],
#main > div:not(:has(footer)):not(:has([contenteditable="true"])) {
  background-color: ${panel} !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

/* Chat wallpaper leak.

   WhatsApp's doodle/pattern wallpaper is a tiled background-*image*, a
   different property from background-color, so overriding the colour alone
   leaves the pattern sitting on top of the glass. It has to be cleared
   explicitly, and on the children as well because the image is usually set on
   a wrapper rather than on #main itself. */
#main,
#main > div,
[data-asset-chat-background="true"] {
  background-image: none !important;
}

/* Status / media overlay opt-outs.

   The status player is a viewport-fixed overlay wrapped around a <video>, and
   WhatsApp mounts it wherever it likes. Two unrelated failures follow, and they
   present very differently.

   1. Appearance. The background-image reset above blanks the player's own
      artwork, and the panel tint from the glass-pane list lands a translucent
      colour under the video surface. Scoped out by :has(video) on the three
      containers the player has historically mounted inside. Deliberately not
      widened further: .message-in:has(video) is an ordinary inline video
      message, and dropping its bubble fill would be a worse regression than the
      one being fixed.

   2. Containment, which is the one that ships as "status only plays as
      background audio". transform, backdrop-filter, filter, perspective,
      contain, and a will-change naming any of them all make an element the
      containing block for its fixed-position descendants. The player is
      position: fixed; inset: 0, so beneath such an ancestor it stops resolving
      against the viewport and anchors to that ancestor's padding box instead.
      Nothing crashes and nothing logs: the video keeps decoding, so the audio
      still comes out, while the picture is anchored to some inner box and is
      never seen. WhatsApp sends the "viewed" receipt when a status is opened
      rather than when it plays, so this also presented as status registering as
      watched with nothing on screen.

   Containment is why the old block was not enough. It named three containers
   while the glass-pane rule above reaches five and the promotion rule reaches
   six, so any mount point outside those three still received the full glass
   treatment - backdrop-filter included, which is the property that does the
   damage. The list below is the complete set of containers this sheet can
   reach, which is what makes the guarantee hold regardless of where the player
   ends up. :is() rather than a bare comma list so it out-specifies the pane
   rule above on every branch, including the two whose own selectors are only
   type/attribute selectors and would otherwise tie or lose. */
#main:has(video),
#main > div:has(video),
[data-asset-chat-background="true"]:has(video) {
  background-image: initial !important;
  background-color: transparent !important;
}

:is(#side, #main, header, ._akbd, [role="region"], footer,
    [data-asset-chat-background="true"], .message-list,
    [data-animated-message-list], .message-in, .message-out):has(video) {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  filter: none !important;
  transform: none !important;
  perspective: none !important;
  will-change: auto !important;
  contain: none !important;
  backface-visibility: visible !important;
}

/* ---------------------------------------------------------------------
 * Scroll performance
 *
 * These are compositor hints, not decoration, and each one is scoped to the
 * element that actually scrolls. Applied to a universal selector instead they
 * would promote every node in a long thread to its own texture and cost far
 * more memory than the jank they were meant to remove.
 *
 * will-change is the one to be careful with. It is not a generic speed-up -
 * it reserves a compositor layer from the moment it is declared, so on the
 * wrong node it is pure overhead. A translateZ(0) transform gives the same
 * promotion without promising the layer ahead of time.
 *
 * EVERY selector here carries :not(:has(video)), and that is not decoration.
 * Both properties below change how the browser resolves fixed-position
 * descendants: a transform or a contain: paint makes the element a containing
 * block, so a full-viewport overlay inside it anchors to that ancestor instead
 * of the viewport, and contain: paint additionally clips descendants to the
 * element's own box. WhatsApp's status viewer is precisely a fixed,
 * viewport-sized video overlay, so promoting an ancestor of it left the viewer
 * with no usable surface - status stopped playing while still being reported
 * as viewed, because the read-receipt is sent by the SPA on open rather than
 * on playback.
 *
 * Bubbles below are promoted *without* that guard, because a bubble is never
 * an overlay. That assumption is what the status bug came down to, though: it
 * holds for the chat list but not for WhatsApp's generated markup in general,
 * and an inline video message really does sit inside a promoted row. So the
 * bubble rule stays unguarded and the escape hatch above does the work instead
 * - one place decides what a video subtree may carry, which is the only way the
 * two lists cannot drift apart again.
 *
 * contain: paint is deliberately omitted rather than guarded. It was the
 * cheapest-looking win on the list and it is the one that clips: dropping it
 * costs almost nothing on scroll, because transform alone already keeps the
 * list on its own compositor layer.
 * ------------------------------------------------------------------- */
#main > div:not(:has(video)),
[data-asset-chat-background="true"]:not(:has(video)),
.message-list:not(:has(video)),
[data-animated-message-list]:not(:has(video)) {
  transform: translateZ(0);
  backface-visibility: hidden;
  overscroll-behavior: contain;
  /* deliberately NOT contain: paint - see the note above */
}

/* Bubbles are promoted too, but only the ones actually on screen matter and
   Chromium culls the rest, so this stays cheap where a blanket * selector
   would not. No :not(:has(video)) here - see the note on the scroll rules
   above; the containment escape hatch is what keeps a video out of a promoted
   node, and having both would be two lists to keep in sync. */
.message.message-in:not(:has(video)),
.message-out:not(:has(video)) {
  transform: translateZ(0);
  backface-visibility: hidden;
}-in,
.message-out {
  transform: translateZ(0);
  backface-visibility: hidden;
}

footer,
[tabindex="-1"]:has(div[contenteditable="true"]) {
  background-color: ${panel} !important;
  backdrop-filter: ${filter} !important;
  -webkit-backdrop-filter: ${filter} !important;
}

div[contenteditable="true"] {
  background-color: ${veilLifted} !important;
  color: ${toRgbString(p.primary)} !important;
  border-radius: 10px !important;
}

/* Bubbles.

   Translucent fills over the blurred pane, for the same reason the
   conversation area is: glass is the pane showing through the alpha, and a
   per-bubble backdrop-filter would mean one blur region per message.

   The alpha is high on purpose. buildPalette hardens the bubbles against the
   composite of this exact alpha (see bubbleFor), so the ink guarantee is
   stated on the surface actually painted rather than on the opaque token -
   but only the *painted* result is ever seen, so there is no reason to give
   up much transparency for it.

   Three selector shapes per direction, because the bubble element has moved
   between WhatsApp builds and no single one always matches:

     .message-in              carries the class on the bubble itself in current
                              builds, and on the full-width row wrapper in
                              older ones
     div[class*="message-in"]  some builds prefix/suffix the class with a
                              build hash (message-in-3f8ac1), which a bare
                              class selector cannot match at all
     > div / [data-id]         the nested node that older builds actually paint

   Row and nested node get the same fill, so each layout resolves to a correct
   bubble with no seam between the two nodes.

   CAVEAT: in the old row-based layout the row is full-width, so painting
   .message-in directly would draw a band behind the whole message list. The
   nested-div rules cover that layout on their own, so if a band ever shows up
   on a real build, dropping the bare .message-in / .message-out selectors is
   the fix - nothing else depends on them. */
div[class*="message-in"],
.message-in,
.message-in > div,
.message-in [data-id] {
  background-color: ${toRgbaString({ ...p.incoming, a: BUBBLE_ALPHA })} !important;
  color: ${toRgbString(p.onBubble)} !important;
}

div[class*="message-out"],
.message-out,
.message-out > div,
.message-out [data-id] {
  background-color: ${toRgbaString({ ...p.outgoing, a: BUBBLE_ALPHA })} !important;
  color: ${toRgbString(p.onBubble)} !important;
}

/* Readability net. Only icon glyphs are forced here - a blanket span/div
   colour rule fights WhatsApp's cascade and breaks the mute and pin icons. */
body [data-icon] {
  color: ${toRgbString(p.secondary)} !important;
  fill: ${toRgbString(p.secondary)} !important;
}

/* Message tails.

   The tail is a sibling span that WhatsApp tints from its own palette rather
   than from the bubble fill, so recolouring the bubble leaves the default
   wedge welded to the edge of an otherwise themed bubble - the leftover-green
   artefact that survives a complete bubble override.

   [data-icon^="tail-"] covers tail-out, tail-in and any future tail-* glyph
   in one selector. The fill is set on the span, the <svg> and the <path>
   because builds put it in different places: some inherit currentColor into
   the svg, others hardcode a fill straight onto the path. All three have to be
   set or the wedge stays green depending on the build.

   Each tail takes its own direction's bubble fill, not the ink colour - the
   wedge is part of the bubble, not a glyph drawn on it. These sit after the
   blanket [data-icon] rule above deliberately: matching on direction plus the
   attribute selector already out-specifies it, and putting them last means the
   source order agrees with the cascade instead of relying on that alone. */
div[class*="message-in"] [data-icon^="tail-"],
.message-in [data-icon^="tail-"] {
  color: ${toRgbString(p.incoming)} !important;
  fill: ${toRgbString(p.incoming)} !important;
}

div[class*="message-in"] [data-icon^="tail-"] svg,
div[class*="message-in"] [data-icon^="tail-"] path,
.message-in [data-icon^="tail-"] svg,
.message-in [data-icon^="tail-"] path {
  fill: ${toRgbString(p.incoming)} !important;
}

div[class*="message-out"] [data-icon^="tail-"],
.message-out [data-icon^="tail-"] {
  color: ${toRgbString(p.outgoing)} !important;
  fill: ${toRgbString(p.outgoing)} !important;
}

div[class*="message-out"] [data-icon^="tail-"] svg,
div[class*="message-out"] [data-icon^="tail-"] path,
.message-out [data-icon^="tail-"] svg,
.message-out [data-icon^="tail-"] path {
  fill: ${toRgbString(p.outgoing)} !important;
}

::selection {
  background: ${toRgbaString({ ...p.accentInk, a: 0.32 })} !important;
}

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
`.trim();
}

/* ================================================================== *
 * File loading (with last-good caching)
 * ================================================================== */

let schemeCache = null;
let schemeRaw = null;
let overrideCache = null;
let overrideRaw = null;

function readJsonCached(file, cacheRef) {
  const holder = cacheRef;
  try {
    if (!fs.existsSync(file)) {
      holder.cache = null;
      holder.raw = null;
      return null;
    }
    const raw = fs.readFileSync(file, 'utf8');
    if (raw === holder.raw) return holder.cache; // rewritten with same bytes
    holder.raw = raw;
    const parsed = JSON.parse(raw);
    holder.cache = parsed && typeof parsed === 'object' ? parsed : null;
    return holder.cache;
  } catch (err) {
    console.error(`[Glass] Could not read ${path.basename(file)}: ${err.message}`);
    // Keep the last good parse rather than flashing to defaults.
    return holder.cache;
  }
}

function loadCaelestiaScheme() {
  return readJsonCached(CAELESTIA_SCHEME_PATH, {
    get cache() {
      return schemeCache;
    },
    set cache(v) {
      schemeCache = v;
    },
    get raw() {
      return schemeRaw;
    },
    set raw(v) {
      schemeRaw = v;
    },
  });
}

function loadOverrides() {
  return readJsonCached(OVERRIDE_FILE, {
    get cache() {
      return overrideCache;
    },
    set cache(v) {
      overrideCache = v;
    },
    get raw() {
      return overrideRaw;
    },
    set raw(v) {
      overrideRaw = v;
    },
  });
}

/** colors.json may set { followSystem: true } to track the OS instead. */
function shouldFollowSystem() {
  const o = loadOverrides();
  return !!(o && o.followSystem);
}

/* ================================================================== *
 * Injection
 * ================================================================== */

let win = null;
let injectTimer = null;
let lastCss = '';

const LOG_LINES = [];

/**
 * Build the source for a single self-contained upsert.
 *
 * A persistent node beats webContents.insertCSS here: insertCSS stacks a
 * fresh copy on every call (leaking rules on each toggle), while a node in
 * <head> also survives WhatsApp's client-side routing.
 *
 * The values are interpolated rather than passed as arguments because
 * executeJavaScript takes only (code, userGesture) - it has no argument
 * pass-through. Handing it extra arguments makes the internal IPC clone fail
 * with "An object could not be cloned", which rejects the promise.
 */
function buildUpsertSource(styleId, css, mode) {
  // JSON.stringify is what keeps quotes, newlines and backslashes in the
  // stylesheet from terminating the literal. U+2028/U+2029 are valid in JSON
  // but were once illegal inside JS string literals, so escape those by hand.
  const literal = (value) =>
    JSON.stringify(value)
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');

  return `(() => {
  const ID = ${literal(styleId)};
  const CSS = ${literal(css)};
  const MODE = ${literal(mode)};
  try {
    const root = document.documentElement;
    root.setAttribute('data-glass-mode', MODE);
    root.style.setProperty('color-scheme', MODE);

    let el = document.getElementById(ID);
    if (!el) {
      el = document.createElement('style');
      el.id = ID;
      el.setAttribute('data-glass', 'true');
      (document.head || root).appendChild(el);
    }
    if (el.textContent !== CSS) {
      el.textContent = CSS;
    }
    return true;
  } catch (err) {
    return false;
  }
})()`;
}

function log(message) {
  const line = `[Glass] ${message}`;
  console.log(line);
  LOG_LINES.push(line);
  if (LOG_LINES.length > LOG_TAIL) LOG_LINES.shift();
}

function scheduleInject(reason) {
  clearTimeout(injectTimer);
  injectTimer = setTimeout(() => inject(reason), DEBOUNCE_MS);
}

function inject(reason) {
  if (!win || win.isDestroyed()) return;
  const contents = win.webContents;
  if (contents.isDestroyed() || contents.isCrashed()) return;

  const scheme = loadCaelestiaScheme();
  const overrides = loadOverrides();
  const followSystem = shouldFollowSystem();
  const p = buildPalette(scheme, overrides, followSystem);
  const css = generateMaskCSS(scheme, overrides, followSystem);

  if (contents.isLoading()) return; // dom-ready / did-finish-load retries

  // Only remember the CSS once it has actually been handed to the page.
  // Caching before the isLoading() bail above would poison the dedup guard:
  // the startup inject runs mid-load, and every load-hook retry would then
  // see an unchanged string and skip injection for the life of the window.
  if (css === lastCss) return;
  lastCss = css;

  // The mode has to come from the palette, not from nativeTheme. The
  // stylesheet declares `color-scheme: <mode> !important`, and an important
  // author declaration outranks a normal inline one - so setting the inline
  // property from the OS while the stylesheet says otherwise leaves the two
  // permanently disagreeing. One source of truth, and the tokens win because
  // they are what actually gets painted.
  const mode = p.mode;
  contents
    .executeJavaScript(buildUpsertSource(STYLE_ID, css, mode))
    .then((ok) => {
      if (ok !== true) {
        // The page evaluated the upsert but it bailed internally. Worth
        // saying out loud: a silent failure here looks identical to a
        // missing stylesheet, which is expensive to debug.
        log('injection ran but the page refused it');
      }
    })
    .catch((err) => {
      /* navigated mid-injection; the load hooks fire again */
      log(`injection failed: ${String(err && err.message).slice(0, 120)}`);
    });

  // An OS change the tokens contradict is worth surfacing: the desktop says
  // light, the page stays dark, and that reads as a bug even though keeping
  // the tokens is what stops the ink from going black-on-black.
  const osMode = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  if (p.mode !== osMode) {
    log(`OS is ${osMode} but the scheme is ${p.mode}; keeping ${p.mode} so ink matches surface`);
  }

  log(
    `applied ${p.source} ${p.mode}` +
      (reason ? ` (${reason})` : '') +
      ` panel=${p.panelToken} primary=${toRgbString(p.primary)}`
  );
}

/* ================================================================== *
 * Watching
 * ================================================================== */

const watched = [CAELESTIA_SCHEME_PATH, OVERRIDE_FILE];

function watchFiles() {
  for (const file of watched) {
    // Editors that write in place: immediate notification.
    try {
      fs.watch(file, { persistent: false }, () => scheduleInject('write'));
    } catch {
      /* not present yet; the poller below covers creation */
    }

    // Editors that replace the inode (write-temp + rename): poll instead.
    fs.watchFile(file, { persistent: false, interval: POLL_MS }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
        scheduleInject('change');
      }
    });
  }

  // A new scheme.json or colors.json renamed into place never touches the
  // old inode, so watch the containing directories too.
  for (const dir of new Set([path.dirname(CAELESTIA_SCHEME_PATH), __dirname])) {
    try {
      fs.watch(dir, { persistent: false }, (event, name) => {
        if (name === 'scheme.json' || name === 'colors.json') {
          scheduleInject('rename');
        }
      });
    } catch {
      /* best effort */
    }
  }
}

function unwatchFiles() {
  clearTimeout(injectTimer);
  for (const file of watched) {
    try {
      fs.unwatchFile(file);
    } catch {
      /* nothing to do */
    }
  }
}

/* ================================================================== *
 * Safari user-agent
 * ================================================================== */

/**
 * Present as Safari on every request.
 *
 * Three layers have to agree or WhatsApp sees a contradiction and may serve
 * the wrong build:
 *   - the navigation's user-agent string
 *   - the sec-ch-ua client hints, which advertise the real engine
 *   - navigator.userAgent inside the page, which UA string already fixes
 *
 * setUserAgent covers the first and third. The hints are only sent on
 * encrypted requests, so they need the webRequest filter below.
 */
function applySafariUA(contents) {
  contents.setUserAgent(SAFARI_UA);

  const { webRequest } = contents.session;
  const filter = { urls: ['https://*/*'] };

  // Rewritten rather than removed: some servers fall back to "no hints, assume
  // modern browser", which is worse than an explicit Safari claim.
  webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = { ...details.requestHeaders };
    headers['User-Agent'] = SAFARI_UA;
    headers['sec-ch-ua'] = SAFARI_SEC_CH_UA;
    headers['sec-ch-ua-mobile'] = SAFARI_SEC_CH_UA_MOBILE;
    headers['sec-ch-ua-platform'] = SAFARI_SEC_CH_UA_PLATFORM;
    // Chrome-only hints that Safari never sends.
    delete headers['Sec-CH-UA-Arch'];
    delete headers['Sec-CH-UA-Bitness'];
    delete headers['Sec-CH-UA-Full-Version'];
    delete headers['Sec-CH-UA-Model'];
    delete headers['Sec-CH-UA-Platform-Version'];
    delete headers['Sec-CH-UA-WoW64'];
    delete headers['Upgrade-Insecure-Requests'];
    callback({ requestHeaders: headers });
  });
}

/* ================================================================== *
 * Window
 * ================================================================== */

/**
 * Keep the compositor on the GPU.
 *
 * Hardware acceleration is on by default in Electron and this app never calls
 * disableHardwareAcceleration(), so nothing here turns it *on* - the risk was
 * the opposite one, where a workaround for the old choppy scrolling (a
 * software-rendering flag) got added and silently pinned a long thread to
 * CPU rasterisation. These switches make the accelerated path explicit and
 * stop the compositor from silently falling back.
 *
 *   enable-gpu-rasterization   raster on the GPU instead of the CPU
 *   ignore-gpu-blocklist       a blocklisted driver still composites, rather
 *                              than dropping to software with no warning
 *   enable-zero-copy           share textures with the GPU instead of a
 *                              readback copy per frame, which is what makes a
 *                              large blurred region expensive without it
 */
function enableHardwareAcceleration() {
  // Guarded rather than called blind: commandLine only exists inside a real
  // Electron process, and this function runs at module scope. The tests load
  // main.js against a partial stub, so an unguarded call would throw on
  // require and take the whole suite down with it.
  const commandLine = app.commandLine;
  if (!commandLine || typeof commandLine.appendSwitch !== 'function') return;

  // Already disabled elsewhere? Then leave it alone - the switches below are
  // only meaningful on the accelerated path.
  if (app.disableHardwareAcceleration) return;

  commandLine.appendSwitch('enable-gpu-rasterization');
  commandLine.appendSwitch('ignore-gpu-blocklist');
  commandLine.appendSwitch('enable-zero-copy');
}

function createWindow() {
  win = new BrowserWindow({
    ...WINDOW,
    title: 'WhatsApp Glass Native',
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    // Required for the wallpaper to show through the blur.
    transparent: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      // Do not throttle rAF when the window is not focused. Chromium drops
      // background tabs to ~1fps, and a chat window that sits behind another
      // one stops compositing entirely - which looks exactly like choppy
      // scrolling when the user brings it forward again.
      backgroundThrottling: false,
    },
  });

  if (process.platform === 'linux') win.setMenuBarVisibility(false);

  applySafariUA(win.webContents);

  // The shell stays pointed at WhatsApp Web; links open in the real browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(TARGET_ORIGIN)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(TARGET_ORIGIN)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // The <style> node lives in the document, but the dedup cache lives in this
  // process. A reload throws the node away while lastCss still says "already
  // delivered", so a plain re-render would leave the fresh page unthemed.
  // Invalidate on every navigation and let did-stop-loading re-apply.
  for (const event of ['did-start-navigation', 'did-start-loading']) {
    win.webContents.on(event, () => {
      lastCss = '';
    });
  }

  // Re-apply on every document state change. WhatsApp is an SPA, so
  // in-page routing is the common case and a one-shot injection is lost.
  //
  // did-stop-loading is the load-bearing one: isLoading() stays true all the
  // way through did-finish-load and only clears when the load settles, so
  // hooking the earlier events alone would make every call bail out.
  for (const event of [
    'dom-ready',
    'did-finish-load',
    'did-stop-loading',
    'did-navigate-in-page',
  ]) {
    win.webContents.on(event, () => inject(event));
  }

  win.on('closed', () => {
    win = null;
  });

  win.loadURL(TARGET_ORIGIN);
  return win;
}

/* ================================================================== *
 * Bootstrap
 * ================================================================== */

nativeTheme.themeSource = 'system';

// Must run before the app is ready, or before any window exists for the
// switches to have no effect on the first composited frame.
enableHardwareAcceleration();

app.whenReady().then(() => {
  const scheme = loadCaelestiaScheme();
  log(
    scheme
      ? `starting from Caelestia scheme "${scheme.name || 'unnamed'}" (${scheme.flavour || 'default'}/${scheme.variant || '?'}), mode=${scheme.mode || 'auto'}`
      : 'starting: no Caelestia scheme found, using WhatsApp defaults'
  );

  createWindow();
  watchFiles();
  inject('startup');

  // OS appearance toggled. The palette is token-driven, so an OS flip only
  // changes the result when the scheme is unpinned or the user opted into
  // following the system - but it is also the signal that Caelestia is about
  // to rewrite scheme.json, so re-running now gets the new tokens early.
  nativeTheme.on('updated', () => {
    log(`OS appearance -> ${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`);
    lastCss = ''; // force a rebuild even if the token string repeats
    scheduleInject('appearance');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  unwatchFiles();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', unwatchFiles);

module.exports = {
  // Exported for tests.
  parseColor,
  relativeLuminance,
  contrastRatio,
  composite,
  mix,
  isDarkSurface,
  BUBBLE_ALPHA,
  choosePanel,
  alignPanelToPage,
  buildPalette,
  generateMaskCSS,
  loadCaelestiaScheme,
  buildUpsertSource,
  applySafariUA,
  SAFARI_UA,
};
