// Ownership of a tab must not live only in its title.
//
// 🔴 The title belongs to the PAGE. An SPA rewrites it whenever it likes — X does, for the unread
//    count — and our MutationObserver puts the tag back. But anything that replaces the document
//    takes the observer with it, and from then on the tab is unidentifiable. Measured 2026-10-03
//    (influencer-whitegun): a tab read "[1-?] influencer-whitegun (1) WhiteGun on X…" right after
//    opening and plain "(1) WhiteGun on X…" minutes later; `wb close --agent <name>` then answered
//    "no open tabs" and five tabs were left open because none could be told from a person's.
//
// 🔵 A 3-minute watch showed no natural decay (tag and observer both alive at every 20s sample),
//    so this is event-driven, not time-driven. The fix therefore does not depend on identifying
//    the event: whenever the title tag is missing, ask the page.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); } catch (e) {
    failures += 1; console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

console.log('a tab can be identified after the page rewrites its title:');

const RAW = fs.readFileSync(path.join(__dirname, '..', 'rawcdp.js'), 'utf8');
const WB = fs.readFileSync(path.join(__dirname, '..', 'wb'), 'utf8');
const ENGINE = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');

check('the stamp writes a durable marker, not only the title', () => {
  assert.ok(/window\.__wbrowserAgent = tag/.test(ENGINE),
    'the stamp must record the agent on the window; the title alone is the page\'s to overwrite');
});

check('rawcdp exposes a way to confirm ownership by asking the page', () => {
  assert.ok(/async function verifyOwner\(/.test(RAW), 'verifyOwner must exist');
  assert.ok(/module\.exports[^;]*\bverifyOwner\b/.test(RAW), 'and be exported, or it is dead code');
  const m = RAW.match(/async function verifyOwner\([\s\S]*?\n\}/);
  assert.ok(m, 'could not read verifyOwner');
  const fn = m[0];
  assert.ok(/__wbrowserAgent/.test(fn), 'it must read the durable marker');
  assert.ok(/who === agent/.test(fn),
    'claim only an exact match — a prefix or substring match would adopt another agent\'s tab');
  assert.ok(/timeoutMs/.test(fn), 'bound each probe; a dead renderer must not stall the sweep');
});

check('verifyOwner claims nothing it could not confirm', () => {
  const fn = RAW.match(/async function verifyOwner\([\s\S]*?\n\}/)[0];
  // The catch must NOT push the target — silence is not consent.
  const cat = fn.slice(fn.indexOf('catch'));
  assert.ok(!/out\.push/.test(cat),
    'a target that did not answer must be left out: closing a tab we could not identify is the '
    + 'accident this whole change exists to prevent');
});

check('wb close falls back to asking the pages when no title matches', () => {
  const i = WB.indexOf('close)');
  assert.ok(i > 0, 'the close subcommand is gone — update this test');
  const block = WB.slice(i, i + 6000);
  assert.ok(/__wbrowserAgent/.test(block),
    'wb close matches on the title tag; without a second route it finds nothing once the page '
    + 'has rewritten the title');
  assert.ok(/if not mine and me:/.test(block),
    'the fallback must run only when the title match found nothing, so the cheap path stays cheap');
  assert.ok(/== me/.test(block), 'exact agent match, not a substring');
});

check('wb close says it used the fallback, rather than silently differing', () => {
  const block = WB.slice(WB.indexOf('close)'), WB.indexOf('close)') + 6000);
  assert.ok(/title tags were gone/.test(block),
    'the two routes find tabs for different reasons; a reader who is debugging needs to know '
    + 'which one answered');
});

check('the title is still tried first', () => {
  const block = WB.slice(WB.indexOf('close)'), WB.indexOf('close)') + 6000);
  const iTitle = block.indexOf('_pat.match');
  const iAsk = block.indexOf('__wbrowserAgent');
  assert.ok(iTitle > 0 && iAsk > iTitle,
    'the title scan costs one HTTP call for every tab at once; probing each page costs a '
    + 'websocket each, so it stays the fallback');
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passing');
