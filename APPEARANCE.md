# Appearance: how light and dark mode are decided

Every place `main.js` decides or applies an appearance, and why the decision is made the way it is.
Line references are to `main.js` as of the last change; they drift, so grep for the identifiers rather
than trusting the numbers.

The short version: **the tokens decide the appearance, not the OS.** The OS is consulted to pick a
starting background, and then the background's own luminance has the final say. Everything else
follows from that one rule.

## 1. The decision — luminance of the resolved background

`isDarkSurface` is the single source of truth for "is this dark":

```js
const DARK_LUMINANCE_CUTOFF = 0.18;

function isDarkSurface(color) {
  return relativeLuminance(color) < DARK_LUMINANCE_CUTOFF;
}
```

`buildPalette` then runs a three-step precedence. The scheme's declared mode is only a *request*; the
resolved background overrules it:

```js
  // 1. Appearance. Caelestia pins a resolved mode, but the OS wins when the
  //    scheme is unpinned (or the user opts into it) - and the background's
  //    own luminance gets the final say, so tokens and color-scheme can never
  //    disagree. A dark scheme forced into light mode is the failure that
  //    would otherwise produce black text on a near-black panel.
  const schemeMode = typeof scheme?.mode === 'string' ? scheme.mode.toLowerCase() : '';
  const schemePinned = schemeMode === 'dark' || schemeMode === 'light';
  const requestedDark = !schemePinned || followSystem ? nativeTheme.shouldUseDarkColors : schemeMode === 'dark';

  const bg = tinted(resolveTint(o.bg ?? tokens.background, requestedDark ? '#0b0e11' : '#f0f2f5'));

  // The tokens decide the appearance, not the requested mode.
  const isDark = isDarkSurface(bg);
  const mode = isDark ? 'dark' : 'light';
  const wallpaper = isDark ? WHITE : BLACK;
```

The fallback background pair is `#0b0e11` dark / `#f0f2f5` light, applied when the scheme carries no
usable `background`.

Mode then feeds the surface alphas:

```js
  const veilAlpha   = resolveNumber(o.veil,     isDark ? 0.74 : 0.86, 0, 1);
  const panelAlpha = resolveNumber(o.opacity,  isDark ? 0.45 : 0.62, 0.05, 1);
```

### Why luminance and not the mode string

Because the declared mode string is not trustworthy on its own. `followSystem` can ask for light while
Caelestia still has dark tokens on disk. Deciding from the background's own luminance is self-healing:
the readability pole and `color-scheme` always agree with the colours that will actually be painted.

The failure this prevents is concrete. A dark scheme forced into light mode would resolve the pole to
black ink, and black ink on a near-black panel is unreadable — while still passing every structural
test in the suite, because the palette is internally consistent. It is only wrong on screen.

Note that `isDark` is re-derived from `bg` *after* the tint is applied, so a tint strong enough to flip
the background's polarity moves the whole palette with it. That is deliberate.

## 2. Declaring it to the page

Two places, both necessary.

In the generated stylesheet, inside the `:root` rule:

```js
:root {
  color-scheme: ${p.mode} !important;
```

And in the upsert source, as an attribute plus an inline property:

```js
    root.setAttribute('data-glass-mode', MODE);
    root.style.setProperty('color-scheme', MODE);
```

The attribute is for debugging and for anything that wants to branch on mode in the page. The inline
property is a belt-and-braces fallback for the case where the stylesheet fails to inject.

`!important` on the sheet's declaration is load-bearing, and it is why `inject` refuses to source the
mode from `nativeTheme`:

```js
  // The mode has to come from the palette, not from nativeTheme. The
  // stylesheet declares `color-scheme: <mode> !important`, and an important
  // author declaration outranks a normal inline one - so setting the inline
  // property from the OS while the stylesheet says otherwise leaves the two
  // permanently disagreeing. One source of truth, and the tokens win because
  // they are what actually gets painted.
  const mode = p.mode;
```

Setting both from the OS would leave the page permanently disagreeing with itself, with no error to
show for it.

## 3. Surfacing a contradiction instead of hiding it

When the OS and the tokens disagree, the tokens win and the disagreement is logged rather than
silently resolved:

```js
  // An OS change the tokens contradict is worth surfacing: the desktop says
  // light, the page stays dark, and that reads as a bug even though keeping
  // the tokens is what stops the ink from going black-on-black.
  const osMode = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  if (p.mode !== osMode) {
    log(`OS is ${osMode} but the scheme is ${p.mode}; keeping ${p.mode} so ink matches surface`);
  }
```

This line is the only way to tell "the theme is wrong" from "the theme is working as designed and your
desktop is set to the other mode". Without it the two are indistinguishable from the UI.

## 4. Reacting to an OS flip

```js
nativeTheme.themeSource = 'system';
```

and, once the app is ready:

```js
  // OS appearance toggled. The palette is token-driven, so an OS flip only
  // changes the result when the scheme is unpinned or the user opted into
  // following the system - but it is also the signal that Caelestia is about
  // to rewrite scheme.json, so re-running now gets the new tokens early.
  nativeTheme.on('updated', () => {
    log(`OS appearance -> ${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`);
    lastCss = ''; // force a rebuild even if the token string repeats
    scheduleInject('appearance');
  });
```

Two details in that block:

- **`lastCss = ''`** defeats the dedup guard. Without it, a rebuild producing a byte-identical
  stylesheet would be skipped and the appearance change would silently not apply.
- **Re-running early is not just about mode.** Caelestia rewrites `scheme.json` in response to an OS
  flip, so this listener fires *before* the new tokens land on disk. Rebuilding now gets the new
  appearance sooner; the file watcher picks up the token change separately.

## 5. The opt-in

```js
/** colors.json may set { followSystem: true } to track the OS instead. */
function shouldFollowSystem() {
  const o = loadOverrides();
  return !!(o && o.followSystem);
}
```

This is the only switch that lets the OS choose the requested appearance on a scheme that declares one.
It cannot desync the tokens from the mode, because `isDark` is re-derived from the resulting `bg`
afterwards — the worst outcome is the log line in §3, not a mismatched palette.

To see the desync path exercised, set `followSystem: true` in `colors.json` while Caelestia is pinned
to the opposite mode.

---

## Why this matters for the form-control problem

The UA paints form controls (`<button>`, `<input>`) with `fieldtext`, which follows `color-scheme`.
Because this sheet declares `color-scheme` explicitly, the UA picks the matching pole — so an unthemed
control renders **white on a dark pane and black on a light pane**.

That is the UA behaving correctly for the mode. It is simply not a palette ink in either direction,
which is why the fix for those controls is to name them rather than to adjust the mode declaration.
See the chat-list section of `README.md`.

## Where the ink floors sit

Not mode logic, but the other thing that changes across appearances. `CONTRAST` in `main.js` holds the
per-token contrast floors, and `readable()` bisects lightness until each ink clears its floor on every
surface it lands on — the page, the panel, and the bubble colours. Dark mode and light mode reach those
floors from opposite directions, which is why the search is a bisection rather than a fixed offset.