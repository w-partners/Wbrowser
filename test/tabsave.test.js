// tabsave — what gets remembered, and what is reported missing after a restart.
//
// 🔴 Why each rule is here: a restart to apply a flag left 1 of 2 tabs open (2026-10-02), and
//    the other was recovered only because a person had written the URL down first. The list
//    has to be right, because by the time anyone reads it the tabs are already gone.
//
// Pure functions, no Chrome.
const assert = require('assert');
const ts = require('../tabsave');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); } catch (e) {
    failures += 1; console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

console.log('tabsave:');

check('keeps real pages', () => {
  assert.ok(ts.worthSaving({ type: 'page', url: 'https://example.com/x', title: 'X' }));
});

check('drops blanks, chrome:// and devtools — they carry no intent', () => {
  assert.ok(!ts.worthSaving({ type: 'page', url: 'about:blank' }));
  assert.ok(!ts.worthSaving({ type: 'page', url: 'chrome://newtab/' }));
  assert.ok(!ts.worthSaving({ type: 'page', url: 'devtools://devtools/x.html' }));
  assert.ok(!ts.worthSaving({ type: 'page', url: 'file:///tmp/a.html' }));
});

check('drops non-page targets (workers, iframes)', () => {
  assert.ok(!ts.worthSaving({ type: 'service_worker', url: 'https://example.com/sw.js' }));
  assert.ok(!ts.worthSaving({ type: 'iframe', url: 'https://example.com/f' }));
});

check('drops our own CDP endpoints — reopening those helps nobody', () => {
  assert.ok(!ts.worthSaving({ type: 'page', url: 'http://127.0.0.1:9222/json/list' }));
});

check('deduplicates by URL, keeping the first title', () => {
  const out = ts.planSave([
    { type: 'page', url: 'https://a.com/', title: 'A rendered' },
    { type: 'page', url: 'https://a.com/', title: '' },
    { type: 'page', url: 'https://b.com/', title: 'B' },
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].title, 'A rendered');
});

check('missing() reports only what did NOT come back', () => {
  const saved = [{ url: 'https://a.com/' }, { url: 'https://b.com/' }];
  const openNow = [{ type: 'page', url: 'https://a.com/', title: 'A' }];
  const gone = ts.missing(saved, openNow);
  assert.strictEqual(gone.length, 1);
  assert.strictEqual(gone[0].url, 'https://b.com/');
});

check('missing() with nothing open reports everything saved', () => {
  const saved = [{ url: 'https://a.com/' }, { url: 'https://b.com/' }];
  assert.strictEqual(ts.missing(saved, []).length, 2);
});

check('missing() tolerates a null/garbage current list rather than throwing', () => {
  assert.strictEqual(ts.missing([{ url: 'https://a.com/' }], null).length, 1);
  assert.strictEqual(ts.missing(null, []).length, 0);
});

check('a long title is truncated, the URL never is', () => {
  const long = 'T'.repeat(500);
  const out = ts.planSave([{ type: 'page', url: 'https://a.com/very/long/path?q=1', title: long }]);
  assert.ok(out[0].title.length <= 120);
  assert.strictEqual(out[0].url, 'https://a.com/very/long/path?q=1',
    'the URL is what gets reopened — truncating it would hand back a broken link');
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passing');
