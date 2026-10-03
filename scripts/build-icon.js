'use strict';

/**
 * Resample assets/icon.png into the icon set the desktop uses.
 *
 * assets/icon.png is the source of truth: it is the master the window is handed
 * and the image everything else is derived from. Electron's NativeImage cannot
 * read SVG, and it cannot usefully upscale either, so the master is a raster
 * and the only job here is producing clean smaller copies of it.
 *
 * This used to rasterise assets/icon.svg instead, at 4x and downsampled -
 * supersampling only makes sense when the source is vector, since a raster has
 * no detail to resolve at a higher resolution first. With a raster master a
 * single Lanczos step is both simpler and better: ImageMagick scales the filter
 * support for the destination, so a 500px master to 16px is area-averaged
 * rather than point-sampled.
 *
 * Regenerate whenever the master changes, or the small sizes - which are the
 * ones that actually need to stay legible - drift away from it. That drift is
 * silent: nothing fails, the icon just stops matching its own source.
 *
 * Needs ImageMagick's `magick` on PATH.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'icon.png');
const SET_DIR = path.join(ROOT, 'assets', 'icons');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function requireMagick() {
  try {
    execFileSync('magick', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('ImageMagick not found. Install one of:');
    console.error('  Arch:             pacman -S imagemagick');
    console.error('  Debian/Ubuntu:    apt install imagemagick');
    console.error('  Fedora:           dnf install ImageMagick');
    process.exit(1);
  }
}

/**
 * Check the output actually is the PNG we asked for.
 *
 * A wrong size or a truncated file would otherwise land in the repo looking
 * plausible, and the next run would treat it as an unchanged input.
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

/** The master's own dimensions, read from the PNG header rather than trusted. */
function masterSize() {
  const header = fs.readFileSync(SOURCE);
  if (header.length < 24 || header.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('assets/icon.png is not a PNG');
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function resize(size, out) {
  // -strip drops ImageMagick's tIME chunk and other metadata, so a rebuild of
  // an unchanged master is byte-identical and `git diff` stays meaningful.
  execFileSync(
    'magick',
    [SOURCE, '-filter', 'Lanczos', '-resize', `${size}x${size}!`, '-strip', out],
    { stdio: 'ignore' }
  );
  assertRendered(out, size);
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`missing master: ${path.relative(ROOT, SOURCE)}`);
    process.exit(1);
  }
  requireMagick();

  const master = masterSize();
  if (master.width !== master.height) {
    console.error(`assets/icon.png is ${master.width}x${master.height}, expected square`);
    process.exit(1);
  }
  const largest = Math.max(...SIZES);
  if (largest > master.width) {
    // Upscaling a raster invents nothing and looks like mush at the sizes that
    // matter. Worth stopping for rather than quietly emitting soft icons.
    console.error(
      `assets/icon.png is ${master.width}px; cannot produce ${largest}px without upscaling`
    );
    process.exit(1);
  }

  fs.mkdirSync(SET_DIR, { recursive: true });

  const started = Date.now();
  const written = [];
  for (const size of SIZES) {
    const out = path.join(SET_DIR, `${size}.png`);
    resize(size, out);
    written.push(out);
  }

  console.log(`resampled from assets/icon.png (${master.width}px master)`);
  for (const file of written) {
    console.log(`  ${path.relative(ROOT, file)}  ${(fs.statSync(file).size / 1024).toFixed(1)} KiB`);
  }
  console.log(`${written.length} files in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main();