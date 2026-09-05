// The local site->task memory. Pure logic + a local file; no browser, no network, no LLM.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { load, save, remember, recall, emptyMemory, MAX_ENTRIES } = require('../sitememory.js');

test('remember then recall returns the origin for that task', () => {
  let m = emptyMemory();
  m = remember(m, { tag: 'email', origin: 'mail.example.com', ts: '2026-09-05T00:00:00Z' });
  const r = recall(m, 'email');
  assert.equal(r.length, 1);
  assert.equal(r[0].origin, 'mail.example.com');
});

test('recall ranks the more-used site first', () => {
  let m = emptyMemory();
  m = remember(m, { tag: 'chat', origin: 'a.com', ts: 't1' });
  m = remember(m, { tag: 'chat', origin: 'b.com', ts: 't2' });
  m = remember(m, { tag: 'chat', origin: 'b.com', ts: 't3' });   // b used twice
  assert.equal(recall(m, 'chat')[0].origin, 'b.com');
});

test('recall on an unknown tag is empty — never a wrong guess', () => {
  const m = remember(emptyMemory(), { tag: 'email', origin: 'x.com', ts: 't' });
  assert.deepEqual(recall(m, 'banking'), []);
});

test('remember requires tag and origin', () => {
  assert.throws(() => remember(emptyMemory(), { tag: 'x' }));
  assert.throws(() => remember(emptyMemory(), { origin: 'y.com' }));
});

test('a missing memory file loads as empty', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wbmem-')), 'mem.json');
  assert.deepEqual(load(f), emptyMemory());
});

test('a corrupt memory file loads as empty, not a crash', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wbmem-')), 'mem.json');
  fs.writeFileSync(f, 'not json {{{');
  assert.deepEqual(load(f), emptyMemory());
});

test('save then load round-trips', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wbmem-')), 'mem.json');
  const m = remember(emptyMemory(), { tag: 'docs', origin: 'notion.so', ts: 't' });
  save(f, m);
  assert.equal(recall(load(f), 'docs')[0].origin, 'notion.so');
});

test('the memory file is owner-only (0600)', () => {
  if (process.platform === 'win32') return;
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wbmem-')), 'mem.json');
  save(f, emptyMemory());
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('entries are capped (LRU eviction beyond the max)', () => {
  let m = emptyMemory();
  for (let i = 0; i < MAX_ENTRIES + 20; i++) {
    m = remember(m, { tag: `t${i}`, origin: `s${i}.com`, ts: String(i).padStart(6, '0') });
  }
  assert.ok(Object.keys(m.sites).length <= MAX_ENTRIES, 'the memory grew past its cap');
  // The oldest (t0) should have been evicted; a recent one should survive.
  assert.equal(recall(m, 't0').length, 0);
  assert.equal(recall(m, `t${MAX_ENTRIES + 19}`).length, 1);
});
