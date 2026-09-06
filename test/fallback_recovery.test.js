// Unit test for the "fallback is not a one-way door" fix (idifference 2026-09-06), run with
// NO browser and NO engine process. We extract the real tryRecoverFromFallback source text from
// engine.js and run it against fake dependencies in a vm sandbox — so the test exercises the
// actual shipped code (not a re-implementation), while staying hermetic.
//
// Why a vm and not require(engine.js): engine.js starts an HTTP server at top level and has no
// exports. Rather than restructure it, we lift just this function's source and its two helpers'
// contracts into a sandbox. The source string is the ground truth; if the function is edited in
// a way that breaks the recovery contract, this test fails.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');

// Pull one async function definition (balanced braces) out of the source by name.
function extractFn(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in engine.js`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const fnSrc = extractFn(SRC, 'tryRecoverFromFallback');

// Build a sandbox that provides the module-level state and helper contracts the function uses,
// then evaluate the real function text inside it and return handles to drive it.
function makeSandbox(overrides) {
  const state = {
    reconnectFailed: true,     // we start trapped in the fallback — that is the bug's state
    reconnecting: false,
    browser: null,
    ctx: null,
    tabs: new Map(),
    logs: [],
  };
  const sandbox = {
    // module-level lets the function closes over
    get reconnectFailed() { return state.reconnectFailed; },
    set reconnectFailed(v) { state.reconnectFailed = v; },
    get reconnecting() { return state.reconnecting; },
    set reconnecting(v) { state.reconnecting = v; },
    get browser() { return state.browser; },
    set browser(v) { state.browser = v; },
    get ctx() { return state.ctx; },
    set ctx(v) { state.ctx = v; },
    tabs: state.tabs,
    // helper contracts
    rawCdpAlive: overrides.rawCdpAlive,
    connectOverCDPBounded: overrides.connectOverCDPBounded,
    console: { error: (m) => state.logs.push(String(m)) },
    Date,
    Promise,
    setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(`var tryRecoverFromFallback = ${fnSrc}; globalThis.__fn = tryRecoverFromFallback;`, sandbox);
  return { sandbox, state, run: () => sandbox.__fn() };
}

// A fake playwright browser handle that reports itself connected and exposes one context.
function fakeBrowser() {
  return {
    _connected: true,
    isConnected() { return this._connected; },
    contexts() { return [{ __ctx: true }]; },
    on() { /* disconnected listener — not exercised here */ },
    close() { this._connected = false; return Promise.resolve(); },
  };
}

test('playwright recovered → clears reconnectFailed and rejoins the normal path', async () => {
  const b = fakeBrowser();
  const { state, run } = makeSandbox({
    rawCdpAlive: async () => true,                 // Chrome answers raw CDP
    connectOverCDPBounded: async () => b,          // and a fresh connect now SUCCEEDS
  });
  const recovered = await run();
  assert.strictEqual(recovered, true, 'should report recovery');
  assert.strictEqual(state.reconnectFailed, false, 'flag must be cleared so act() leaves the fallback');
  assert.ok(state.ctx, 'context wired from the fresh browser');
});

test('playwright still dead → stays in fallback, flag not cleared', async () => {
  const { state, run } = makeSandbox({
    rawCdpAlive: async () => true,                 // Chrome answers raw CDP...
    connectOverCDPBounded: async () => { throw new Error('Timeout 6000ms exceeded'); }, // ...but connect still times out
  });
  const recovered = await run();
  assert.strictEqual(recovered, false, 'no recovery when connect still fails');
  assert.strictEqual(state.reconnectFailed, true, 'must remain in the fallback');
});

test('Chrome itself gone (raw CDP down) → does not even attempt a connect', async () => {
  let attempted = false;
  const { state, run } = makeSandbox({
    rawCdpAlive: async () => false,                // Chrome not answering at all
    connectOverCDPBounded: async () => { attempted = true; return fakeBrowser(); },
  });
  const recovered = await run();
  assert.strictEqual(recovered, false);
  assert.strictEqual(attempted, false, 'must skip the connect attempt when raw CDP is down');
  assert.strictEqual(state.reconnectFailed, true);
});

test('a reconnect already in progress → yields, does not double-connect', async () => {
  let attempted = false;
  const { sandbox, state, run } = makeSandbox({
    rawCdpAlive: async () => true,
    connectOverCDPBounded: async () => { attempted = true; return fakeBrowser(); },
  });
  sandbox.reconnecting = true;                     // another caller holds the reconnect
  const recovered = await run();
  assert.strictEqual(recovered, false);
  assert.strictEqual(attempted, false, 'must not start a second concurrent connect');
  assert.strictEqual(state.reconnectFailed, true);
});

test('not in fallback (flag already clear) → no-op', async () => {
  let attempted = false;
  const { sandbox, state, run } = makeSandbox({
    rawCdpAlive: async () => true,
    connectOverCDPBounded: async () => { attempted = true; return fakeBrowser(); },
  });
  sandbox.reconnectFailed = false;                 // healthy path
  const recovered = await run();
  assert.strictEqual(recovered, false);
  assert.strictEqual(attempted, false, 'the healthy path pays nothing');
});
