// Scoped access (v0.18.x): a task may declare which origins it may auto-fill on. Outside that
// list, a stored credential is NOT spent — shrinking exposure to the task's own sites. Pure
// function, so we run the REAL originInScope from engine.js in a vm with no browser.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
const start = SRC.indexOf('function originInScope(');
let i = SRC.indexOf('{', start); let d = 0; let end = i;
for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}') { d--; if (!d) { end = i + 1; break; } } }
const fnSrc = SRC.slice(start, end);
const sandbox = { URL };
vm.createContext(sandbox);
vm.runInContext(`${fnSrc}; globalThis.f = originInScope;`, sandbox);
const inScope = sandbox.f;

test('no scope → unrestricted (prior behaviour preserved)', () => {
  assert.strictEqual(inScope('https://github.com', undefined), true);
  assert.strictEqual(inScope('https://github.com', null), true);
  assert.strictEqual(inScope('https://github.com', []), true);
});

test('exact origin in scope → allowed', () => {
  assert.strictEqual(inScope('https://github.com', ['https://github.com']), true);
});

test('origin NOT in scope → refused (the whole point)', () => {
  assert.strictEqual(inScope('https://evil.com', ['https://github.com']), false);
});

test('subdomain of an allowed host → allowed', () => {
  assert.strictEqual(inScope('https://app.example.com', ['https://example.com']), true);
});

test('lookalike host must NOT match by substring', () => {
  // the exact trap: substring matching would wrongly allow this
  assert.strictEqual(inScope('https://evil-github.com', ['https://github.com']), false);
  assert.strictEqual(inScope('https://github.com.evil.com', ['https://github.com']), false);
});

test('malformed scope entry matches nothing', () => {
  assert.strictEqual(inScope('https://github.com', ['not a url']), false);
});
