'use strict';

/**
 * Rasterise assets/icon.svg into the PNGs the window and the desktop use.
 *
 * assets/icon.svg is the source of truth. Electron's NativeImage cannot read
 * SVG, so the window is handed a PNG and the checked-in rasters have to be
 * regenerated whenever the source changes - otherwise the icon silently drifts
 * away from the palette it is supposed to be drawn from.
 *
 * Renders at 4x and downsamples, because a 16px icon drawn at 16px and one
 * downsampled from 512px are not the same pixels, and the small sizes are the
 * ones that need the extra samples to stay legible.
 *
 * Needs librsvg (rsvg-convert) or resvg on PATH. Both are in the Arch, Debian
 * and Fedora base repos; the script picks whichever it finds.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'icon.svg');
const PRIMARY = path.join(ROOT, 'assets', 'icon.png');
const SET_DIR = path.join(ROOT, 'assets', 'icons');

/** 512 is what BrowserWindow is handed; the rest are for desktop integration. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Supersample factor. 4x is the point where the 16px stop stops being mush. */
const SUPERSAMPLE = 4;

function findRenderer() {
  const candidates = [
    ['rsvg-convert', (size, out) => ['-w', size, '-h', size, SOURCE, '-o', out]],
    ['resvg', (size, out) => ['--width', String(size), SOURCE, out]],
  ];
  for (const [bin, argv] of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return { bin, argv };
    } catch {
      /* not installed, try the next one */
    }
  }
  return null;
}

/**
 * Check the renderer actually produced a PNG before trusting it.
 *
 * Some builds accept SVG features they cannot rasterise and emit a warning
 * plus a blank canvas, which would otherwise land in the repo as a working
 * file full of nothing.
 */
function assertRendered(file, expectedSize) {
  if (!fs.existsSync(file)) throw new Error(`${path.basename(file)}: not written`);
  const header = fs.readFileSync(file);
  if (header.length < 8 || header.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`${path.basename(file)}: not a PNG`);
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(
      `${path.basename(file)}: ${width}x${height}, expected ${expectedSize}x${expectedSize}`
    );
  }
}

function render(renderer, size, out) {
  // The supersampled frame is staged beside its output, not in os.tmpdir():
  // that is a different filesystem under some setups, and renameSync across
  // devices fails with EXDEV.
  const big = `${out}.supersampled.png`;
  try {
    execFileSync(renderer.bin, renderer.argv(size * SUPERSAMPLE, big), { stdio: 'ignore' });
    assertRendered(big, size * SUPERSAMPLE);

    // -strip drops librsvg's tIME chunk and other metadata, so a rebuild of an
    // unchanged source is byte-identical and `git diff` stays meaningful.
    execFileSync(
      'magick',
      [big, '-filter', 'Lanczos', '-resize', `${size}x${size}!`, '-strip', out],
      { stdio: 'ignore' }
    );
    assertRendered(out, size);
  } finally {
    // Never leave the multi-megabyte frame behind, even on failure.
    if (fs.existsSync(big)) fs.unlinkSync(big);
  }
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`missing source: ${path.relative(ROOT, SOURCE)}`);
    process.exit(1);
  }
  const renderer = findRenderer();
  if (!renderer) {
    console.error('No SVG rasteriser found. Install one of:');
    console.error('  Arch/Debian/Fedora:  pacman -S librsvg   /   apt install librsvg2-bin   /   dnf install librsvg2-tools');
    console.error('  or:                  cargo install resvg');
    process.exit(1);
  }

  fs.mkdirSync(SET_DIR, { recursive: true });

  const started = Date.now();
  render(renderer, 512, PRIMARY);
  const written = [PRIMARY];
  for (const size of SIZES) {
    const out = path.join(SET_DIR, `${size}.png`);
    render(renderer, size, out);
    written.push(out);
  }

  console.log(`rasterised with ${renderer.bin} at ${SUPERSAMPLE}x`);
  for (const file of written) {
    console.log(`  ${path.relative(ROOT, file)}  ${(fs.statSync(file).size / 1024).toFixed(1)} KiB`);
  }
  console.log(`${written.length} files in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main();