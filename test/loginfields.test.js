// Picking where a secret gets typed. The refusals here are security properties — a wrong-field
// secret is the worst outcome — so they are tested directly. No browser, no network.

const { test } = require('node:test');
const assert = require('node:assert');

const { choose } = require('../loginfields.js');

const F = (o) => ({ visible: true, tag: 'input', ...o });

test('a normal login form → username, password, submit', () => {
  const r = choose([
    F({ ref: 'u', type: 'text', name: 'username' }),
    F({ ref: 'p', type: 'password', name: 'password' }),
    F({ ref: 's', tag: 'button', type: 'submit', text: 'Sign in' }),
  ]);
  assert.deepEqual(r, { username: 'u', password: 'p', submit: 's' });
});

test('no password field → refuses (does not guess)', () => {
  assert.throws(() => choose([
    F({ ref: 'u', type: 'text', name: 'username' }),
    F({ ref: 'q', type: 'text', name: 'search' }),
  ]), /no visible password field.*refusing to type a secret/i);
});

test('two visible password fields → refuses (change/confirm form, not login)', () => {
  assert.throws(() => choose([
    F({ ref: 'p1', type: 'password', name: 'new-password' }),
    F({ ref: 'p2', type: 'password', name: 'confirm-password' }),
  ]), /change\/confirm-password form.*[Rr]efusing/s);
});

test('a hidden password field is not chosen', () => {
  // A hidden password (e.g. a honeypot or an off-screen widget) must not be picked.
  assert.throws(() => choose([
    F({ ref: 'u', type: 'text', name: 'user' }),
    F({ ref: 'p', type: 'password', name: 'password', visible: false }),
  ]), /no visible password field/i);
});

test('username picked by autocomplete over a generic first field', () => {
  const r = choose([
    F({ ref: 'first', type: 'text', name: 'q' }),
    F({ ref: 'user', type: 'email', autocomplete: 'username' }),
    F({ ref: 'p', type: 'password' }),
  ]);
  assert.equal(r.username, 'user');
});

test('username picked by name/id hint when no autocomplete', () => {
  const r = choose([
    F({ ref: 'x', type: 'text', name: 'captcha' }),
    F({ ref: 'e', type: 'text', id: 'login-email' }),
    F({ ref: 'p', type: 'password' }),
  ]);
  assert.equal(r.username, 'e');
});

test('a password-only step is allowed (username may be null)', () => {
  const r = choose([F({ ref: 'p', type: 'password', autocomplete: 'current-password' })]);
  assert.equal(r.password, 'p');
  assert.equal(r.username, null);
});

test('a missing submit is allowed (caller can press Enter, and submit is gated anyway)', () => {
  const r = choose([
    F({ ref: 'u', type: 'text', name: 'username' }),
    F({ ref: 'p', type: 'password' }),
  ]);
  assert.equal(r.submit, null);
});

test('submit detected by button text when there is no type=submit', () => {
  const r = choose([
    F({ ref: 'u', type: 'text', name: 'username' }),
    F({ ref: 'p', type: 'password' }),
    F({ ref: 'b', tag: 'button', type: 'button', text: '로그인' }),
  ]);
  assert.equal(r.submit, 'b');
});

test('non-array input is refused', () => {
  assert.throws(() => choose(null));
});
