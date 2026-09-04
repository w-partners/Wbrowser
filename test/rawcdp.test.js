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

const { chooseCandidates } = require('../rawcdp.js');

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
