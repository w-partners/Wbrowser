// safeUrl — what a tab's URL looks like after the query string is removed.
//
// 🔴 The query string goes because a tab URL can carry a session token, and this list is read
//    aloud and written to an audit log. But the stripping must not make the URL unreadable:
//    measured 2026-10-02, a local file tab came back as "null/C:/Users/User/.wbrowser/home.html"
//    because URL.origin is the literal string "null" for file:, data: and blob:. A reader cannot
//    tell that from a broken list.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); } catch (e) {
    failures += 1; console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

// Lift the real function out of starian.js rather than re-implementing it.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'starian.js'), 'utf8');
const m = SRC.match(/function safeUrl\(u\)\s*\{[\s\S]*?\n\}/);
if (!m) { console.log('  ❌ could not find safeUrl in starian.js'); process.exit(1); }
const ctx = { URL, String };
vm.createContext(ctx);
vm.runInContext(`${m[0]}; globalThis.f = safeUrl;`, ctx);
const safeUrl = ctx.f;

console.log('safeUrl:');

check('keeps origin and path', () => {
  assert.strictEqual(safeUrl('https://x.com/user/status/123'), 'https://x.com/user/status/123');
});

check('replaces a query string with a marker — never the value', () => {
  const out = safeUrl('https://site.com/p?token=SECRET123&a=b');
  assert.ok(!out.includes('SECRET123'), 'a token must never survive: this string is logged');
  assert.ok(!out.includes('a=b'), 'drop the whole query, not just the parts that look secret');
  assert.ok(out.endsWith('?…'), 'say that something was removed, so the reader knows');
});

check('a file: URL stays readable', () => {
  const out = safeUrl('file:///C:/Users/User/.wbrowser/home.html');
  assert.ok(!out.startsWith('null'),
    `URL.origin is "null" for file:; the result must not start with it, got: ${out}`);
  assert.ok(out.includes('home.html'), `the path must survive, got: ${out}`);
  assert.ok(out.startsWith('file://'), `say which scheme it is, got: ${out}`);
});

check('data: and blob: are readable too', () => {
  for (const u of ['data:text/html,hello', 'blob:https://x.com/abc-123']) {
    const out = safeUrl(u);
    assert.ok(!out.startsWith('null'), `${u} → ${out}`);
  }
});

check('null/empty give null, not the string "null"', () => {
  assert.strictEqual(safeUrl(null), null);
  assert.strictEqual(safeUrl(''), null);
});

check('garbage is truncated rather than thrown', () => {
  const out = safeUrl('not a url at all '.repeat(20));
  assert.ok(typeof out === 'string' && out.length <= 80,
    'an unparseable value must not take the whole tab list down with it');
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passing');
