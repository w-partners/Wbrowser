// /health must not say "the browser is not running" while Chrome is holding the user's tabs.
//
// 🔴 Measured 2026-10-02: playwright 1.63 could not attach to Chrome 154, so connect() threw,
//    and /health answered `browser:false` with the hint "start it with node launch.js" — while
//    /json/list returned 29 pages in 13ms, including the master's X tabs. That hint sends a
//    person to launch a second browser and leaves the real cause (attach, not Chrome) unnamed.
//    This is the censorship failure from CLAUDE.md: the value existed and was discarded.
//
// Structural, because the defect is in WHICH question the code asks, and reproducing the real
// thing needs a Chrome/playwright version mismatch we cannot create on demand.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); } catch (e) {
    failures += 1; console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

console.log('health tells the truth about Chrome:');

const ENGINE = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');

// The failure branch of /health: from the catch after connect() to the end of its response.
const m = ENGINE.match(/const stale = \/stale playwright contexts\/i[\s\S]{0,3000}?\}, null, 2\)\);/);
check('the attach-failure branch of /health is findable', () => {
  assert.ok(m, 'could not locate the catch branch — update this test if /health was restructured');
});

const BRANCH = m ? m[0] : '';

check('it asks Chrome directly before concluding anything', () => {
  assert.ok(/json\/list|json\/version/.test(BRANCH),
    'the branch must probe Chrome over raw HTTP; playwright is the thing that just failed, '
    + 'so it cannot be the witness to whether Chrome exists');
  assert.ok(/getJSON/.test(BRANCH),
    'use rawcdp.getJSON rather than a second copy of the same HTTP call');
});

check('"not running" is reachable ONLY when Chrome did not answer', () => {
  const i = BRANCH.indexOf('The browser is not running');
  assert.ok(i > 0, 'the message should still exist — it is correct when Chrome really is down');
  // 🔴 Check the OPERAND of the ternary, not just that the word chromeUp appears somewhere
  //    earlier. A first version of this test only searched for the identifier, so replacing
  //    the condition with a literal `false` — the exact defect being fixed, Chrome up but
  //    reported down — still passed. The gate must be the live variable.
  const before = BRANCH.slice(0, i);
  const lastTernary = before.lastIndexOf('?');
  assert.ok(lastTernary > 0, 'expected the hint to be built from a conditional');
  const cond = before.slice(before.lastIndexOf(':', lastTernary) + 1, lastTernary);
  assert.ok(/\bchromeUp\b/.test(cond),
    `the branch guarding "Chrome IS running" must test chromeUp itself, got: ${cond.trim()}`);
  assert.ok(!/\b(true|false)\b/.test(cond),
    `a literal in that condition pins the branch and hides the real state: ${cond.trim()}`);
});

check('when Chrome IS up it says so, with the tab count, and warns against launching another', () => {
  assert.ok(/Chrome IS running/.test(BRANCH), 'it must state plainly that Chrome is up');
  assert.ok(/do not start another/i.test(BRANCH),
    'the reader is about to run launch.js; stop them explicitly');
  assert.ok(/\$\{chromePages\}|chromePages/.test(BRANCH),
    'give the tab count — it is what makes "already running" believable');
});

check('it names a path that does not depend on playwright matching Chrome', () => {
  assert.ok(/WBROWSER_FORCE_RAWCDP/.test(BRANCH),
    'a version mismatch cannot be fixed by restarting; the raw-CDP pin is the working path, '
    + 'and a diagnosis with no way out gets ignored');
});

check('chrome and browser are reported as SEPARATE facts', () => {
  assert.ok(/chrome:\s*chromeUp/.test(BRANCH),
    '`browser` means "we could attach"; `chrome` means "Chrome exists". Collapsing them into '
    + 'one field is what made the engine unable to say "it is there but I cannot reach it"');
  assert.ok(/browser:\s*false/.test(BRANCH), 'browser:false is still correct — we did not attach');
});

check('rawcdp exports getJSON, so the above is not aspirational', () => {
  const RAW = fs.readFileSync(path.join(__dirname, '..', 'rawcdp.js'), 'utf8');
  assert.ok(/module\.exports\s*=\s*\{[^}]*\bgetJSON\b/.test(RAW),
    'engine.js requires rawcdp.getJSON; if it is not exported, /health throws in the very '
    + 'branch meant to diagnose a failure');
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passing');
