// On the raw-CDP fallback, a tab the agent opened must still carry the agent's title tag.
//
// 🔴 Measured 2026-10-03 (influencer-whitegun): the engine was pinned to raw CDP, /act opened
//    tabs for that agent, and `wb close --agent influencer-whitegun` then answered "no open tabs"
//    and closed 0 — while those tabs were open on screen. `wb close` matches on the title tag,
//    and the fallback's createTab never applied one. The agent could not clean up after itself,
//    and could not tell its own tabs from a human's, so it left five tabs behind rather than risk
//    closing someone else's.
//
// 🔵 Same shape as L-20261003-01 (dead-tab cleanup lived only in rawcdp.js): behaviour that
//    differs by code path, where the untested path is the broken one. The fix is one shared
//    source, which is what these tests pin.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); } catch (e) {
    failures += 1; console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

console.log('the fallback stamps the tabs it opens:');

const ENGINE = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');

check('the stamp script is ONE module-level source, not a per-lane copy', () => {
  assert.ok(/^const TITLE_INSTALL = /m.test(ENGINE),
    'the stamp must be reachable outside stampTitle(), which needs a playwright page object');
  const copies = (ENGINE.match(/__wbrowserTitleGuard/g) || []).length;
  assert.ok(copies <= 2,
    `the guard key appears ${copies} times — a second copy of the stamp script will drift from `
    + 'the first, and the two lanes will tag tabs differently');
});

check('stampTitle uses that same source rather than its own', () => {
  const m = ENGINE.match(/async function stampTitle\([\s\S]{0,400}/);
  assert.ok(m, 'stampTitle not found');
  assert.ok(/TITLE_INSTALL/.test(m[0]),
    'the playwright lane must reference the shared script, or fixing one lane leaves the other');
});

check('the fallback stamps the tab it opened', () => {
  const i = ENGINE.indexOf('if (openedTab && cmd.agent)');
  assert.ok(i > 0, 'the stamp block is gone — a tab opened with no tag cannot be found later');
  const block = ENGINE.slice(i, i + 1800);
  assert.ok(/TITLE_INSTALL/.test(block), 'it must inject the shared stamp script');
  assert.ok(/raw\.evaluate\(/.test(block), 'over raw CDP — there is no playwright page here');
  assert.ok(/cmd\.agent/.test(block), 'stamp with the requesting agent, not a guess');
});

check('the stamp happens AFTER the page settles, not right after createTab', () => {
  // 🔴 Measured 2026-10-03: stamping immediately after createTab reported `stamped` while the
  //    title stayed bare. The tab is about:blank or mid-navigation then, and the navigation
  //    replaces the document — taking the title with it. Order is the whole fix.
  const iCreate = ENGINE.indexOf('await raw.createTab(');
  const iSettle = ENGINE.indexOf('let last = -1; let stable = 0;');
  const iStamp = ENGINE.indexOf('if (openedTab && cmd.agent)');
  assert.ok(iCreate > 0 && iSettle > 0 && iStamp > 0, 'all three landmarks must exist');
  assert.ok(iSettle > iCreate, 'sanity: the settle loop follows createTab');
  assert.ok(iStamp > iSettle,
    `the stamp must come after the settle loop (settle at ${iSettle}, stamp at ${iStamp}); `
    + 'stamping before the document is final throws the tag away');
});

check('it VERIFIES the tag took, instead of reporting it blind', () => {
  // 🔴 The first version pushed 'stamped' unconditionally and was wrong on the very first run —
  //    the same silent-failure shape this change exists to fix. Reporting work that did not land
  //    is worse than not doing it, because nobody goes looking.
  const i = ENGINE.indexOf('if (openedTab && cmd.agent)');
  const block = ENGINE.slice(i, i + 1800);
  assert.ok(/document\.title/.test(block), 'read the title back — that is the only proof');
  const iRead = block.indexOf('document.title');
  const iPush = block.indexOf("done.push('stamped')");
  assert.ok(iPush > 0, "it should still report success when the tag is really there");
  assert.ok(iRead < iPush, 'the read-back must come BEFORE claiming success');
  assert.ok(/includes\(cmd\.agent\)/.test(block),
    'check the agent name is actually in the title, not merely that a title exists');
  assert.ok(/stampWarning/.test(block),
    'when it did not take, say so — and say what it costs (wb close will not find this tab)');
});

check('it uses cmd.tab, not the `tab` local from act()', () => {
  // 🔴 `tab` is declared inside act(), far below this call site. Referencing it here throws,
  //    the throw is swallowed by the try, and the stamp is skipped — reintroducing the bug
  //    while a test that only checks "TITLE_INSTALL appears" stays green.
  const i = ENGINE.indexOf('if (openedTab && cmd.agent)');
  const block = ENGINE.slice(i, i + 1800);
  const m = block.match(/tab:\s*([A-Za-z_$][\w$.]*)/);
  assert.ok(m, 'the stamp argument must name a tab');
  assert.strictEqual(m[1], 'cmd.tab',
    `stamp uses \`${m[1]}\`; only cmd.tab is in scope at the fallback call site`);
});

check('a failed stamp never fails the command', () => {
  const i = ENGINE.indexOf('if (openedTab && cmd.agent)');
  const block = ENGINE.slice(i, i + 1800);
  const iTry = block.indexOf('try');
  const iStamp = block.indexOf('TITLE_INSTALL');
  const iCatch = block.indexOf('catch');
  assert.ok(iTry >= 0 && iCatch > iStamp && iTry < iStamp,
    'the injection must sit INSIDE a try — a cosmetic tag must not take down a working navigation');
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passing');
