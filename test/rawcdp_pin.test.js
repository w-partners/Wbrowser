// WBROWSER_FORCE_RAWCDP=1 must be a pin, not a hint.
//
// 🔴 Measured 2026-10-01: the variable was set in the engine's environment, yet a `collect`
//    ran `via: "pw"` and timed out at 318s. `reconnectFailed` was assigned `false` in three
//    places, and one of them — a successful `connect()` during startup — revoked the pin.
//    A pin that the thing being pinned against can clear is not a pin.
//
// Structural test: no Chrome, no engine. It reads engine.js and checks that the flag is
// only ever cleared through the one helper that honours the pin.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
const LINES = SRC.split('\n');
const isCode = (l) => {
  const t = l.trim();
  return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
};

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); } catch (e) {
    failures += 1; console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

console.log('raw-CDP pin:');

check('the pin seeds the degraded flag', () => {
  assert.ok(/let reconnectFailed = RAWCDP_PINNED;/.test(SRC),
    'reconnectFailed must start from the pin so a pinned engine never tries playwright first');
});

check('reconnectFailed is cleared in exactly one place', () => {
  const sites = LINES.filter((l) => isCode(l) && /\breconnectFailed\s*=\s*false/.test(l));
  assert.strictEqual(sites.length, 1,
    `found ${sites.length} assignments; every clear must go through clearDegraded() or a `
    + 'future edit will silently revoke the pin again');
});

check('that one place honours the pin', () => {
  const helper = LINES.find((l) => /function clearDegraded/.test(l));
  assert.ok(helper, 'clearDegraded() not found');
  assert.ok(/RAWCDP_PINNED/.test(helper),
    'clearDegraded() must check RAWCDP_PINNED before clearing');
});

check('recovery does not run while pinned', () => {
  const i = LINES.findIndex((l) => /async function tryRecoverFromFallback/.test(l));
  assert.ok(i >= 0, 'tryRecoverFromFallback not found');
  const head = LINES.slice(i, i + 12).join('\n');
  assert.ok(/WBROWSER_FORCE_RAWCDP|RAWCDP_PINNED/.test(head),
    'a pinned engine must not spend the connect timeout trying to climb out on every request');
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passing');
