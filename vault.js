// vault.js — encrypt/decrypt the credential store. The ONE place secrets are turned into
// bytes and back. Everything here is pure crypto over buffers/strings; no filesystem, no
// network, no CDP — so it is fully unit-testable and easy to reason about.
//
// 🔴 Security contract (see docs/DESIGN-credential-vault.md):
//   • At rest the store is AES-256-GCM; the key is scrypt-derived from a master passphrase.
//   • GCM's auth tag means a tampered file (or a wrong passphrase) FAILS to decrypt — it does
//     not silently return garbage. Callers must treat a throw as "do not proceed".
//   • This module never logs, never prints, and never returns a secret except as the direct
//     return value of decrypt() to its immediate caller (the engine). The AI driving wb is
//     not that caller.
//
// The on-disk shape is a JSON envelope:
//   { v:1, salt, iv, tag, ciphertext }   (all base64)
// The decrypted plaintext is whatever string the caller passed to encrypt() — the engine
// stores a JSON payload there, but this module does not care about its shape.

const crypto = require('crypto');

const VERSION = 1;
// scrypt is memory-hard; these are the Node defaults' safe upper range. N=2^15 keeps enroll/
// unlock well under a second on a laptop while costing an attacker real memory per guess.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 };
const SALT_LEN = 16;
const IV_LEN = 12;            // 96-bit nonce, the GCM standard

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('vault: a non-empty passphrase is required');
  }
  return crypto.scryptSync(passphrase, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    // scrypt refuses to run if it would need more memory than maxmem; N=32768 needs ~32MB,
    // so lift the ceiling above Node's 32MB default to leave headroom.
    maxmem: 128 * 1024 * 1024,
  });
}

// encrypt(plaintext:string, passphrase:string) -> envelope object (JSON-serialisable).
function encrypt(plaintext, passphrase) {
  if (typeof plaintext !== 'string') throw new Error('vault: plaintext must be a string');
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: VERSION,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

// decrypt(envelope, passphrase:string) -> plaintext:string.
// 🔴 Throws on a wrong passphrase OR any tampering (GCM auth failure). A throw means the
//    caller must stop — never fall back to a default or an empty credential.
function decrypt(envelope, passphrase) {
  if (!envelope || typeof envelope !== 'object') throw new Error('vault: not a vault envelope');
  if (envelope.v !== VERSION) throw new Error(`vault: unsupported version ${envelope.v}`);
  for (const f of ['salt', 'iv', 'tag', 'ciphertext']) {
    if (typeof envelope[f] !== 'string') throw new Error(`vault: envelope missing ${f}`);
  }
  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // .final() is where GCM verifies the tag: a wrong key or altered bytes throw here.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------- file + payload helpers
//
// A vault file is the JSON envelope on disk. The decrypted payload is a JSON object:
//   { sites: { "<origin>": { username, password, submitPolicy } } }
// These helpers keep the shape in one place; the engine holds the derived key and calls them.
// 🔴 loadPayload/savePayload move the CLEARTEXT payload only inside the engine — never to the
//    CLI/model. They still never log.

const fs = require('fs');

function readVaultFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const env = JSON.parse(raw);
  if (!env || env.v !== VERSION) throw new Error('vault: file is not a v1 vault');
  return env;
}

function writeVaultFile(file, envelope) {
  // 0600 — owner read/write only. A credential store must not be world/group readable.
  fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on filesystems without modes */ }
}

// Decrypt a vault file into its payload object. Returns an empty payload if the file does not
// exist yet (first enroll). Throws on a wrong passphrase / tampering (never returns garbage).
function loadPayload(file, passphrase) {
  let env;
  try {
    env = readVaultFile(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { sites: {} };
    throw e;
  }
  const json = decrypt(env, passphrase);
  const payload = JSON.parse(json);
  if (!payload || typeof payload !== 'object' || typeof payload.sites !== 'object') {
    throw new Error('vault: decrypted payload has the wrong shape');
  }
  return payload;
}

function savePayload(file, payload, passphrase) {
  if (!payload || typeof payload.sites !== 'object') {
    throw new Error('vault: payload must be { sites: {...} }');
  }
  writeVaultFile(file, encrypt(JSON.stringify(payload), passphrase));
}

module.exports = {
  encrypt, decrypt, VERSION,
  readVaultFile, writeVaultFile, loadPayload, savePayload,
};
