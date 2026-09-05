// The credential vault's crypto core. These properties are the whole security argument, so
// they are tested directly. Runs without a browser, network, or install — `node --test`.

const { test } = require('node:test');
const assert = require('node:assert');

const { encrypt, decrypt } = require('../vault.js');

const SECRET = 'hunter2-🔒-correct horse battery staple';
const PASS = 'a strong master passphrase';

test('round-trips a secret with the right passphrase', () => {
  const env = encrypt(SECRET, PASS);
  assert.equal(decrypt(env, PASS), SECRET);
});

test('a wrong passphrase fails to decrypt — it does not return garbage', () => {
  const env = encrypt(SECRET, PASS);
  // 🔴 GCM auth: a wrong key throws, never silently yields a different (attacker-influenced)
  //    plaintext. The caller relies on this to STOP rather than type a wrong secret.
  assert.throws(() => decrypt(env, 'the wrong passphrase'));
});

test('a tampered ciphertext fails (GCM auth tag)', () => {
  const env = encrypt(SECRET, PASS);
  const bytes = Buffer.from(env.ciphertext, 'base64');
  bytes[0] ^= 0xff;                         // flip one bit
  const tampered = { ...env, ciphertext: bytes.toString('base64') };
  assert.throws(() => decrypt(tampered, PASS));
});

test('a tampered auth tag fails', () => {
  const env = encrypt(SECRET, PASS);
  const tag = Buffer.from(env.tag, 'base64');
  tag[0] ^= 0xff;
  assert.throws(() => decrypt({ ...env, tag: tag.toString('base64') }, PASS));
});

test('the plaintext never appears in the envelope bytes', () => {
  const env = encrypt(SECRET, PASS);
  const blob = JSON.stringify(env);
  // The secret, and any 8-char run of it, must not be recoverable from the stored form.
  assert.ok(!blob.includes(SECRET), 'the full secret leaked into the envelope');
  assert.ok(!blob.includes('battery staple'), 'a fragment of the secret leaked');
});

test('two encryptions of the same secret differ (fresh salt + iv)', () => {
  const a = encrypt(SECRET, PASS);
  const b = encrypt(SECRET, PASS);
  // Deterministic ciphertext would leak that two sites share a password. Salt+IV are random.
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
});

test('an empty passphrase is refused', () => {
  assert.throws(() => encrypt(SECRET, ''));
});

test('a non-string plaintext is refused', () => {
  assert.throws(() => encrypt({ user: 'x', pass: 'y' }, PASS));
});
