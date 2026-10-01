'use strict';

/**
 * Safari identity tests.
 *
 * The UA is only half the story. WhatsApp sees the user-agent string, the
 * sec-ch-ua client hints, and the JS-visible navigator.* properties, and those
 * three have to agree. A Safari UA next to Chromium's client hints is a
 * contradiction that capability detection resolves in Chromium's favour, which
 * is how a "Safari" request still gets the Chrome build.
 *
 * The header rewrite is asserted here against a fake session rather than by
 * watching the wire: Electron keeps one onBeforeSendHeaders handler per
 * session, so an outside listener silently replaces the real one and reports
 * an empty request list - a passing test that checked nothing.
 */

const Module = require('module');
const assert = require('assert');
const path = require('path');

const electronStub = {
  app: {
    getPath: () => process.env.HOME,
    getAppPath: () => path.resolve(__dirname, '..'),
    whenReady: () => new Promise(() => {}),
    on() {},
    quit() {},
  },
  BrowserWindow: Object.assign(function () {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: true, themeSource: 'system', on() {} },
  shell: { openExternal: async () => {} },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? electronStub : load(request, ...rest);
};
const main = require('../main.js');
Module._load = load;

const { applySafariUA, SAFARI_UA } = main;

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

/** Stand-in for webContents that records what applySafariUA does to it. */
function fakeContents(requestHeaders) {
  const calls = { setUserAgent: null, filter: null };
  let handler = null;

  const contents = {
    setUserAgent: (ua) => {
      calls.setUserAgent = ua;
    },
    session: {
      webRequest: {
        onBeforeSendHeaders: (filter, fn) => {
          calls.filter = filter;
          handler = fn;
        },
      },
    },
    calls,
    /** Run the registered header filter and return what it produced. */
    run: () => {
      assert.ok(handler, 'no onBeforeSendHeaders handler was registered');
      let out = null;
      handler({ url: 'https://web.whatsapp.com/', requestHeaders }, (_r) => {
        out = _r.requestHeaders;
      });
      assert.ok(out, 'the filter never invoked its callback');
      return out;
    },
  };

  return contents;
}

const CHROMIUM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/140.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
  'Sec-CH-UA-Arch': '"x86"',
  'Sec-CH-UA-Bitness': '"64"',
  'Sec-CH-UA-Full-Version': '140.0.7339.80',
  'Sec-CH-UA-Model': '',
  'Sec-CH-UA-Platform-Version': '"6.1.0"',
  'Sec-CH-UA-WoW64': '?0',
  'Upgrade-Insecure-Requests': '1',
  Accept: 'text/html,application/xhtml+xml',
};

test('the UA string identifies Safari and not Chrome', () => {
  assert.ok(/AppleWebKit/.test(SAFARI_UA), 'not a WebKit UA');
  assert.ok(/Version\/[\d.]+ Safari\//.test(SAFARI_UA), 'missing the Safari version token');
  assert.ok(!/Chrom(e|ium)/i.test(SAFARI_UA), 'UA still advertises Chrome');
  // Safari reports macOS; a MacIntel string is what the hints now claim too.
  assert.ok(/Macintosh/.test(SAFARI_UA), 'UA does not claim macOS');
});

test('setUserAgent is called with the Safari string', () => {
  const c = fakeContents({ ...CHROMIUM_HEADERS });
  applySafariUA(c);
  assert.strictEqual(c.calls.setUserAgent, SAFARI_UA);
});

test('the header filter covers https, where hints are sent', () => {
  const c = fakeContents({ ...CHROMIUM_HEADERS });
  applySafariUA(c);
  assert.ok(c.calls.filter, 'no filter registered');
  assert.ok(
    c.calls.filter.urls.some((u) => u.startsWith('https://')),
    'filter does not cover https, so client hints would pass through untouched'
  );
});

test('the UA header is rewritten', () => {
  const c = fakeContents({ ...CHROMIUM_HEADERS });
  applySafariUA(c);
  const out = c.run();
  assert.strictEqual(out['User-Agent'], SAFARI_UA);
  assert.ok(!/Chrom(e|ium)/i.test(out['User-Agent']), 'Chromium UA survived');
});

test('client hints stop contradicting the UA', () => {
  const c = fakeContents({ ...CHROMIUM_HEADERS });
  applySafariUA(c);
  const out = c.run();

  const joined = `${out['sec-ch-ua']} ${out['sec-ch-ua-platform']}`;
  assert.ok(!/Chrom/i.test(joined), `hints still advertise Chromium: ${joined}`);
  assert.ok(/Safari/.test(out['sec-ch-ua']), 'hints do not advertise Safari');
  assert.ok(/macOS/.test(out['sec-ch-ua-platform']), 'platform hint is not macOS');
  assert.strictEqual(out['sec-ch-ua-mobile'], '?0', 'mobile hint should be desktop');
});

test('hints are rewritten, not dropped', () => {
  // Some servers treat absent hints as "assume modern" and pick the Chromium
  // build anyway, so an explicit Safari claim beats no claim at all.
  const c = fakeContents({ ...CHROMIUM_HEADERS });
  applySafariUA(c);
  const out = c.run();
  for (const header of ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']) {
    assert.ok(out[header] !== undefined, `${header} was removed instead of rewritten`);
  }
});

test('Chrome-only hints are removed', () => {
  const c = fakeContents({ ...CHROMIUM_HEADERS });
  applySafariUA(c);
  const out = c.run();
  for (const header of [
    'Sec-CH-UA-Arch',
    'Sec-CH-UA-Bitness',
    'Sec-CH-UA-Full-Version',
    'Sec-CH-UA-Model',
    'Sec-CH-UA-Platform-Version',
    'Sec-CH-UA-WoW64',
    'Upgrade-Insecure-Requests',
  ]) {
    assert.ok(!(header in out), `${header} survived; Safari never sends it`);
  }
});

test('unrelated headers are left alone', () => {
  const c = fakeContents({ ...CHROMIUM_HEADERS });
  applySafariUA(c);
  const out = c.run();
  assert.strictEqual(out.Accept, CHROMIUM_HEADERS.Accept, 'Accept was modified');
});

test('the original headers are not mutated in place', () => {
  // Mutating the shared object would leak across requests and make the
  // rewrite order-dependent.
  const original = { ...CHROMIUM_HEADERS };
  const c = fakeContents(original);
  applySafariUA(c);
  c.run();
  assert.strictEqual(original['User-Agent'], CHROMIUM_HEADERS['User-Agent'], 'input was mutated');
  assert.ok(original['Sec-CH-UA-Arch'] !== undefined, 'a key was deleted from the input');
});

test('repeated application stays idempotent', () => {
  const first = fakeContents({ ...CHROMIUM_HEADERS });
  applySafariUA(first);
  const once = first.run();
  const second = fakeContents({ ...once });
  applySafariUA(second);
  assert.deepStrictEqual(second.run(), once, 'a second pass changed the headers');
});

test('createWindow applies the identity before the first load', () => {
  // setUserAgent after loadURL would leave the first request on the real UA.
  const shell = require('fs').readFileSync(path.resolve(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(shell.includes('applySafariUA(win.webContents)'), 'applySafariUA is never called');
  const applied = shell.indexOf('applySafariUA(win.webContents)');
  const loaded = shell.indexOf('win.loadURL(');
  assert.ok(applied !== -1 && loaded !== -1, 'expected both the apply and the load');
  assert.ok(applied < loaded, 'the UA is applied after the load, so request one is unspoofed');
});

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n${failures.length}/${total} FAILED:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nall ${total} Safari identity tests pass`);
