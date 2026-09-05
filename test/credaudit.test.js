// The credential audit log. The properties tested here are what make the log safe to read:
// it records which account/site/action without ever storing the secret, and one event is one
// line. No browser, no network.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { formatLine, append, maskUser } = require('../credaudit.js');

test('an autologin line records site, action, field and time — not the value', () => {
  const line = formatLine({
    ts: '2026-09-05T00:00:00Z', action: 'autologin', origin: 'example.com',
    user: 'alice@example.com', field: 'password',
  });
  assert.match(line, /autologin/);
  assert.match(line, /example\.com/);
  assert.match(line, /field=password/);
  assert.ok(!line.includes('alice@example.com'), 'the full username leaked into the log');
});

test('maskUser keeps the shape, not the identifier', () => {
  assert.equal(maskUser('alice@example.com'), 'a***@example.com');
  assert.equal(maskUser('bob'), 'b***(3)');
  assert.equal(maskUser(''), '(none)');
});

test('a secret accidentally passed as a note cannot span lines', () => {
  // Defence in depth: even a mistaken multi-line value collapses to one line.
  const line = formatLine({ ts: 't', action: 'x', origin: 'o', note: 'a\nb\nc' });
  assert.ok(!line.includes('\n'), 'a newline survived into the audit line');
});

test('append writes exactly one line per event', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wbaudit-')), 'audit.log');
  append(file, { ts: 't1', action: 'enroll', origin: 'a.com', user: 'u1' });
  append(file, { ts: 't2', action: 'autologin', origin: 'a.com', field: 'password' });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /enroll\ta\.com/);
  assert.match(lines[1], /autologin\ta\.com\tfield=password/);
});

test('the audit file is owner-only (0600)', () => {
  if (process.platform === 'win32') return;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wbaudit-')), 'audit.log');
  append(file, { ts: 't', action: 'enroll', origin: 'a.com' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('append is additive — earlier lines are never rewritten', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wbaudit-')), 'audit.log');
  append(file, { ts: 't1', action: 'enroll', origin: 'a.com' });
  const first = fs.readFileSync(file, 'utf8');
  append(file, { ts: 't2', action: 'autologin', origin: 'a.com' });
  const both = fs.readFileSync(file, 'utf8');
  assert.ok(both.startsWith(first), 'appending changed the earlier content');
});
