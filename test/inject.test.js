'use strict';

/**
 * The upsert source has to survive being parsed by the page, and the CSS has to
 * arrive byte-for-byte. Both are easy to break with a stray quote or newline,
 * and neither shows up as a test failure elsewhere - the page just silently
 * renders unthemed. So assert on the real thing: build the source, run it in a
 * throwaway vm context that mimics the DOM, and compare what landed.
 */

const Module = require('module');
const assert = require('assert');
const path = require('path');
const vm = require('vm');

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

const buildUpsertSource = main.buildUpsertSource;
assert.strictEqual(typeof buildUpsertSource, 'function', 'buildUpsertSource must be exported');

/** Run the source the way the page would, and report what it did. */
function runInPage(source) {
  const attrs = {};
  const props = {};
  const head = { children: [] };
  head.appendChild = (el) => head.children.push(el);

  const root = {
    style: { setProperty: (k, v) => { props[k] = v; } },
    setAttribute: (k, v) => { attrs[k] = v; },
  };
  const document = {
    documentElement: root,
    head,
    createElement: () => ({
      id: '',
      textContent: '',
      setAttribute(k, v) { this[k] = v; },
    }),
    getElementById: (id) => head.children.find((c) => c.id === id) || null,
  };

  const context = vm.createContext({ document });
  const result = vm.runInContext(source, context, { timeout: 2000 });
  return { result, attrs, props, head, node: head.children[0] || null };
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

const STYLE_ID = 'whatsapp-glass-mask';
const CSS = `:root{color-scheme:dark}
.message-in > div{background:rgba(15,14,8,0.45);backdrop-filter:blur(20px) saturate(140%)}
a[href^="http"]::after{content:"\\201C";}
body{font-family:"Inter",'Segoe UI',sans-serif}`;

test('source parses and reports success', () => {
  const out = runInPage(buildUpsertSource(STYLE_ID, CSS, 'dark'));
  assert.strictEqual(out.result, true, 'upsert did not report success');
});

test('style node is created with the right id and marker', () => {
  const out = runInPage(buildUpsertSource(STYLE_ID, CSS, 'dark'));
  assert.ok(out.node, 'no <style> node created');
  assert.strictEqual(out.node.id, STYLE_ID);
  assert.strictEqual(out.node['data-glass'], 'true');
  assert.strictEqual(out.head.children.length, 1, 'created more than one node');
});

test('CSS arrives byte-for-byte', () => {
  const out = runInPage(buildUpsertSource(STYLE_ID, CSS, 'dark'));
  assert.strictEqual(out.node.textContent, CSS, 'stylesheet was altered in transit');
});

test('mode lands on the element and as a custom property', () => {
  for (const mode of ['dark', 'light']) {
    const out = runInPage(buildUpsertSource(STYLE_ID, CSS, mode));
    assert.strictEqual(out.attrs['data-glass-mode'], mode, `data-glass-mode wrong for ${mode}`);
    assert.strictEqual(out.props['color-scheme'], mode, `color-scheme wrong for ${mode}`);
  }
});

test('re-running reuses the node instead of stacking copies', () => {
  const head = { children: [] };
  head.appendChild = (el) => head.children.push(el);
  const document = {
    documentElement: { style: { setProperty() {} }, setAttribute() {} },
    head,
    createElement: () => ({ id: '', textContent: '', setAttribute(k, v) { this[k] = v; } }),
    getElementById: (id) => head.children.find((c) => c.id === id) || null,
  };
  const context = vm.createContext({ document });
  const src = buildUpsertSource(STYLE_ID, CSS, 'dark');

  for (let i = 0; i < 5; i++) {
    assert.strictEqual(vm.runInContext(src, context), true, `pass ${i} failed`);
  }
  assert.strictEqual(head.children.length, 1, 'the upsert leaked duplicate nodes');
});

test('CSS that would break out of the literal stays inert', () => {
  // The classic killers: a closing quote, a backslash-newline, and a
  // template-literal sequence. All of these appear in real stylesheets.
  const hostile = [
    'a{content:";}document.title="pwned";',
    'b{content:"unterminated',
    'c{content:"back\\\\\nslash"}',
    'd{content:"`${process}" }',
    'e{content:"\'single\'"}',
  ].join('\n');

  const out = runInPage(buildUpsertSource(STYLE_ID, hostile, 'dark'));
  assert.strictEqual(out.result, true, 'hostile CSS broke the upsert');
  assert.strictEqual(out.node.textContent, hostile, 'hostile CSS was not preserved verbatim');
});

test('mode cannot be used to inject a second statement', () => {
  const out = runInPage(buildUpsertSource(STYLE_ID, CSS, 'dark"; document.title="pwned; "'));
  assert.strictEqual(out.attrs['data-glass-mode'], 'dark"; document.title="pwned; "');
  // A literal backslash-u sequence must stay text, not become a real U+2028.
  assert.strictEqual(out.node.textContent, CSS);
});

test('id containing a quote cannot create a second element', () => {
  const out = runInPage(buildUpsertSource('id"); document.title="x', CSS, 'dark'));
  assert.strictEqual(out.node.id, 'id"); document.title="x');
  assert.strictEqual(out.head.children.length, 1);
});

test('U+2028 and U+2029 survive as escapes, not line terminators', () => {
  const css = 'a{content:"x\u2028y\u2029z"}';
  const source = buildUpsertSource(STYLE_ID, css, 'dark');
  // The raw separators must not appear: they would end the literal early.
  assert.ok(!/[\u2028\u2029]/.test(source), 'raw line separator leaked into the source');
  assert.ok(source.includes('\\u2028') && source.includes('\\u2029'), 'separators not escaped');
  const out = runInPage(source);
  assert.strictEqual(out.node.textContent, css, 'separators mangled in transit');
});

test('source has no leftover placeholders or undefined identifiers', () => {
  const upsert = buildUpsertSource(STYLE_ID, CSS, 'dark');
  assert.ok(!/undefined|NaN|\$\{/.test(upsert), 'unresolved value in source');
  assert.ok(upsert.trim().startsWith('(() =>'), 'not a self-invoking expression');
});

test('a fresh document gets a node even when the CSS is unchanged', () => {
  // Models the reload case at the page level: the <style> node dies with the
  // document, so the same source run against a new document must rebuild it
  // rather than assume the previous document's node is still there.
  for (let doc = 0; doc < 3; doc++) {
    const out = runInPage(buildUpsertSource(STYLE_ID, CSS, 'dark'));
    assert.strictEqual(out.result, true, `document ${doc}: upsert failed`);
    assert.strictEqual(out.head.children.length, 1, `document ${doc}: wrong node count`);
    assert.strictEqual(out.node.textContent, CSS, `document ${doc}: CSS missing`);
  }
});

/* ------------------------------------------------------------------ *
 * Lifecycle wiring
 *
 * Every bug this shell shipped came from the same place: an event that never
 * fires, or that fires while isLoading() is still true. That wiring lives in
 * createWindow(), out of reach of a unit test, so assert on the registrations
 * directly. Every name below exists because omitting it was a real bug.
 * ------------------------------------------------------------------ */

const shell = require('fs').readFileSync(path.resolve(__dirname, '..', 'main.js'), 'utf8');

test('hooks the events that actually clear isLoading()', () => {
  for (const event of ['dom-ready', 'did-finish-load', 'did-stop-loading', 'did-navigate-in-page']) {
    assert.ok(shell.includes(`'${event}'`), `lifecycle event ${event} is not hooked`);
  }
});

test('invalidates the dedup cache on every navigation', () => {
  // Without this a reload destroys the node while lastCss still claims the CSS
  // was delivered, and the reloaded page renders unthemed.
  assert.ok(shell.includes('did-start-navigation'), 'navigation start is not observed');
  assert.ok(
    /did-start-navigation[\s\S]{0,400}lastCss\s*=\s*''/.test(shell),
    'navigation does not reset lastCss'
  );
});

test('does not cache the CSS before the isLoading() bail', () => {
  const body = shell.slice(shell.indexOf('function inject('));
  const bailAt = body.indexOf('isLoading()) return');
  const cacheAt = body.indexOf('lastCss = css;');
  assert.ok(bailAt !== -1 && cacheAt !== -1, 'expected both the bail and the cache write');
  assert.ok(bailAt < cacheAt, 'lastCss is written before the bail, so retries get swallowed');
});

test('passes no extra arguments to executeJavaScript', () => {
  // executeJavaScript(code, userGesture) has no argument pass-through; extra
  // arguments make the internal IPC clone fail and the promise reject.
  const open = shell.indexOf('.executeJavaScript(');
  assert.ok(open !== -1, 'no executeJavaScript call found');
  const start = open + '.executeJavaScript'.length;

  // Walk the argument list counting only commas at depth 1, so commas inside
  // a nested call are not mistaken for argument separators.
  let depth = 0;
  let commas = 0;
  let end = -1;
  for (let i = start; i < shell.length; i++) {
    const ch = shell[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    } else if (ch === ',' && depth === 1) {
      commas += 1;
    }
  }
  assert.notStrictEqual(end, -1, 'unbalanced executeJavaScript call');
  assert.strictEqual(commas, 0, `executeJavaScript is called with extra arguments: ${shell.slice(start, end + 1)}`);
});

test('declares color-scheme from the palette in both places', () => {
  // The stylesheet uses !important, which outranks the inline property the
  // upsert sets. Two independent sources would disagree silently.
  const declared = shell.match(/color-scheme: \$\{(\w+)\.mode\}/);
  assert.ok(declared, 'stylesheet color-scheme is not driven by the palette mode');

  const inject = shell.slice(shell.indexOf('function inject('));
  const inline = inject.match(/const mode = ([\w.]+);/);
  assert.ok(inline, 'inject() does not assign an inline mode');
  assert.strictEqual(
    inline[1],
    `${declared[1]}.mode`,
    'the inline and stylesheet color-scheme derive the mode from different sources'
  );
});

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n${failures.length}/${total} FAILED:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nall ${total} upsert tests pass`);
