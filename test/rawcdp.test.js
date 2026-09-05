// Which tabs the raw-CDP fallback is allowed to attach to.
//
// 🔴 This decides identity isolation on the emergency lane, and it has been wrong in BOTH
//    directions. It runs without a browser or network — `node --test` is built in.
//
// The bug this guards against (reported 2026-09-05, idifference): under load the engine drops
// to the raw-CDP fallback; the fallback's candidate list had been widened to ALL pages, so when
// this agent's own tab was slow the loop attached to a DIFFERENT agent's logged-in tab and ran
// eval/shot/click there — a boundary leak. chooseCandidates must never hand back a tab this
// agent did not stamp.

const { test } = require('node:test');
const assert = require('node:assert');

const { chooseCandidates, RawCDP } = require('../rawcdp.js');

const pages = [
  { title: '[1-34] idifference-primary  my site', webSocketDebuggerUrl: 'ws://mine' },
  { title: '(7) Threads — @someone_else', webSocketDebuggerUrl: 'ws://theirs1' },
  { title: 'Instagram', webSocketDebuggerUrl: 'ws://theirs2' },
];

test('with a name, only this agent’s stamped tabs are candidates', () => {
  const got = chooseCandidates(pages, 'idifference-primary');
  assert.equal(got.length, 1);
  assert.equal(got[0].webSocketDebuggerUrl, 'ws://mine');
});

test('a stranger’s tab is never a candidate when a name is given', () => {
  // The heart of the leak: even if it is the only *live* tab, we must not offer it.
  const got = chooseCandidates(pages, 'idifference-primary');
  assert.ok(!got.some((t) => /theirs/.test(t.webSocketDebuggerUrl)),
    'chooseCandidates returned another agent’s tab');
});

test('no tab for this agent → throws, does NOT fall back to others', () => {
  // Only strangers' tabs are open. Attaching to one would run our command in their session,
  // so the contract is to refuse loudly, not to borrow the nearest live tab.
  const strangersOnly = pages.filter((t) => !/idifference/.test(t.title));
  assert.throws(() => chooseCandidates(strangersOnly, 'idifference-primary'),
    /no tab stamped for 'idifference-primary'.*Refusing to attach to another agent's tab/s);
});

test('the refusal does NOT tell you to open a tab with go (that loops on the fallback)', () => {
  // 🔴 Reported 2026-09-05 (whitegun): the message used to say "open this agent's tab first
  //    with a go", but on the fallback lane `go` routes back through this very check and is
  //    refused identically — the guidance looped and cost real time. The only real fix here
  //    is a restart, so the message must say that and must NOT suggest `go`.
  const strangersOnly = pages.filter((t) => !/idifference/.test(t.title));
  try {
    chooseCandidates(strangersOnly, 'idifference-primary');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(!/\bgo\b/.test(e.message) || !/carries --agent|open this agent's tab first/.test(e.message),
      'the refusal still suggests opening a tab with go — that loops on the fallback');
    assert.match(e.message, /restart the engine|wb down; wb up/i,
      'the refusal must point at the one fix that works here: a restart');
  }
});

test('without a name, every page is a candidate (no identity to protect)', () => {
  const got = chooseCandidates(pages, null);
  assert.equal(got.length, pages.length);
});

test('two tabs stamped for the same agent both stay candidates', () => {
  const many = [
    { title: '[1-1] a-agent main', webSocketDebuggerUrl: 'ws://a1' },
    { title: '[1-2] a-agent side', webSocketDebuggerUrl: 'ws://a2' },
    { title: 'someone else', webSocketDebuggerUrl: 'ws://b' },
  ];
  const got = chooseCandidates(many, 'a-agent');
  assert.deepEqual(got.map((t) => t.webSocketDebuggerUrl), ['ws://a1', 'ws://a2']);
});

// ---------------------------------------------------------------- attach closes a hung own-tab
//
// 🔴 Reported 2026-09-05 (idifference): under the fallback, an agent's long-reused tab had a
//    hung renderer — Page/Runtime timed out while /json/* stayed instant — and neither an
//    engine nor a Chrome restart helped, because the engine kept holding that same dead tab.
//    attach() must drop the agent's OWN hung tab (over HTTP, which the browser process serves)
//    and tell the caller to retry — while never closing another agent's tab.

const http = require('node:http');

function stubChrome(targets) {
  // A tiny stand-in for Chrome's HTTP CDP endpoints. WebSocket "connections" are never made
  // live here: attach() will try to open ws:// to an unroutable address and fail its probe,
  // which is exactly the "renderer not answering" path we want. We only assert which targets
  // got /json/close.
  const closed = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }
    const m = req.url.match(/^\/json\/close\/(.+)$/);
    if (m) { closed.push(m[1]); res.writeHead(200); res.end('Target is closing'); return; }
    res.writeHead(404); res.end();
  });
  return { server, closed };
}

test('attach closes THIS agent’s hung tab and refuses to close a stranger’s', async () => {
  // ws:// points at a closed port so the liveness probe always fails — i.e. "hung renderer".
  const deadWs = 'ws://127.0.0.1:1/devtools/page/';
  const targets = [
    { id: 'MINE', type: 'page', title: '[1-1] my-agent main', webSocketDebuggerUrl: deadWs + 'MINE' },
    { id: 'THEIRS', type: 'page', title: '(7) other-agent Threads', webSocketDebuggerUrl: deadWs + 'THEIRS' },
  ];
  const { server, closed } = stubChrome(targets);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const raw = new RawCDP(base);
    await assert.rejects(
      () => raw.attach('my-agent'),
      /renderer had stopped responding.*Run the command again/s,
      'should report the hung tab was closed and tell the caller to retry');
    raw.close();
    // Only my hung tab was closed; the stranger's was never a candidate, never closed.
    assert.deepEqual(closed, ['MINE'], `closed the wrong target(s): ${closed}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
