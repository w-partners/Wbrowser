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


// ---- launch.js wiring -----------------------------------------------------
// 🔴 Structural, because the bug here was ORDER, not logic. Snapshotting before reporting
//    makes "no record yet" impossible to observe: the fresh write satisfies the very check
//    that was meant to warn about its absence. Measured 2026-10-02 — with the wrong order
//    the warning never printed on a machine that had just lost its tabs.
const fs = require('fs');
const path = require('path');
const LAUNCH = fs.readFileSync(path.join(__dirname, '..', 'launch.js'), 'utf8');
const LAUNCH_LINES = LAUNCH.split('\n');
const codeLine = (l) => {
  const t = l.trim();
  return t && !t.startsWith('//') && !t.startsWith('*');
};

check('launch.js reports missing tabs BEFORE taking a new snapshot, on every path', () => {
  const calls = [];
  LAUNCH_LINES.forEach((l, i) => {
    if (!codeLine(l)) return;
    if (/await\s+reportMissingTabs\(\)/.test(l)) calls.push({ i, what: 'report' });
    if (/await\s+snapshotTabs\(\)/.test(l)) calls.push({ i, what: 'snapshot' });
  });
  assert.ok(calls.length >= 4,
    `expected both calls on both paths (launch + ALREADY_UP); found ${calls.length}`);
  // Walk in file order: every snapshot must be preceded by a report that is not yet paired.
  let pendingReport = false;
  for (const c of calls) {
    if (c.what === 'report') { pendingReport = true; continue; }
    assert.ok(pendingReport,
      `snapshotTabs() at line ${c.i + 1} runs without a preceding reportMissingTabs() — `
      + 'writing first hides "no record yet" from the person who needs it');
    pendingReport = false;
  }
});

check('launch.js writes the snapshot itself, not only the engine', () => {
  // 🔴 The original design had only engine.js writing it, so a machine that runs Chrome
  //    without the engine never built a record — and that was the machine that lost tabs.
  assert.ok(/async function snapshotTabs\(\)/.test(LAUNCH),
    'launch.js must take its own snapshot; relying on the engine leaves engine-less hosts blind');
  assert.ok(/require\('\.\/tabsave'\)[\s\S]{0,200}\.save\(/.test(LAUNCH),
    'snapshotTabs() should call tabsave.save()');
});

check('the healthy autoplay case prints something too', () => {
  // 🔵 With only the failure path printing, "checked and fine" and "never checked" were the
  //    same silence (reported 2026-10-02).
  assert.ok(/autoplay\s+✅/.test(LAUNCH),
    'a positive line must exist so a silent run is distinguishable from an unchecked one');
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passing');
