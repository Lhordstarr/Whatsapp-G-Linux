'use strict';

/**
 * The window icon has no colour or layout to regress, so nothing else in the
 * suite can notice it breaking - and it breaks silently. A missing or truncated
 * file does not throw: Electron's nativeImage hands back an empty image and the
 * window simply shows a default icon, which reads as "the theme never set an
 * icon" rather than as a bug.
 *
 * The checks here are deliberately at the level a plain Node test can reach: the
 * PNG header carries the dimensions in the file itself, so a wrong size or a
 * truncated write is detectable without decoding the image. Confirming that
 * Electron's decoder is happy needs a real Electron process, which this suite
 * does not start.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER = path.join(ROOT, 'assets', 'icon.png');
const SET_DIR = path.join(ROOT, 'assets', 'icons');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const PNG_MAGIC = 0x89504e47;

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

/** Dimensions read out of the IHDR chunk, which sits at a fixed offset. */
function pngSize(file) {
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.readUInt32BE(0) !== PNG_MAGIC) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

test('the icon master exists and is a readable square PNG', () => {
  const size = pngSize(MASTER);
  assert.ok(size, `assets/icon.png is missing or not a PNG (run: npm run build:icon)`);
  assert.strictEqual(
    size.width,
    size.height,
    `assets/icon.png is ${size.width}x${size.height}; the set is resampled square, so a non-square master skews every size`
  );
  assert.ok(
    size.width >= Math.max(...SIZES),
    `assets/icon.png is ${size.width}px, too small to fill the ${Math.max(...SIZES)}px set without upscaling`
  );
});

test('every icon in the set exists at its declared size', () => {
  for (const want of SIZES) {
    const file = path.join(SET_DIR, `${want}.png`);
    const size = pngSize(file);
    assert.ok(size, `assets/icons/${want}.png is missing or not a PNG`);
    assert.strictEqual(size.width, want, `assets/icons/${want}.png is ${size.width}px wide`);
    assert.strictEqual(size.height, want, `assets/icons/${want}.px is ${size.height}px tall`);
  }
});

test('the window is pointed at the master, not at a set member', () => {
  // createWindow hands nativeImage a single path. Pointing it at the 16px copy
  // works on every platform and looks wrong on every platform, and nothing else
  // here would notice.
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const line = src.match(/^\s*icon:\s*path\.join\(__dirname,\s*([^)]+)\)/m);
  assert.ok(line, 'createWindow sets no path.join(__dirname, ...) icon');

  // Collect the segments rather than counting them: a hard-coded count turns
  // every added or removed segment into "no icon path at all", which is a
  // misleading thing to tell someone debugging a real regression.
  const segments = line[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.deepStrictEqual(
    segments,
    ['assets', 'icon.png'],
    `the window is handed ${segments.join('/')}, not the master assets/icon.png`
  );
  assert.ok(
    pngSize(path.join(ROOT, ...segments)),
    `the window is handed ${segments.join('/')}, which is not a readable PNG`
  );
});

test('the build script resamples the master rather than a vector', () => {
  // The script used to rasterise assets/icon.svg. If it ever goes back to
  // reading a vector, or back to writing the master itself, running
  // `npm run build:icon` will overwrite the icon with something else - and the
  // damage only shows up the next time someone runs it.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-icon.js'), 'utf8');
  const source = src.match(/SOURCE\s*=\s*path\.join\([^)]*'([^']+)'\s*,\s*'([^']+)'\s*\)/);
  assert.ok(source, 'build-icon.js has no SOURCE');
  assert.strictEqual(
    path.join(source[1], source[2]),
    path.join('assets', 'icon.png'),
    `build-icon.js reads ${source[1]}/${source[2]} as its source`
  );
  assert.ok(
    !/rsvg|resvg|SOURCE,\s*'-w'/.test(src),
    'build-icon.js still rasterises a vector; the master is a raster now'
  );
});

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n${failures.length}/${total} FAILED:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nall ${total} icon tests pass`);