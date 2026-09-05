// The credential vault's crypto core. These properties are the whole security argument, so
// they are tested directly. Runs without a browser, network, or install — `node --test`.

const { test } = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { encrypt, decrypt, loadPayload, savePayload } = require('../vault.js');

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

// ---------------------------------------------------------------- file + payload layer

function tmpVault() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wbvault-')), 'creds.enc');
}

test('a missing vault file loads as an empty payload (first enroll)', () => {
  const payload = loadPayload(tmpVault(), PASS);
  assert.deepEqual(payload, { sites: {} });
});

test('a payload round-trips through disk', () => {
  const file = tmpVault();
  const payload = { sites: { 'example.com': { username: 'me', password: SECRET, submitPolicy: 'confirm' } } };
  savePayload(file, payload, PASS);
  assert.deepEqual(loadPayload(file, PASS), payload);
});

test('the wrong passphrase cannot load a saved payload', () => {
  const file = tmpVault();
  savePayload(file, { sites: { a: { username: 'x', password: 'y' } } }, PASS);
  assert.throws(() => loadPayload(file, 'wrong'));
});

test('the secret is not present in the file bytes on disk', () => {
  const file = tmpVault();
  savePayload(file, { sites: { s: { username: 'u', password: SECRET } } }, PASS);
  const bytes = fs.readFileSync(file, 'utf8');
  assert.ok(!bytes.includes(SECRET), 'secret leaked to disk in the clear');
  assert.ok(!bytes.includes('battery staple'), 'secret fragment leaked to disk');
});

test('the vault file is written owner-only (0600)', () => {
  if (process.platform === 'win32') return;   // POSIX modes only
  const file = tmpVault();
  savePayload(file, { sites: {} }, PASS);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});
