# WhatsApp Glass Native

<p align="center">
  <img src="assets/icon.svg" width="96" height="96" alt="WhatsApp Glass Native icon">
</p>

An Electron shell around [WhatsApp Web](https://web.whatsapp.com) that themes it from your live
[Caelestia](https://github.com/lhord-starr/Caelestia) Material 3 colour scheme — glass-morphic
panes, your own palette, and text that stays legible on every surface it's actually painted on.

> Electron embeds Chromium and that can't be swapped, so WhatsApp Web is still rendered by Blink.
> The app sends a Safari user-agent to get the build WhatsApp designed against, not WebKit
> behaviour. See [Safari identity](#safari-identity).

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="wg1.png" alt="WhatsApp Glass Native in a light scheme"></td>
    <td width="50%"><img src="wg2.png" alt="WhatsApp Glass Native in a dark scheme"></td>
  </tr>
  <tr>
    <td align="center">Light scheme</td>
    <td align="center">Dark scheme</td>
  </tr>
</table>

Both are driven by the live Caelestia scheme — nothing here is hand-picked. Switch the OS
appearance and the panes, bubbles and ink follow. See [How theming works](#how-theming-works).

## Requirements

- Node.js and npm
- A Linux desktop with a compositor (the glass effect needs the desktop wallpaper to show through)
- Optional: Caelestia installed, for automatic scheme pickup

## Install and run

```sh
npm install
npm start
```

## Icon

`assets/icon.svg` is the source of truth. Electron's `nativeImage` cannot read SVG — a path to the
vector loads as a 0×0 empty image — so the window is handed `assets/icon.png` and the raster set in
`assets/icons/`. Regenerate both after editing the source:

```sh
npm run build:icon
```

Needs `rsvg-convert` (librsvg) or `resvg` on `PATH`; the script picks whichever it finds and reports
a clear error if neither is installed. Each size is rendered at 4× and box-filtered down, because a
16px icon drawn at 16px and one downsampled from 2048px are not the same pixels.

## Tests

```sh
npm test
```

No test framework — the assertions are plain enough that a dependency would cost more than it
saves. Four suites, 86 checks:

| Suite | Covers |
| --- | --- |
| `test/palette.test.js` | Token parsing, contrast primitives, palette guarantees, the generated stylesheet, theme-leak overrides, status/media overlays |
| `test/ink.test.js` | The ink search in `buildPalette` — each token must clear its floor on *every* surface it lands on |
| `test/inject.test.js` | The stylesheet upsert survives being parsed by the page, and the Electron lifecycle wiring fires |
| `test/ua.test.js` | User-agent, `sec-ch-ua` client hints and `navigator.*` all agree on "Safari" |

`main.js` calls `app.getPath()` and reads `nativeTheme` at module scope, so it can't be `require`d
outside a real Electron process. Each suite stubs the `electron` module via `Module._load` before
loading it.

## How theming works

### Palette resolution

In priority order:

1. `~/.local/state/caelestia/scheme.json` — the live Material 3 scheme
2. `./colors.json` — optional hand-tweaks applied on top
3. Built-in WhatsApp defaults

Then every text token is contrast-checked against every surface it can land on, and blended until
it clears its WCAG floor. Caelestia palettes are well built, but a wallpaper-driven scheme can
still put `onSurfaceVariant` or `primary` too close to a bubble background — that's what the
palette code exists to prevent.

### Surfaces

Three stacked surfaces, from the desktop up:

| Surface | Default (dark / light) | What it is |
| --- | --- | --- |
| Page | `veil` at 74% / 86% | The app background over the blurred wallpaper |
| Panel | 55% / 72% | Sidebar, header, chat area, compose bar |
| Bubbles | 94% over the panel | Incoming and outgoing message fills |

Appearance is decided by the tokens, not the OS: the background's own luminance has the final say,
so `color-scheme` and the painted colours can never disagree.

### Contrast guarantees

Floors are AAA for body and bubble text, AA for supporting text:

| Token | Floor | Painted on |
| --- | --- | --- |
| `primary` | 7:1 | page, panel |
| `secondary` | 4.5:1 | page, panel |
| `onBubble` | 7:1 | both bubbles |
| `accent` | 4.5:1 | panel, outgoing bubble (read receipts, ticks) |

Three things make that hold rather than just usually hold:

- **Tokens are scoped to their real surfaces.** Body ink is checked against the page and the panel;
  bubble ink against the two painted bubbles. One search across all four would over-constrain every
  token, and when a panel is much lighter than the page behind it the two regions genuinely want
  different ink.
- **The mid-tone dead zone is escaped.** Between roughly 0.18 and 0.45 luminance neither white nor
  black ink reaches 4.5:1 — the far pole is too close. A surface in that band is pushed toward the
  page's pole *before* its ink is chosen, and the veil is then re-derived so what gets painted is
  exactly what the maths assumed.
- **The panel is pulled onto the page's side of the mid-point.** Body text is one colour on both
  surfaces, so a panel that crosses the mid-point away from the page makes the body floor
  unreachable for any single value.

The bubble fill is translucent, so ink is verified against the bubble *composited onto the panel*,
not against the opaque token — the guarantee is stated on the surface actually painted.

### Scroll performance

The blur lives on the static panes, which sample the wallpaper once and cache the result. The
scrolling conversation node is a translucent overlay on top of an already-blurred pane: putting a
`backdrop-filter` on a scrolling node forces the compositor to re-run the blur every frame content
moves, which was the real cause of choppy scrolling.

Promotion hints (`translateZ(0)`) are scoped to the elements that actually scroll or are actually
on screen, rather than a blanket universal selector.

### Status and media overlays

`transform`, `backdrop-filter`, `filter`, `perspective`, `contain` and a `will-change` naming any
of them each make an element the containing block for its fixed-position descendants. WhatsApp's
status viewer is exactly a viewport-fixed overlay around a `<video>`, so one of those on an ancestor
re-anchors it — silently, because the video keeps decoding and the audio keeps playing while the
picture is never seen. WhatsApp also sends the "viewed" receipt on *open* rather than on playback,
so this presented as status registering as watched with nothing on screen.

A single `:is(...):has(video)` rule undoes all of it, over the complete set of containers the
stylesheet can reach. That list (`OVERLAY_CONTAINERS`) is the only place it exists — a selector
added to the glass rules has to be added there too, or the guarantee quietly stops holding.

## Configuration

Create `colors.json` next to `main.js`. Every key is optional and every value is validated —
unparseable colours fall back to the scheme or the built-in default, and out-of-range numbers clamp.

```json
{
  "followSystem": true,
  "blur": 20,
  "saturate": 180,
  "veil": 0.74,
  "opacity": 0.55
}
```

| Key | Type | Range | Default (dark / light) | Meaning |
| --- | --- | --- | --- | --- |
| `followSystem` | bool | — | `false` | Take the background from the OS when the scheme supplies none — see the caveat below |
| `blur` | number | 0–80 | `20` | `backdrop-filter` blur radius, px |
| `saturate` | number | 100–400 | `180` | `backdrop-filter` saturation, % |
| `veil` | number | 0–1 | `0.74` / `0.86` | Page-background opacity over the wallpaper |
| `opacity` | number | 0.05–1 | `0.55` / `0.72` | Panel opacity |
| `bg` | colour | — | `#0b0e11` / `#f0f2f5` | Page background |
| `panel` | colour | — | from the M3 elevation ladder | Panel tint; overrides the ladder |
| `incoming` | colour | — | `#202c33` / `#ffffff` | Incoming bubble fill |
| `outgoing` | colour | — | `#005c4b` / `#d9fdd3` | Outgoing bubble fill |
| `primary` | colour | — | `#e9edef` / `#111b21` | Body text |
| `secondary` | colour | — | `#aebac1` / `#667781` | Supporting text and icons |
| `accent` | colour | — | `#00a884` | Links, read receipts, send button |

Those are the **requested** values, not necessarily what gets painted. Text colours are blended
further until they clear their floor, so a `#00a884` accent on a dark scheme resolves lighter — that
is the contrast guarantee working, not the override being ignored. `opacity` is likewise adjusted by
the panel-separation repair when the requested alpha doesn't separate the panel from the page.

Colours accept Caelestia's bare 6-digit hex (`0f0e08`, no `#`) as the primary format, plus `#rgb`,
`#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, and `white` / `black` / `transparent`.

#### A note on `followSystem`

The OS appearance only ever selects the **fallback** background. Resolution order is
`colors.json` → `scheme.background` → `#0b0e11` / `#f0f2f5`, and `followSystem` only affects that
last step. So it does nothing when the scheme provides a usable `background` token — set `bg`
directly if you want to force an appearance. This is deliberate: the tokens are what actually get
painted, so letting the OS pick a background the scheme's text tokens were never paired with is how
you get black text on a near-black panel.

Both files are watched, so edits apply live without a restart. Editors that replace the inode
(temp-write + rename) are covered by a poller as well as `fs.watch`.

## Safari identity

Three layers have to agree or WhatsApp sees a contradiction and may serve the wrong build:

- the navigation's user-agent string — `setUserAgent`
- the `sec-ch-ua` client hints, which advertise the real engine — rewritten in a
  `webRequest.onBeforeSendHeaders` filter, and only sent on encrypted requests
- `navigator.userAgent` inside the page — fixed by the UA string above

The hints are *rewritten* rather than removed, because some servers fall back to "no hints, assume
modern browser" when hints are absent, which is worse than an explicit Safari claim.

## Notes

- The window is `transparent` — required for the wallpaper to show through the blur.
- `nodeIntegration` is off, `contextIsolation` and `sandbox` are on. WhatsApp Web is untrusted input.
- `backgroundThrottling` is off, so a window sitting behind another one keeps compositing.
- Navigation is pinned to `web.whatsapp.com`; anything else opens in the real browser.
- `prefers-reduced-motion` is honoured.

## License

MIT