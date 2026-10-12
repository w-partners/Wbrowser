// The agent-tab cap must hold on a slow machine, on both lanes.
//
// 🔴 Reported 2026-10-12 (zalman): 107 agent tabs were open against a cap of 8, until playwright's
//    attach and then raw CDP both stopped answering. Two holes: the playwright-lane reaper only
//    counted tabs that answered "do you carry our mark?" within 600ms — at load 26-47 none did, so
//    it counted none and closed none — and the raw-CDP lane, which opens tabs too, had no cap.
// 🔵 The fix counts from the engine's own record of what it opened. These tests pin that.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { capOpened } = require('../rawcdp');

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); } catch (e) {
    failures += 1; console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

// A stand-in for Chrome's /json endpoints: a list of targets, and /json/close/<id> removes one.
function fakeChrome(ids) {
  const live = new Set(ids);
  const closed = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      return res.end(JSON.stringify([...live].map((id) => ({ id, type: 'page' }))));
    }
    const m = req.url.match(/^\/json\/close\/(.+)$/);
    if (m) { live.delete(m[1]); closed.push(m[1]); return res.end('Target is closing'); }
    res.statusCode = 404; res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, live, closed, server });
    });
  });
}

(async () => {
  console.log('the agent-tab cap:');

  await check('raw lane: at the cap, the OLDEST tab we opened is closed to make room', async () => {
    const c = await fakeChrome(['a1', 'a2', 'a3', 'human']);
    const opened = ['a1', 'a2', 'a3'];
    const shut = await capOpened(c.base, opened, 3);
    c.server.close();
    assert.deepStrictEqual(shut, ['a1'], `closed ${JSON.stringify(shut)}`);
    assert.deepStrictEqual(opened, ['a2', 'a3']);
    assert.ok(c.live.has('human'), 'a tab we did not open must never be touched');
  });

  await check('raw lane: a 107-tab pile is brought back under the cap in one go', async () => {
    const ids = Array.from({ length: 107 }, (_, i) => `t${i}`);
    const c = await fakeChrome(ids);
    const opened = ids.slice();
    await capOpened(c.base, opened, 8);
    c.server.close();
    assert.strictEqual(opened.length, 7, 'room for exactly one more');
    assert.strictEqual(c.live.size, 7);
    assert.deepStrictEqual(opened, ids.slice(100), 'the newest seven survive');
  });

  await check('raw lane: tabs already gone do not use up the cap', async () => {
    const c = await fakeChrome(['b2']);          // b1 was closed by hand
    const opened = ['b1', 'b2'];
    const shut = await capOpened(c.base, opened, 2);
    c.server.close();
    assert.deepStrictEqual(shut, [], 'nothing live needed closing');
    assert.deepStrictEqual(opened, ['b2']);
  });

  const ENGINE = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');

  await check('raw lane: createTab is capped first and recorded after', () => {
    const iCap = ENGINE.indexOf('await capRawOpened();');
    const iCreate = ENGINE.indexOf('rawOpened.push(await raw.createTab(');
    assert.ok(iCap > 0, 'the raw lane must cap before opening — it had no cap at all');
    assert.ok(iCreate > iCap, 'and record the tab it opened, or the cap never sees it');
  });

  await check('playwright lane: a tab we opened counts even when it does not answer', () => {
    const m = ENGINE.match(/async function reapAgentTabs[\s\S]*?\n}\n/);
    assert.ok(m, 'reapAgentTabs not found');
    assert.ok(/openedPages\.has\(/.test(m[0]),
      'the reaper must consult the engine\'s own record, not only the page\'s answer');
    assert.ok(!/if \(!info \|\| !info\.mark\) continue;/.test(m[0]),
      'skipping every page that did not answer is how a busy machine ended up with 107 tabs');
  });

  await check('playwright lane: every page the engine opens for an agent is recorded', () => {
    const bare = ENGINE.match(/= await (targetCtx|c)\.newPage\(\)/g) || [];
    assert.deepStrictEqual(bare, [], `unrecorded newPage: ${bare.join(', ')}`);
    assert.ok((ENGINE.match(/recordOpened\(await (targetCtx|c)\.newPage\(\)\)/g) || []).length >= 2);
  });

  if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
})();
