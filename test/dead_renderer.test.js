// A dead TAB is not a dead socket, and not a sick Chrome.
//
// 🔴 Measured 2026-10-03: x.com had been open for hours. Its websocket connected in 27ms but
//    `Runtime.evaluate 1` never returned, while /json/version and every other tab answered in
//    single-digit ms. The engine saw "read timed out + raw CDP is fast" and concluded the browser
//    socket was half-dead — so it reconnected (no effect), then told the caller to restart the
//    engine, then to restart Chrome. None of those remove a dead tab. Three agents spent hours on
//    it and one filed a request to switch the engine to raw CDP, which would not have helped
//    either. The fix was closing that one tab; afterwards x.com opened instantly.
//
// Structural, because producing a genuinely hung renderer on demand is not something a unit test
// can do. What is pinned here is the ORDER of questions — which is what was wrong.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); } catch (e) {
    failures += 1; console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

console.log('a dead tab is diagnosed as a dead tab:');

const ENGINE = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');

check('there is a probe that asks about THIS PAGE, not about Chrome', () => {
  assert.ok(/async function pageRendererAlive\(/.test(ENGINE),
    'rawCdpAlive() answers "is Chrome up"; a separate probe must answer "is this renderer up"');
  const m = ENGINE.match(/async function pageRendererAlive\([\s\S]*?\n\}/);
  assert.ok(m, 'could not read pageRendererAlive');
  const fn = m[0];
  assert.ok(/Runtime\.evaluate/.test(fn),
    'the only proof a renderer is alive is a round trip that returns');
  assert.ok(/json\/list/.test(fn), 'it must find the target for THIS page url');
  assert.ok(/timeoutMs\s*=\s*\d{3,4}/.test(fn),
    'bound the probe — a dead renderer must cost a couple of seconds, not the command budget');
  assert.ok(/return null/.test(fn),
    'unmeasurable must be distinguishable from dead: null, not false');
});

check('the dead-tab BRANCH runs before the socket is revived', () => {
  // 🔴 What matters is not where `tabAlive` is declared but where the branch that ACTS on it
  //    sits relative to reviveIfHalfDead. A first version of this test compared declaration
  //    offsets and stayed green when the probe was moved down next to the revive — the exact
  //    regression it was written to catch. Measure the thing that changes behaviour.
  const branch = ENGINE.slice(ENGINE.indexOf('if (summary === TIMED_OUT)'));
  const iAct = branch.indexOf('if (cdpFast && tabAlive === false)');
  const iRevive = branch.indexOf('reviveIfHalfDead');
  assert.ok(iAct > 0, 'the dead-tab branch must exist in the read-timeout path');
  assert.ok(iRevive > 0, 'the revive must exist');
  assert.ok(iAct < iRevive,
    `the dead-tab branch must come first (branch at ${iAct}, revive at ${iRevive}). Reviving a `
    + 'healthy socket first makes the revive "succeed" and the reply then reports a fixed '
    + 'socket while the dead tab is still there');
});

check('a dead renderer closes the tab', () => {
  const m = ENGINE.match(/if \(cdpFast && tabAlive === false\)[\s\S]{0,1800}?\n      \}/);
  assert.ok(m, 'could not find the dead-renderer branch');
  const br = m[0];
  assert.ok(/page\.close\(/.test(br), 'closing the tab is the entire fix');
  assert.ok(/tabs\.delete\(/.test(br),
    'drop it from the agent tab map too, or the next command reuses the corpse');
  assert.ok(/tabAlive === false/.test(br),
    'match on false specifically — null means unmeasured, and closing a tab we could not '
    + 'measure would destroy a page that might be fine');
});

check('it tells the reader NOT to restart, since restarting cannot help', () => {
  const m = ENGINE.match(/if \(cdpFast && tabAlive === false\)[\s\S]{0,1800}?\n      \}/);
  const br = m ? m[0] : '';
  assert.ok(/Do NOT restart/i.test(br),
    'the reader has been trained by the other branches to restart; say plainly that it is '
    + 'the wrong move here, or they will do it anyway');
  assert.ok(/Run the command again/i.test(br),
    'give the action that works — a diagnosis with no way out gets ignored');
});

check('the socket/restart advice is suppressed when the tab was the problem', () => {
  assert.ok(/if \(!rendererWasDead\) result\.readError = revived/.test(ENGINE),
    'the half-dead-socket wording must not overwrite the dead-tab wording; otherwise the '
    + 'correct diagnosis is computed and then discarded');
  const iFlag = ENGINE.indexOf('let rendererWasDead');
  const iUse = ENGINE.indexOf('if (!rendererWasDead) result.readError');
  assert.ok(iFlag > 0 && iFlag < iUse, 'the flag must be declared before it is read');
});

check('it does NOT return early — the rest of the reply is still assembled', () => {
  const m = ENGINE.match(/if \(cdpFast && tabAlive === false\)[\s\S]{0,1800}?\n      \}/);
  const br = m ? m[0] : '';
  assert.ok(!/\breturn result;/.test(br),
    'console/errors/network collection happens after this point; returning here would silently '
    + 'drop whatever else the caller asked for in the same request');
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passing');
